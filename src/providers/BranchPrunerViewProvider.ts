import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { GitCommandError } from '../services/GitRunner';
import { RepositoryWatcher } from '../services/RepositoryWatcher';
import { Branch, DeleteResult, RemoteProgress, parseWebviewMessage } from '../types';
import { getDeleteConfirmation } from '../views/deleteConfirmation';
import { getErrorContent, getBranchListBody, getBranchListContent, getLoadingContent } from '../views/webview';

const LOCAL_READ_TIMEOUT_MS = 15_000;

class LocalReadTimeoutError extends Error {
  constructor() {
    super('Local Git state read timed out');
    this.name = 'LocalReadTimeoutError';
  }
}

export class BranchPrunerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private watcher?: RepositoryWatcher;
  private directory?: string;
  private branches: Branch[] = [];
  private results: DeleteResult[] = [];
  private notice = '';
  private remoteNotice = '';
  private watcherNotice = '';
  private readNotice = '';
  private hasList = false;
  private ready = false;
  private busy = false;
  private refreshingLocal = false;
  private dirty = false;
  private reading?: Promise<void>;
  private fetchController?: AbortController;
  private remoteProgress?: RemoteProgress;
  private localReadController?: AbortController;
  private logOutput?: vscode.OutputChannel;
  private generation = 0;
  private readonly chinese = vscode.env.language.toLowerCase().startsWith('zh');

  constructor(private readonly extensionUri: vscode.Uri, private readonly gitService = new GitService()) {}
  private t(cn: string, en: string): string { return this.chinese ? cn : en; }

  private log(message: string, generation = this.generation): void {
    if (!this.view || generation !== this.generation) return;
    if (!this.logOutput) this.logOutput = vscode.window.createOutputChannel('Git Branch Pruner');
    this.logOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  public dispose(): void {
    this.generation++;
    this.fetchController?.abort();
    this.remoteProgress = undefined;
    this.localReadController?.abort();
    this.watcher?.dispose();
    this.watcher = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.view = undefined;
    this.logOutput?.dispose();
    this.logOutput = undefined;
    this.directory = undefined;
    this.ready = false;
    this.hasList = false;
    this.busy = false;
    this.refreshingLocal = false;
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.dispose();
    this.view = view;
    const generation = this.generation;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = getLoadingContent(this.t('正在读取本地分支…', 'Reading local branches…'), this.chinese);
    this.subscriptions.push(
      view.webview.onDidReceiveMessage(async (data: unknown) => {
        if (generation !== this.generation) return;
        const message = parseWebviewMessage(data);
        if (!message) return;
        if (message.type === 'ready') { this.ready = true; this.render(); return; }
        if (message.type === 'cancelFetch') { this.cancelRemote(); return; }
        if (message.type === 'refresh') { await this.requestRefresh(); this.render(); return; }
        if (this.busy) return;
        this.busy = true;
        this.render();
        try {
          if (message.type === 'fetch') await this.updateRemote();
          else if (message.type === 'switch') await this.switchBranch(message.branch);
          else if (message.type === 'confirmDelete') await this.confirmAndDeleteBranches(message.branches, message.force);
        } catch {
          if (generation !== this.generation) return;
          this.notice = this.t('操作失败，请刷新本地状态后重试。', 'Operation failed. Refresh local state and retry.');
        } finally {
          if (generation !== this.generation) return;
          this.refreshingLocal = true;
          this.render();
          try {
            await this.requestRefresh();
          } finally {
            if (generation === this.generation) {
              this.refreshingLocal = false;
              this.busy = false;
              this.render();
            }
          }
        }
      }),
      view.onDidDispose(() => this.dispose()),
      view.onDidChangeVisibility(() => { if (view.visible) void this.requestRefresh(); }),
      vscode.window.onDidChangeWindowState((state) => { if (state.focused) void this.requestRefresh(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.requestRefresh(); })
    );
    await this.requestRefresh();
  }

  /** Coalesce bursts and perform one more read if refs changed during an in-flight query. */
  private requestRefresh(): Promise<void> {
    if (!this.view) return Promise.resolve();
    this.dirty = true;
    if (this.reading) return this.reading;
    this.reading = (async () => {
      while (this.dirty && this.view) {
        this.dirty = false;
        await this.readLocal();
      }
    })().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async readLocal(): Promise<void> {
    const generation = this.generation;
    const log = (message: string) => this.log(message, generation);
    const controller = new AbortController();
    this.localReadController = controller;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LocalReadTimeoutError());
      }, LOCAL_READ_TIMEOUT_MS);
    });
    log(`local-read:start platform=${process.platform} initial=${!this.hasList}`);
    try {
      await Promise.race([this.readLocalAttempt(generation, controller.signal), timeout]);
      log(`local-read:success elapsedMs=${Date.now() - started}`);
    } catch (error) {
      const timedOut = error instanceof LocalReadTimeoutError ||
        (error instanceof GitCommandError && error.reason === 'timeout');
      if (timedOut) log(`local-read:timeout elapsedMs=${Date.now() - started}`);
      else if (error instanceof GitCommandError) log(`local-read:git-error code=${String(error.code)} reason=${error.reason}`);
      else log(`local-read:error type=${error instanceof Error ? error.name : 'unknown'}`);
      if (generation !== this.generation || !this.view) return;
      if (this.hasList) {
        this.readNotice = timedOut
          ? this.t('本地状态读取超时，保留上次结果；请重试。', 'Local state read timed out; showing previous results. Please retry.')
          : this.t('本地读取失败，保留上次结果；请重试。', 'Local refresh failed; showing previous results. Please retry.');
        this.render();
      } else {
        this.directory = undefined;
        this.watcher?.dispose();
        this.watcher = undefined;
        const message = timedOut
          ? this.t('读取本地 Git 状态超时，请重试。', 'Reading local Git state timed out. Please retry.')
          : error instanceof GitCommandError
            ? this.t('读取 Git 状态失败，请重试。', 'Failed to read Git state. Please retry.')
            : error instanceof Error ? error.message : this.t('读取失败。', 'Read failed.');
        this.view.webview.html = getErrorContent(message, this.chinese);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.localReadController === controller) this.localReadController = undefined;
    }
  }

  private async readLocalAttempt(generation: number, signal: AbortSignal): Promise<void> {
    const log = (message: string) => this.log(message, generation);
    const checkCancelled = () => {
      if (signal.aborted) throw new LocalReadTimeoutError();
    };
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (cwd !== this.directory || !cwd) {
      this.watcher?.dispose();
      this.watcher = undefined;
      this.hasList = false;
      this.ready = false;
      this.results = [];
      this.branches = [];
      this.directory = undefined;
      this.readNotice = '';
      this.notice = '';
      this.remoteNotice = '';
      this.watcherNotice = '';
      this.fetchController?.abort();
      this.remoteProgress = undefined;
      if (!cwd) throw new Error(this.t('请先打开一个 Git 项目文件夹。', 'Open a Git project folder first.'));
      checkCancelled();
      log('local-read:phase=repository-check:start');
      if (!(await this.gitService.isGitRepository(cwd, { signal }))) {
        throw new Error(this.t('未找到 Git 工作仓库，请检查文件夹与 Git 安装。', 'No Git working repository found. Check the folder and Git installation.'));
      }
      log('local-read:phase=repository-check:done');
      checkCancelled();
      log('local-read:phase=git-directories:start');
      const directories = await this.gitService.getGitDirectories(cwd, { signal });
      log('local-read:phase=git-directories:done');
      if (generation !== this.generation) return;
      checkCancelled();
      this.directory = cwd;
      const watcher = new RepositoryWatcher(directories, () => { void this.requestRefresh(); }, () => {
        if (generation !== this.generation || !this.view) return;
        log('watcher:error');
        this.watcherNotice = this.t('自动监听不可用，可点击“刷新本地”。', 'Automatic watching is unavailable; use Refresh local.');
        this.render();
      });
      log('local-read:phase=watcher-start:start');
      try {
        await watcher.start(signal);
        checkCancelled();
        this.watcher = watcher;
        log('local-read:phase=watcher-start:done');
      } catch {
        watcher.dispose();
        if (signal.aborted) throw new LocalReadTimeoutError();
        log('watcher:start-error');
        this.watcherNotice = this.t('自动监听不可用，可点击“刷新本地”。', 'Automatic watching is unavailable; use Refresh local.');
      }
    }
    checkCancelled();
    log('local-read:phase=branches:start');
    const branches = await this.gitService.getBranches(cwd, { signal });
    log(`local-read:phase=branches:done count=${branches.length}`);
    if (generation !== this.generation) return;
    checkCancelled();
    this.branches = branches;
    this.readNotice = '';
    this.render();
  }

  private render(): void {
    if (!this.view || !this.directory) return;
    const notice = [this.remoteNotice, this.notice, this.readNotice, this.watcherNotice].filter(Boolean).join(' ');
    if (!this.hasList) {
      this.hasList = true;
      this.ready = false;
      this.view.webview.html = getBranchListContent(this.branches, this.chinese, this.results, notice, this.directory, this.remoteProgress, this.refreshingLocal);
    } else if (this.ready) {
      void this.view.webview.postMessage({
        type: 'updateBranches', repository: this.directory, busy: this.busy,
        content: getBranchListBody(this.branches, this.chinese, this.results, notice, this.remoteProgress, this.refreshingLocal),
      });
    }
  }

  private cancelRemote(): void {
    if (!this.fetchController || this.fetchController.signal.aborted) return;
    if (this.remoteProgress) this.remoteProgress.cancelling = true;
    this.fetchController.abort();
    this.render();
  }

  private async updateRemote(): Promise<void> {
    const cwd = this.directory;
    if (!cwd) return;
    const generation = this.generation;
    const started = Date.now();
    this.log('remote-update:start');
    const controller = new AbortController();
    this.fetchController = controller;
    this.remoteProgress = { startedAt: started, cancelling: false };
    this.remoteNotice = '';
    this.render();
    try {
      await this.gitService.fetchRemote(cwd, controller.signal);
      if (generation !== this.generation || this.directory !== cwd) return;
      this.remoteNotice = this.t('本次会话上次手动 fetch 完成：', 'Last manual fetch completed in this session: ') +
        new Date().toLocaleString(this.chinese ? 'zh-CN' : 'en-US') +
        this.t('。获取范围遵循 Git 配置，列表仍基于本地引用。', '. Fetch scope follows Git configuration; the list still uses local refs.');
      this.log(`remote-update:success elapsedMs=${Date.now() - started}`);
    } catch (error) {
      if (generation !== this.generation || this.directory !== cwd) return;
      const reason = error instanceof GitCommandError ? error.reason : 'failed';
      this.log(`remote-update:error reason=${reason} elapsedMs=${Date.now() - started}`);
      this.remoteNotice = reason === 'cancelled'
        ? this.t('远端更新已取消。', 'Remote update cancelled.')
        : reason === 'timeout'
          ? this.t('远端更新超时。', 'Remote update timed out.')
          : this.t('远端更新失败，请检查网络、Git 代理或认证。', 'Remote update failed. Check connectivity, Git proxy or authentication.');
      this.remoteNotice += this.t(' 显示本地引用；部分引用可能已更新，不能确认所有远端状态。',
        ' Showing local refs; some may have updated. Not all remote states could be confirmed.');
    } finally {
      if (this.fetchController === controller) {
        this.fetchController = undefined;
        this.remoteProgress = undefined;
      }
      if (generation === this.generation && this.view) this.log('remote-update:end');
    }
  }

  private async switchBranch(name: string): Promise<void> {
    const cwd = this.directory;
    if (!cwd) return;
    try { await this.gitService.switchBranch(cwd, name); }
    catch {
      this.notice = this.t('切换失败：请检查未提交改动或工作树占用。未强制切换。', 'Switch failed: check uncommitted changes or worktree usage. No forced checkout was performed.');
    }
  }

  private async confirmAndDeleteBranches(branchNames: string[], force: boolean): Promise<void> {
    const cwd = this.directory;
    if (!cwd) return;
    const { title, detail, button } = getDeleteConfirmation(cwd, branchNames, force, this.chinese);
    const confirmed = await vscode.window.showWarningMessage(title, {
      modal: true,
      detail,
    }, button);
    if (confirmed !== button) return;
    const results = await this.gitService.deleteBranches(cwd, branchNames, force);
    if (this.directory === cwd) this.results = results;
    const deleted = results.filter((result) => result.status === 'deleted').length;
    const summary = this.t(`已删除 ${deleted} 个分支，${results.length - deleted} 个未删除。`, `Deleted ${deleted} branches; ${results.length - deleted} not deleted.`);
    if (deleted < results.length) void vscode.window.showWarningMessage(summary);
    else void vscode.window.showInformationMessage(summary);
  }
}

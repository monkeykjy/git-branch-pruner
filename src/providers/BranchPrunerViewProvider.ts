import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { GitCommandError } from '../services/GitRunner';
import { RepositoryWatcher } from '../services/RepositoryWatcher';
import { Branch, DeleteResult, parseWebviewMessage } from '../types';
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
  private watcherNotice = '';
  private readNotice = '';
  private hasList = false;
  private ready = false;
  private busy = false;
  private dirty = false;
  private reading?: Promise<void>;
  private fetchController?: AbortController;
  private localReadController?: AbortController;
  private logOutput?: vscode.OutputChannel;
  private generation = 0;
  private readonly chinese = vscode.env.language.toLowerCase().startsWith('zh');

  constructor(private readonly extensionUri: vscode.Uri, private readonly gitService = new GitService()) {}
  private t(cn: string, en: string): string { return this.chinese ? cn : en; }

  private log(message: string): void {
    if (!this.logOutput) this.logOutput = vscode.window.createOutputChannel('Git Branch Pruner');
    this.logOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  public dispose(): void {
    this.generation++;
    this.fetchController?.abort();
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
          this.busy = false;
          await this.requestRefresh();
          this.render();
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
    this.log(`local-read:start platform=${process.platform} initial=${!this.hasList}`);
    try {
      await Promise.race([this.readLocalAttempt(generation, controller.signal), timeout]);
      this.log(`local-read:success elapsedMs=${Date.now() - started}`);
    } catch (error) {
      const timedOut = error instanceof LocalReadTimeoutError ||
        (error instanceof GitCommandError && error.reason === 'timeout');
      if (timedOut) this.log(`local-read:timeout elapsedMs=${Date.now() - started}`);
      else if (error instanceof GitCommandError) this.log(`local-read:git-error code=${String(error.code)} reason=${error.reason}`);
      else this.log(`local-read:error type=${error instanceof Error ? error.name : 'unknown'}`);
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
      this.watcherNotice = '';
      this.fetchController?.abort();
      if (!cwd) throw new Error(this.t('请先打开一个 Git 项目文件夹。', 'Open a Git project folder first.'));
      checkCancelled();
      this.log('local-read:phase=repository-check:start');
      if (!(await this.gitService.isGitRepository(cwd, { signal }))) {
        throw new Error(this.t('未找到 Git 工作仓库，请检查文件夹与 Git 安装。', 'No Git working repository found. Check the folder and Git installation.'));
      }
      this.log('local-read:phase=repository-check:done');
      checkCancelled();
      this.log('local-read:phase=git-directories:start');
      const directories = await this.gitService.getGitDirectories(cwd, { signal });
      this.log('local-read:phase=git-directories:done');
      if (generation !== this.generation) return;
      checkCancelled();
      this.directory = cwd;
      const watcher = new RepositoryWatcher(directories, () => { void this.requestRefresh(); }, () => {
        this.log('watcher:error');
        this.watcherNotice = this.t('自动监听不可用，可点击“刷新本地”。', 'Automatic watching is unavailable; use Refresh local.');
        this.render();
      });
      this.log('local-read:phase=watcher-start:start');
      try {
        await watcher.start(signal);
        checkCancelled();
        this.watcher = watcher;
        this.log('local-read:phase=watcher-start:done');
      } catch {
        watcher.dispose();
        if (signal.aborted) throw new LocalReadTimeoutError();
        this.log('watcher:start-error');
        this.watcherNotice = this.t('自动监听不可用，可点击“刷新本地”。', 'Automatic watching is unavailable; use Refresh local.');
      }
    }
    checkCancelled();
    this.log('local-read:phase=branches:start');
    const branches = await this.gitService.getBranches(cwd, { signal });
    this.log(`local-read:phase=branches:done count=${branches.length}`);
    if (generation !== this.generation) return;
    checkCancelled();
    this.branches = branches;
    this.readNotice = '';
    this.render();
  }

  private render(): void {
    if (!this.view || !this.directory) return;
    const notice = [this.notice, this.readNotice, this.watcherNotice].filter(Boolean).join(' ');
    if (!this.hasList) {
      this.hasList = true;
      this.ready = false;
      this.view.webview.html = getBranchListContent(this.branches, this.chinese, this.results, notice, this.directory);
    } else if (this.ready) {
      void this.view.webview.postMessage({
        type: 'updateBranches', repository: this.directory, busy: this.busy,
        content: getBranchListBody(this.branches, this.chinese, this.results, notice),
      });
    }
  }

  private async updateRemote(): Promise<void> {
    const cwd = this.directory;
    if (!cwd) return;
    const started = Date.now();
    this.log('remote-update:start');
    const controller = new AbortController();
    this.fetchController = controller;
    this.notice = this.t('正在更新远端状态，当前显示本地缓存…', 'Updating remote status; showing locally cached refs…');
    this.render();
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: this.t('更新远端状态', 'Update remote status'), cancellable: true,
      }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { await this.gitService.fetchRemote(cwd, controller.signal); } finally { subscription.dispose(); }
      });
      if (this.directory === cwd) this.notice = this.t('上次手动更新远端成功：', 'Last successful manual remote update: ') + new Date().toLocaleTimeString();
      this.log(`remote-update:success elapsedMs=${Date.now() - started}`);
    } catch (error) {
      if (this.directory !== cwd) return;
      const reason = error instanceof GitCommandError ? error.reason : 'failed';
      this.log(`remote-update:error reason=${reason} elapsedMs=${Date.now() - started}`);
      this.notice = reason === 'cancelled'
        ? this.t('远端更新已取消，显示已获取的本地引用。', 'Remote update cancelled; showing locally available refs.')
        : reason === 'timeout'
          ? this.t('远端更新超时，显示本地缓存。', 'Remote update timed out; showing cached refs.')
          : this.t('远端更新失败，显示本地缓存；请检查网络、Git 代理或认证。', 'Remote update failed; showing cached refs. Check connectivity, Git proxy or authentication.');
    } finally {
      if (this.fetchController === controller) this.fetchController = undefined;
      this.log('remote-update:end');
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
    const button = force ? this.t('强制删除分支', 'Force delete branches') : this.t('删除分支', 'Delete branches');
    const title = force
      ? this.t(`强制删除这 ${branchNames.length} 个本地分支？`, `Force delete these ${branchNames.length} local branches?`)
      : this.t(`删除这 ${branchNames.length} 个本地分支？`, `Delete these ${branchNames.length} local branches?`);
    const explanation = force
      ? this.t('将跳过未合并检查，可能丢失指向未合并提交的分支引用。受保护分支仍会保留。', 'This skips the merge check and may remove branch references to unmerged commits. Protected branches are still kept.')
      : this.t('尚未合并的分支会保留。Git 根据上游或 HEAD 检查合并状态，不代表已合并到主分支。', 'Unmerged branches are kept. Git checks against upstream or HEAD, which does not necessarily mean merged into the default branch.');
    const confirmed = await vscode.window.showWarningMessage(title, {
      modal: true,
      detail: `${cwd}\n\n${branchNames.join('\n')}\n\n${explanation}\n\n${this.t('只删除本地分支，不删除远程分支。', 'Only local branches are deleted. Remote branches are unaffected.')}`,
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

import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { getErrorContent, getBranchListContent, getLoadingContent } from '../views/webview';

/**
 * Git分支管理器的WebView提供者
 * 负责管理分支列表的显示、刷新和删除操作
 */
export class BranchPrunerViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private gitService: GitService;
  private isOperationInProgress = false;
  private readonly currentLanguage: string;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this.gitService = new GitService();
    this.currentLanguage = vscode.env.language;
  }

  /**
   * 检查当前是否为中文环境
   * 支持简体中文和繁体中文
   */
  private isChineseLanguage(): boolean {
    return this.currentLanguage.toLowerCase().startsWith('zh');
  }

  /**
   * 获取本地化的消息文本
   * 根据当前语言环境返回对应的中文或英文消息
   */
  private getLocalizedMessages() {
    return this.isChineseLanguage()
      ? {
          checking: '正在检查 Git 环境...',
          refreshing: '正在刷新分支信息...',
          deleting: (count: number) => `正在删除 ${count} 个分支...`,
          gitNotInstalled: 'Git 未安装或无法在 PATH 中找到。请安装 Git 后重试。',
          notGitRepo: '当前工作区不是 Git 仓库。请打开一个 Git 仓库后重试。',
          failedToCheck: '检查 Git 环境失败。请重试。',
          failedToRefresh: '刷新分支失败。请重试。',
          failedToDelete: '删除分支失败。请重试。',
          deleteConfirmSingle: '确定要删除以下分支吗？',
          deleteConfirmMultiple: (total: number) => `确定要删除以下 ${total} 个分支吗？`,
          deleteDetail: '此操作只会删除本地分支，不会影响远程分支。',
          deleteButton: '删除分支',
          cancelButton: '取消',
          andMore: (count: number) => `...以及另外 ${count} 个`,
        }
      : {
          checking: 'Checking Git environment...',
          refreshing: 'Refreshing branch information...',
          deleting: (count: number) => `Deleting ${count} branch(es)...`,
          gitNotInstalled: 'Git is not installed or not available in PATH. Please install Git and try again.',
          notGitRepo: 'Current workspace is not a Git repository. Please open a Git repository and try again.',
          failedToCheck: 'Failed to check Git environment. Please try again.',
          failedToRefresh: 'Failed to refresh branches. Please try again.',
          failedToDelete: 'Failed to delete branches. Please try again.',
          deleteConfirmSingle: 'Are you sure you want to delete the following branch?',
          deleteConfirmMultiple: (total: number) => `Are you sure you want to delete the following ${total} branches?`,
          deleteDetail: 'This operation will only delete local branches. Remote branches will not be affected.',
          deleteButton: 'Delete Branches',
          cancelButton: 'Cancel',
          andMore: (count: number) => `...and ${count} more`,
        };
  }

  /**
   * 设置WebView界面控件的启用状态
   * @param enabled 是否启用控件
   */
  private async setControlsState(enabled: boolean) {
    if (this._view) {
      await this._view.webview.postMessage({
        type: 'setControlsState',
        enabled,
      });
    }
  }

  /**
   * 执行操作时禁用界面控件的包装器方法
   * 确保在操作执行期间禁用界面，防止重复操作
   * @param operation 要执行的异步操作
   */
  private async withControlsDisabled<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isOperationInProgress) {
      return Promise.reject(new Error('Operation already in progress'));
    }

    try {
      this.isOperationInProgress = true;
      await this.setControlsState(false);
      const result = await operation();
      return result;
    } finally {
      this.isOperationInProgress = false;
      await this.setControlsState(true);
    }
  }

  /**
   * 初始化WebView视图
   * 设置WebView配置并注册消息处理程序
   */
  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // 注册WebView消息处理
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'refresh':
          await this.withControlsDisabled(() => this.refreshBranches());
          break;
        case 'confirmDelete':
          await this.withControlsDisabled(() => this.confirmAndDeleteBranches(data.branches));
          break;
      }
    });

    // 初始化时检查Git环境
    this._view.webview.html = getLoadingContent('Checking Git environment...', this.isChineseLanguage());
    await this.checkEnvironment();
  }

  /**
   * 检查Git环境
   * 验证Git安装状态和仓库有效性
   */
  private async checkEnvironment() {
    if (!this._view) {
      return;
    }

    const messages = this.getLocalizedMessages();
    const isChineseLanguage = this.isChineseLanguage();

    try {
      this._view.webview.html = getLoadingContent(messages.checking, isChineseLanguage);

      if (!(await this.gitService.checkGitInstallation())) {
        this._view.webview.html = getErrorContent(messages.gitNotInstalled, isChineseLanguage);
        return;
      }

      const workingDir = this.gitService.getWorkingDirectory();
      if (!workingDir || !(await this.gitService.isGitRepository(workingDir))) {
        this._view.webview.html = getErrorContent(messages.notGitRepo, isChineseLanguage);
        return;
      }

      // 环境检查通过后，直接执行刷新操作而不是显示就绪状态
      await this.refreshBranches();
    } catch (error) {
      this._view.webview.html = getErrorContent(messages.failedToCheck, isChineseLanguage);
    }
  }

  /**
   * 确认并删除选中的分支
   * @param branchNames 要删除的分支名称列表
   */
  private async confirmAndDeleteBranches(branchNames: string[]) {
    if (!this._view || !branchNames.length) {
      return;
    }

    const messages = this.getLocalizedMessages();
    const isChineseLanguage = this.isChineseLanguage();

    const confirmMessage = this.buildConfirmationMessage(branchNames);

    const result = await vscode.window.showWarningMessage(
      confirmMessage,
      {
        modal: true,
        detail: messages.deleteDetail,
      },
      messages.deleteButton // 只保留删除按钮作为确认选项
    );

    if (result === messages.deleteButton) {
      try {
        this._view.webview.html = getLoadingContent(messages.deleting(branchNames.length), isChineseLanguage);
        await this.gitService.deleteBranches(branchNames);
        await this.refreshBranches();
      } catch (error) {
        this._view.webview.html = getErrorContent(messages.failedToDelete, isChineseLanguage);
      }
    }
    // 移除了 else 分支中的刷新操作
  }

  /**
   * 构建删除确认消息
   * @param branchNames 要删除的分支名称列表
   */
  private buildConfirmationMessage(branchNames: string[]): string {
    const messages = this.getLocalizedMessages();
    const totalBranches = branchNames.length;

    if (totalBranches === 1) {
      return `${messages.deleteConfirmSingle}\n\n${branchNames[0]}\n\nThe following command will be executed:\ngit branch -D "${branchNames[0]}"`;
    }

    const branchList = branchNames
      .slice(0, 5)
      .map((name) => `• ${name}`)
      .join('\n');
    const remainingCount = totalBranches - 5;
    const additionalMessage = remainingCount > 0 ? `\n${messages.andMore(remainingCount)}` : '';

    return `${messages.deleteConfirmMultiple(
      totalBranches
    )}\n\n${branchList}${additionalMessage}\n\nThe following commands will be executed:\n${branchNames
      .map((name) => `git branch -D "${name}"`)
      .join('\n')}`;
  }

  /**
   * 刷新分支列表
   * 获取最新的分支信息并更新显示
   */
  private async refreshBranches() {
    if (!this._view) {
      return;
    }

    const messages = this.getLocalizedMessages();
    const isChineseLanguage = this.isChineseLanguage();

    try {
      this._view.webview.html = getLoadingContent(messages.refreshing, isChineseLanguage);
      const branches = await this.gitService.getBranches();
      this._view.webview.html = getBranchListContent(branches, isChineseLanguage);
    } catch (error) {
      this._view.webview.html = getErrorContent(messages.failedToRefresh, isChineseLanguage);
    }
  }
}

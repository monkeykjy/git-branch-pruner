import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Branch } from '../types';

const execAsync = promisify(exec);

/**
 * Git操作服务类
 * 处理所有与Git相关的命令行操作
 */
export class GitService {
  private outputChannel: vscode.OutputChannel;
  private readonly env: NodeJS.ProcessEnv;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Git Branch Pruner');

    // 配置环境变量
    this.env = {
      ...process.env,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      // Windows系统特殊配置
      ...(process.platform === 'win32'
        ? {
            FORCE_COLOR: '1',
            CHCP: '65001', // 设置命令提示符使用UTF-8编码
          }
        : {}),
    };
  }

  /**
   * 获取所有分支信息
   * 包括本地分支和远程分支的状态
   */
  public async getBranches(): Promise<Branch[]> {
    const workingDir = this.getWorkingDirectory();
    if (!workingDir) {
      return [];
    }

    if (!(await this.checkGitInstallation())) {
      return [];
    }
    if (!(await this.isGitRepository(workingDir))) {
      return [];
    }

    await this.fetchRemote(workingDir);
    return await this.getAllBranches(workingDir);
  }

  /**
   * 删除指定的本地分支
   * @param branchNames 要删除的分支名称列表
   */
  public async deleteBranches(branchNames: string[]): Promise<void> {
    const workingDir = this.getWorkingDirectory();
    if (!workingDir) {
      return;
    }

    for (const branch of branchNames) {
      try {
        await this.execGit(`git branch -D "${branch}"`, workingDir);
        vscode.window.showInformationMessage(`Deleted branch: ${branch}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete branch: ${branch}`);
      }
    }
  }

  public getWorkingDirectory(): string | undefined {
    // 获取当前 VS Code 打开的项目文件夹
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.outputChannel.appendLine('No workspace folder found');
      vscode.window.showErrorMessage('Please open a folder in VS Code first');
      return undefined;
    }

    const folderPath = workspaceFolder.uri.fsPath;
    this.outputChannel.appendLine(`Working directory: ${folderPath}`);
    return folderPath;
  }

  public async checkGitInstallation(): Promise<boolean> {
    try {
      await this.execGit('git --version');
      return true;
    } catch (error) {
      return false;
    }
  }

  public async isGitRepository(workingDir: string): Promise<boolean> {
    try {
      await this.execGit('git rev-parse --git-dir', workingDir);
      return true;
    } catch (error) {
      return false;
    }
  }

  private getExecOptions(cwd?: string): ExecOptions {
    const baseOptions: ExecOptions = {
      env: this.env,
      shell: process.platform === 'win32' ? 'bash.exe' : '/bin/sh',
      windowsHide: true,
    };

    if (cwd) {
      return { ...baseOptions, cwd };
    }

    return baseOptions;
  }

  private async execGit(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
    try {
      const options = this.getExecOptions(cwd);
      const result = await execAsync(command, options);
      return result;
    } catch (error) {
      // 如果使用 bash.exe 失败，尝试使用 cmd.exe
      if (process.platform === 'win32') {
        try {
          const fallbackOptions: ExecOptions = {
            ...this.getExecOptions(cwd),
            shell: 'cmd.exe',
          };
          const result = await execAsync(command, fallbackOptions);
          return result;
        } catch (fallbackError) {
          this.outputChannel.appendLine(
            `Git command failed (fallback): ${
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            }`
          );
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  private async fetchRemote(workingDir: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating branch information...',
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ message: 'Fetching from remote...' });
          this.outputChannel.appendLine('Fetching from remote...');

          const { stdout: fetchOutput, stderr: fetchError } = await this.execGit('git fetch --prune', workingDir);

          if (fetchError) {
            this.outputChannel.appendLine(`Fetch warning: ${fetchError}`);
          }
          if (fetchOutput) {
            this.outputChannel.appendLine(`Fetch output: ${fetchOutput}`);
          }

          progress.report({ message: 'Fetch completed', increment: 100 });
        } catch (error) {
          this.outputChannel.appendLine(`Fetch error: ${error}`);
          vscode.window.showWarningMessage('Failed to fetch from remote. Branch information might be outdated.');
        }
      }
    );
  }

  private async getCurrentBranch(workingDir: string): Promise<string> {
    try {
      const { stdout } = await this.execGit('git rev-parse --abbrev-ref HEAD', workingDir);
      return stdout.trim();
    } catch (error) {
      this.outputChannel.appendLine(`Error getting current branch: ${error}`);
      return '';
    }
  }

  private async getMainBranch(workingDir: string): Promise<string> {
    try {
      // 按照常见的主干分支名称顺序检查
      const commonMainBranches = ['main', 'master'];
      for (const branchName of commonMainBranches) {
        try {
          await this.execGit(`git rev-parse --verify ${branchName}`, workingDir);
          return branchName;
        } catch {
          continue;
        }
      }
      // 如果都没找到，返回空字符串
      return '';
    } catch (error) {
      this.outputChannel.appendLine(`Error getting main branch: ${error}`);
      return '';
    }
  }

  private async getAllBranches(workingDir: string): Promise<Branch[]> {
    try {
      const currentBranch = await this.getCurrentBranch(workingDir);
      const mainBranch = await this.getMainBranch(workingDir);

      // 获取本地分支
      const { stdout: localOutput } = await this.execGit('git branch --no-color', workingDir);

      // 获取远程分支
      const { stdout: remoteOutput } = await this.execGit('git branch -r --no-color', workingDir);

      // 处理本地分支
      const localBranches = localOutput
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b)
        .map((b) => b.replace('* ', ''));

      // 处理远程分支
      const remoteBranches = remoteOutput
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b)
        .map((b) => b.replace('origin/', ''));

      this.outputChannel.appendLine(
        `Found ${localBranches.length} local branches and ${remoteBranches.length} remote branches`
      );

      return localBranches.map((name) => ({
        name,
        isLocal: true,
        exists: {
          local: true,
          remote: remoteBranches.includes(name),
        },
        isCurrentBranch: name === currentBranch,
        isMainBranch: name === mainBranch,
      }));
    } catch (error) {
      this.outputChannel.appendLine(`Error getting branches: ${error}`);
      vscode.window.showErrorMessage('Failed to get Git branches');
      return [];
    }
  }
}

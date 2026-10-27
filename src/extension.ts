import * as vscode from 'vscode';
import { BranchPrunerViewProvider } from './providers/BranchPrunerViewProvider';
import { createGitPathResolver, GitExtensionApi } from './gitPath';
import { GitService } from './services/GitService';
import { ProcessGitRunner } from './services/GitRunner';

/**
 * 插件激活入口
 * 注册Git分支管理器的WebView提供者
 */
export function activate(context: vscode.ExtensionContext) {
  const resolveGitPath = createGitPathResolver(
    async () => vscode.extensions.getExtension<GitExtensionApi>('vscode.git')?.activate(),
    message => console.info(`[Git Branch Pruner] ${message}`)
  );
  const provider = new BranchPrunerViewProvider(context.extensionUri,
    new GitService(new ProcessGitRunner(process.env, resolveGitPath)));
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('branchPrunerView', provider));
}

export function deactivate() {}

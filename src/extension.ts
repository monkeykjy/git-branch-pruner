import * as vscode from 'vscode';
import { BranchPrunerViewProvider } from './providers/BranchPrunerViewProvider';

/**
 * 插件激活入口
 * 注册Git分支管理器的WebView提供者
 */
export function activate(context: vscode.ExtensionContext) {
  const provider = new BranchPrunerViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('branchPrunerView', provider));
}

export function deactivate() {}

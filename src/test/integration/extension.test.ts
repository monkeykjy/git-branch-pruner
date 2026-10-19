import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GitService } from '../../services/GitService';
import { ProcessGitRunner } from '../../services/GitRunner';
import { BranchPrunerViewProvider } from '../../providers/BranchPrunerViewProvider';

suite('Extension integration', () => {
  test('activates and exposes the branch manager', async () => {
    const extension = vscode.extensions.getExtension('monkeykjy.git-branch-pruner');
    assert.ok(extension);
    await extension.activate();
    assert.ok(extension.isActive);
  });

  test('renders a retry page without a workspace and ignores malformed messages', async () => {
    let receive: (value: unknown) => Promise<void> = async () => {};
    const webview = {
      html: '', options: {},
      postMessage: async () => true,
      onDidReceiveMessage: (callback: typeof receive) => {
        receive = callback;
        return new vscode.Disposable(() => {});
      },
    };
    const provider = new BranchPrunerViewProvider(vscode.Uri.file(__dirname));
    try {
      await provider.resolveWebviewView({ webview, onDidDispose: () => new vscode.Disposable(() => {}), onDidChangeVisibility: () => new vscode.Disposable(() => {}) } as unknown as vscode.WebviewView);
      assert.ok(webview.html.includes('refreshBtn'));
      assert.ok(webview.html.includes('Content-Security-Policy'));
      const before = webview.html;
      await receive({ type: 'confirmDelete', branches: [42], force: true });
      assert.strictEqual(webview.html, before);
    } finally {
      provider.dispose();
    }
  });
});

// Uses only an explicitly supplied disposable workspace, never a developer's real repository.
suite('Local-first view and external Git changes', () => {
  test('opens without fetch, observes external fetch and exposes explicit remote update', async function () {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd || !path.basename(cwd).startsWith('branch-pruner-host-')) { this.skip(); return; }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const runner = new ProcessGitRunner({ ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
    const git = (args: string[], directory = cwd) => runner.run(args, directory);
    await git(['init', '-b', 'main', '--template=']);
    await git(['commit', '--allow-empty', '-m', 'initial']);
    const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-pruner-remotes-'));
    const remote = path.join(fixtures, 'remote.git');
    await git(['init', '--bare', '--template=', remote]);
    await git(['remote', 'add', 'origin', remote]);
    await git(['push', '-u', 'origin', 'main']);
    const commands: string[][] = [];
    const service = new GitService({ run(args, directory, options) {
      commands.push(args); return runner.run(args, directory, options);
    } });
    let receive: (data: unknown) => Promise<void> = async () => {};
    let latest = '';
    let changed: () => void = () => {};
    const webview = {
      html: '', options: {},
      postMessage: async (message: { content?: string }) => {
        if (message.content) { latest = message.content; changed(); }
        return true;
      },
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return new vscode.Disposable(() => {}); },
    };
    const provider = new BranchPrunerViewProvider(vscode.Uri.file(__dirname), service);
    try {
      await provider.resolveWebviewView({ webview,
        onDidDispose: () => new vscode.Disposable(() => {}),
        onDidChangeVisibility: () => new vscode.Disposable(() => {}),
      } as unknown as vscode.WebviewView);
      assert.ok(webview.html.includes('origin/main'));
      assert.equal(commands.some(args => args[0] === 'fetch'), false);
      await receive({ type: 'ready' });
      const producer = path.join(fixtures, 'producer');
      await git(['clone', '--template=', '--branch', 'main', remote, producer]);
      await git(['commit', '--allow-empty', '-m', 'external commit'], producer);
      await git(['push'], producer);
      let timer: NodeJS.Timeout;
      const updated = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('View did not update after external fetch')), 8000);
        changed = () => { if (latest.includes('Behind 1')) resolve(); };
      });
      try { await git(['fetch', 'origin']); await updated; } finally { clearTimeout(timer!); changed = () => {}; }
      assert.equal(commands.some(args => args[0] === 'fetch'), false);
      await receive({ type: 'fetch' });
      assert.equal(commands.filter(args => args[0] === 'fetch').length, 1);
      assert.ok(latest.includes('Behind 1'));
    } finally { provider.dispose(); await fs.rm(fixtures, { recursive: true, force: true }); }
  });
});

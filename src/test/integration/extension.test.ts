import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GitService } from '../../services/GitService';
import { GitCommandError, ProcessGitRunner } from '../../services/GitRunner';
import { Branch } from '../../types';
import { BranchPrunerViewProvider } from '../../providers/BranchPrunerViewProvider';

suite('Extension integration', () => {
  test('keeps remote outcome distinct from local reads and switch failures, and recovers after retry', async function () {
    if (!vscode.workspace.workspaceFolders?.length) { this.skip(); return; }
    const branch: Branch = { name: 'topic', isLocal: true, exists: { local: true, remote: true },
      upstream: 'refs/remotes/upstream/server-topic', ahead: 0, behind: 1,
      isCurrentBranch: false, isMainBranch: false, isWorktreeBranch: false };
    let outcome: 'failed' | 'cancelled' | 'timeout' | 'success' | 'pending' = 'success';
    let fetches = 0;
    let enteredFetch: () => void = () => {};
    let fetchSignal: AbortSignal | undefined;
    let localGate: Promise<void> | undefined;
    let enteredLocal: () => void = () => {};
    class ScenarioGitService extends GitService {
      async isGitRepository() { return true; }
      async getGitDirectories() { return []; }
      async getBranches() {
        if (localGate) { enteredLocal(); await localGate; }
        return [{ ...branch }];
      }
      async fetchRemote(_cwd: string, signal?: AbortSignal): Promise<void> {
        fetches++;
        branch.behind!++; // A fetch can update some refs before another remote fails.
        if (outcome === 'pending') {
          fetchSignal = signal;
          return new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new GitCommandError(undefined, '', 'cancelled'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            enteredFetch();
          });
        }
        if (outcome !== 'success') throw new GitCommandError(1, 'fatal: bad object refs/heads/broken\nhttps://user:secret@example.com/repo', outcome);
      }
      async switchBranch(): Promise<void> { throw new Error('switch rejected'); }
    }
    let receive: (value: unknown) => Promise<void> = async () => {};
    let latest = '';
    let busy: boolean | undefined;
    const rendered: string[] = [];
    const webview = {
      html: '', options: {},
      postMessage: async (message: { content: string; busy: boolean }) => {
        latest = message.content; rendered.push(latest); busy = message.busy; return true;
      },
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return new vscode.Disposable(() => {}); },
    };
    const provider = new BranchPrunerViewProvider(vscode.Uri.file(__dirname), new ScenarioGitService());
    const fakeView = { webview, onDidDispose: () => new vscode.Disposable(() => {}),
      onDidChangeVisibility: () => new vscode.Disposable(() => {}) } as unknown as vscode.WebviewView;
    const completed = /Last manual fetch completed|本次会话上次手动 fetch 完成/;
    const partial = /some may have updated|部分引用可能已更新/;
    try {
      await provider.resolveWebviewView(fakeView);
      await receive({ type: 'ready' });
      assert.equal(fetches, 0);
      assert.ok(!completed.test(latest));
      await receive({ type: 'fetch' });
      assert.ok(completed.test(latest));
      for (const reason of ['failed', 'cancelled', 'timeout'] as const) {
        outcome = reason;
        await receive({ type: 'fetch' });
        const expected = { failed: /Remote update failed|远端更新失败/, cancelled: /Remote update cancelled|远端更新已取消/,
          timeout: /Remote update timed out|远端更新超时/ }[reason];
        assert.ok(expected.test(latest));
        assert.ok(partial.test(latest));
        assert.ok(!completed.test(latest));
        assert.ok(!latest.includes('secret'));
        assert.equal(latest.includes('fatal: bad object refs/heads/broken'), reason === 'failed');
        assert.ok(latest.includes(`Behind ${branch.behind}`) || latest.includes(`落后 ${branch.behind}`));
        assert.equal(busy, false);
        const count = fetches;
        await receive({ type: 'refresh' });
        await receive({ type: 'switch', branch: 'topic' });
        assert.equal(fetches, count);
        assert.ok(partial.test(latest));
        assert.ok(/Switch failed|切换失败/.test(latest));
      }
      outcome = 'success';
      await receive({ type: 'fetch' });
      assert.ok(completed.test(latest));
      assert.ok(!partial.test(latest));
      const lastOutcome = latest.match(/Last manual fetch completed[^<]*|本次会话上次手动 fetch 完成[^<]*/)?.[0];
      branch.behind!++; // Model an external ref update, without claiming a plugin fetch.
      await receive({ type: 'refresh' });
      assert.ok(lastOutcome && latest.includes(lastOutcome));
      outcome = 'pending';
      const entered = new Promise<void>(resolve => { enteredFetch = resolve; });
      const pending = receive({ type: 'fetch' });
      let releaseLocal: () => void = () => {};
      try {
        await entered;
        assert.ok(latest.includes('id="remoteProgress"'));
        assert.ok(latest.includes('id="cancelFetchBtn"'));
        assert.ok(latest.includes('upstream/server-topic'));
        assert.equal(busy, true);
        const count = fetches;
        await receive({ type: 'fetch' });
        assert.equal(fetches, count);
        localGate = new Promise<void>(resolve => { releaseLocal = resolve; });
        const readingLocal = new Promise<void>(resolve => { enteredLocal = resolve; });
        await receive({ type: 'cancelFetch' });
        assert.equal(fetchSignal?.aborted, true);
        await readingLocal;
        assert.ok(/Refreshing local state|正在刷新本地状态/.test(latest));
        assert.ok(!latest.includes('id="fetchElapsed"'));
        assert.ok(!latest.includes('id="cancelFetchBtn"'));
        assert.equal(busy, true);
        await receive({ type: 'fetch' });
        assert.equal(fetches, count);
        releaseLocal();
        localGate = undefined;
        await pending;
        assert.ok(rendered.some(html => /Cancelling fetch|正在取消获取/.test(html)));
        assert.ok(/Remote update cancelled|远端更新已取消/.test(latest));
        assert.ok(!latest.includes('id="remoteProgress"'));
        assert.equal(busy, false);
        outcome = 'success';
        await receive({ type: 'fetch' });
        assert.ok(completed.test(latest));
        assert.ok(!latest.includes('id="remoteProgress"'));
      } finally { releaseLocal(); provider.dispose(); await pending; }
      await provider.resolveWebviewView(fakeView);
      await receive({ type: 'ready' });
      assert.ok(!completed.test(latest));
    } finally { provider.dispose(); }
  });

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

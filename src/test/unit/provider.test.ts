import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import type { BranchPrunerViewProvider } from '../../providers/BranchPrunerViewProvider';
import { GitService } from '../../services/GitService';
import { GitCommandError } from '../../services/GitRunner';
import type { Branch } from '../../types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Run the actual compiled provider with only the VS Code boundary replaced.
function harness(service: GitService, chinese = false) {
  const channels: { lines: string[]; disposed: boolean }[] = [];
  let receive: (message: unknown) => Promise<void> = async () => {};
  let latest = { content: '', busy: false };
  const disposable = () => ({ dispose() {} });
  const vscode = {
    env: { language: chinese ? 'zh-cn' : 'en' },
    window: {
      onDidChangeWindowState: disposable,
      createOutputChannel: () => {
        const channel = { lines: [] as string[], disposed: false };
        channels.push(channel);
        return {
          appendLine(line: string) { assert.equal(channel.disposed, false); channel.lines.push(line); },
          dispose() { channel.disposed = true; },
        };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test-repository' } }],
      onDidChangeWorkspaceFolders: disposable,
    },
  };
  const filename = path.resolve(__dirname, '../../providers/BranchPrunerViewProvider.js');
  const module = { exports: {} as { BranchPrunerViewProvider: typeof BranchPrunerViewProvider } };
  const realRequire = createRequire(filename);
  runInNewContext(readFileSync(filename, 'utf8'), {
    exports: module.exports, module, process, AbortController, setTimeout, clearTimeout,
    require: (name: string) => name === 'vscode' ? vscode : realRequire(name),
  }, { filename });
  const provider = new module.exports.BranchPrunerViewProvider({} as never, service);
  const view = {
    webview: {
      html: '', options: {},
      postMessage: async (message: typeof latest) => { latest = message; return true; },
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return disposable(); },
    },
    onDidDispose: disposable, onDidChangeVisibility: disposable,
  };
  return {
    provider, channels, get latest() { return latest; },
    open: () => provider.resolveWebviewView(view as never),
    send: (message: unknown) => receive(message),
  };
}

class LocalService extends GitService {
  async isGitRepository() { return true; }
  async getGitDirectories() { return []; }
  async getBranches(): Promise<Branch[]> { return []; }
}

for (const outcome of ['success', 'failed', 'cancelled', 'timeout'] as const) {
  it(`ends fetch progress before slow local refresh after ${outcome}`, async () => {
    const fetched = deferred<void>();
    const reading = deferred<void>();
    const branches = deferred<Branch[]>();
    let slow = false;
    let fetches = 0;
    let switches = 0;
    class Service extends LocalService {
      async fetchRemote() {
        fetches++;
        await fetched.promise;
        if (outcome !== 'success') throw new GitCommandError(1, '', outcome);
      }
      async getBranches() {
        if (slow) { reading.resolve(); return branches.promise; }
        return [];
      }
      async switchBranch() { switches++; }
    }
    const h = harness(new Service(), outcome === 'cancelled');
    let operation: Promise<void> | undefined;
    try {
      await h.open();
      await h.send({ type: 'ready' });
      slow = true;
      operation = h.send({ type: 'fetch' });
      assert.ok(h.latest.content.includes('id="fetchElapsed"'));
      assert.ok(h.latest.content.includes('id="cancelFetchBtn"'));
      fetched.resolve();
      await reading.promise;
      assert.ok(!h.latest.content.includes('id="fetchElapsed"'), 'finished fetch must stop its timer immediately');
      assert.ok(!h.latest.content.includes('id="cancelFetchBtn"'), 'finished fetch must not offer cancellation');
      assert.match(h.latest.content, /Refreshing local state|正在刷新本地状态/);
      assert.match(h.latest.content, /Last manual fetch completed|Remote update failed|Remote update timed out|远端更新已取消/);
      assert.equal(h.latest.busy, true);
      await h.send({ type: 'fetch' });
      await h.send({ type: 'switch', branch: 'topic' });
      assert.equal(fetches, 1);
      assert.equal(switches, 0);
      branches.resolve([]);
      await operation;
      assert.equal(h.latest.busy, false);
      assert.ok(!h.latest.content.includes('id="localProgress"'));
    } finally {
      fetched.resolve(); branches.resolve([]);
      await operation;
      h.provider.dispose();
    }
  });
}

for (const phase of ['repository', 'directories', 'branches'] as const) {
  for (const fails of [false, true]) {
    it(`does not recreate logs after disposal during ${phase} (${fails ? 'reject' : 'resolve'})`, async () => {
      const entered = deferred<void>();
      const pending = deferred<void>();
      async function pause(at: typeof phase) {
        if (at === phase) { entered.resolve(); await pending.promise; }
      }
      class Service extends LocalService {
        async isGitRepository() { await pause('repository'); return true; }
        async getGitDirectories() { await pause('directories'); return []; }
        async getBranches() { await pause('branches'); return []; }
      }
      const h = harness(new Service());
      const opening = h.open();
      try {
        await entered.promise;
        assert.equal(h.channels.length, 1);
        assert.ok(h.channels[0].lines.length > 0);
        h.provider.dispose();
        const count = h.channels[0].lines.length;
        if (fails) pending.reject(new Error('late failure'));
        else pending.resolve();
        await opening;
        assert.equal(h.channels.length, 1, 'disposed provider must not create a new channel');
        assert.equal(h.channels[0].disposed, true);
        assert.equal(h.channels[0].lines.length, count);
      } finally { pending.resolve(); await opening; h.provider.dispose(); }
    });
  }
}

it('does not write stale read logs into a reopened view', async () => {
  const entered = deferred<void>();
  const pending = deferred<void>();
  let first = true;
  class Service extends LocalService {
    async isGitRepository() {
      if (first) { first = false; entered.resolve(); await pending.promise; }
      return true;
    }
  }
  const h = harness(new Service());
  const oldOpening = h.open();
  await entered.promise;
  h.provider.dispose();
  const newOpening = h.open();
  try {
    pending.resolve();
    await Promise.all([oldOpening, newOpening]);
    assert.equal(h.channels.length, 2);
    assert.equal(h.channels[0].disposed, true);
    assert.match(h.channels[1].lines[0], /local-read:start/);
    assert.ok(h.channels[1].lines.every(line => !/timeout|error/.test(line)));
    await h.send({ type: 'ready' });
    assert.match(h.latest.content, /No local branches found/);
  } finally { pending.resolve(); await newOpening; h.provider.dispose(); }
});

it('restores controls when post-fetch local refresh fails', async () => {
  let fetched = false;
  class Service extends LocalService {
    async fetchRemote() { fetched = true; }
    async getBranches() {
      if (fetched) throw new Error('local failure');
      return [];
    }
  }
  const h = harness(new Service());
  try {
    await h.open();
    await h.send({ type: 'ready' });
    await h.send({ type: 'fetch' });
    assert.match(h.latest.content, /Last manual fetch completed/);
    assert.match(h.latest.content, /Local refresh failed/);
    assert.ok(!h.latest.content.includes('id="localProgress"'));
    assert.equal(h.latest.busy, false);
  } finally { h.provider.dispose(); }
});

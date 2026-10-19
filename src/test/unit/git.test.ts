import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { RepositoryWatcher } from '../../services/RepositoryWatcher';
import { Branch } from '../../types';
import { GitService } from '../../services/GitService';
import { GitCommandError, GitRunner, ProcessGitRunner } from '../../services/GitRunner';

let root: string;
let cwd: string;
let runner: ProcessGitRunner;
let service: GitService;
const git = (args: string[], directory = cwd) => runner.run(args, directory);
const exists = async (name: string) => {
  try { await git(['show-ref', '--verify', `refs/heads/${name}`]); return true; } catch { return false; }
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-pruner-test-'));
  cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  const env = { ...process.env };
  // Do not inherit repository selection, injected config, templates or hooks from the developer environment.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  runner = new ProcessGitRunner({ ...env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
  service = new GitService(runner);
  await git(['init', '--initial-branch=main', '--template=']);
  await git(['commit', '--allow-empty', '-m', 'initial']);
});
afterEach(async () => {
  mock.restoreAll();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Safe local branch deletion', () => {
  it('keeps an unmerged branch by default and only force-deletes on explicit request', async () => {
    await git(['checkout', '-b', 'feature']);
    await git(['commit', '--allow-empty', '-m', 'unique work']);
    await git(['checkout', 'main']);
    assert.deepEqual(await service.deleteBranches(cwd, ['feature']), [{ name: 'feature', status: 'unmerged' }]);
    assert.equal(await exists('feature'), true);
    assert.deepEqual(await service.deleteBranches(cwd, ['feature'], true), [{ name: 'feature', status: 'deleted' }]);
    assert.equal(await exists('feature'), false);
  });

  it('passes shell characters literally without executing them', async () => {
    const names = ['audit/$(touch${IFS}AUDIT_MARKER)', 'topic/"quoted', 'topic/<b>demo</b>', 'feature/中文'];
    for (const name of names) await git(['branch', name]);
    const listed = (await service.getBranches(cwd)).map(branch => branch.name);
    for (const name of names) assert.ok(listed.includes(name));
    assert.deepEqual(await service.deleteBranches(cwd, names), names.map(name => ({ name, status: 'deleted' })));
    await assert.rejects(fs.access(path.join(cwd, 'AUDIT_MARKER')));
    for (const name of names) assert.equal(await exists(name), false);
  });

  it('protects main, master and the current branch, including in force mode', async () => {
    await git(['branch', 'master']);
    await git(['checkout', '-b', 'current']);
    const names = ['main', 'master', 'current'];
    assert.deepEqual(await service.deleteBranches(cwd, names, true), names.map(name => ({ name, status: 'protected' })));
    for (const name of names) assert.equal(await exists(name), true);
  });

  it('protects the cached remote default and differently named local branch tracking it', async () => {
    await git(['branch', 'trunk']);
    await git(['update-ref', 'refs/remotes/upstream/trunk', 'HEAD']);
    await git(['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/trunk']);
    await git(['config', 'remote.upstream.url', path.join(root, 'unused.git')]);
    await git(['config', 'remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*']);
    await git(['branch', '--track', 'local-default', 'upstream/trunk']);
    assert.deepEqual(await service.deleteBranches(cwd, ['trunk', 'local-default'], true), [
      { name: 'trunk', status: 'protected' }, { name: 'local-default', status: 'protected' },
    ]);
  });

  it('keeps branches occupied by linked worktrees and preserves their exact names', async () => {
    await git(['branch', 'linked']);
    await git(['worktree', 'add', path.join(root, 'linked tree'), 'linked']);
    const branch = (await service.getBranches(cwd)).find(branch => branch.name === 'linked');
    assert.ok(branch?.isWorktreeBranch);
    assert.deepEqual(await service.deleteBranches(cwd, ['linked'], true), [{ name: 'linked', status: 'worktree' }]);
    assert.equal(await exists('linked'), true);
  });

  it('reports mixed results, rejects invalid names and does not fetch', async () => {
    await git(['branch', 'merged']);
    const commands: string[][] = [];
    const tracked: GitRunner = { run(args, directory) { commands.push(args); return runner.run(args, directory); } };
    const results = await new GitService(tracked).deleteBranches(cwd, ['merged', 'missing', 'main', '-D', 'bad..ref', 'merged']);
    assert.deepEqual(results, [
      { name: 'merged', status: 'deleted' }, { name: 'missing', status: 'notFound' },
      { name: 'main', status: 'protected' }, { name: '-D', status: 'invalid' }, { name: 'bad..ref', status: 'invalid' },
    ]);
    assert.equal(commands.some(args => args[0] === 'fetch'), false);
  });

  it('rechecks protection when HEAD changes after the list was shown', async () => {
    await git(['branch', 'feature']);
    assert.equal((await service.getBranches(cwd)).find(branch => branch.name === 'feature')?.isCurrentBranch, false);
    await git(['checkout', 'feature']);
    assert.deepEqual(await service.deleteBranches(cwd, ['feature'], true), [{ name: 'feature', status: 'protected' }]);
  });

  it('fails closed when protection information cannot be read', async () => {
    await git(['branch', 'feature']);
    const faulty: GitRunner = { run(args, directory) {
      if (args[0] === 'worktree') return Promise.reject(new GitCommandError(128, 'unavailable'));
      return runner.run(args, directory);
    } };
    assert.deepEqual(await new GitService(faulty).deleteBranches(cwd, ['feature'], true), [{ name: 'feature', status: 'failed' }]);
    assert.equal(await exists('feature'), true);
  });
});

describe('Structured branch state', () => {
  it('propagates cancellation through repository state reads', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const cancellable: GitRunner = {
      run(_args, _directory, options) {
        seen.push(options?.signal);
        return Promise.reject(new GitCommandError(undefined, '', 'cancelled'));
      },
    };
    const cancellableService = new GitService(cancellable);
    await assert.rejects(cancellableService.getGitDirectories(cwd, { signal: controller.signal }), GitCommandError);
    await assert.rejects(cancellableService.getBranches(cwd, { signal: controller.signal }), GitCommandError);
    assert.ok(seen.length > 0);
    assert.ok(seen.every(signal => signal === controller.signal));
  });

  it('stops watcher startup when its read signal is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const watcher = new RepositoryWatcher(await service.getGitDirectories(cwd), () => {});
    try {
      await assert.rejects(watcher.start(controller.signal), /cancelled/);
    } finally {
      watcher.dispose();
    }
  });

  it('does not invent a branch for detached HEAD', async () => {
    await git(['checkout', '--detach', 'HEAD']);
    const branches = await service.getBranches(cwd);
    assert.deepEqual(branches.map(branch => branch.name), ['main']);
    assert.equal(branches[0].isCurrentBranch, false);
  });

  it('handles an empty repository and propagates read errors separately', async () => {
    const empty = path.join(root, 'empty');
    await fs.mkdir(empty);
    await git(['init', '--initial-branch=main', '--template='], empty);
    assert.deepEqual(await service.getBranches(empty), []);
    await assert.rejects(service.getBranches(root));
  });

  it('uses the actual upstream on non-origin remotes with a different local name', async () => {
    const remote = path.join(root, 'remote.git');
    await git(['init', '--bare', '--template=', remote]);
    await git(['remote', 'add', 'upstream', remote]);
    await git(['checkout', '-b', 'local-feature']);
    await git(['push', '-u', 'upstream', 'HEAD:server-feature']);
    let branch = (await service.getBranches(cwd)).find(branch => branch.name === 'local-feature')!;
    assert.equal(branch.upstream, 'refs/remotes/upstream/server-feature');
    assert.equal(branch.exists.remote, true);
    await git(['update-ref', '-d', 'refs/heads/server-feature'], remote);
    await service.fetchRemote(cwd);
    branch = (await service.getBranches(cwd)).find(branch => branch.name === 'local-feature')!;
    assert.equal(branch.upstream, 'refs/remotes/upstream/server-feature');
    assert.equal(branch.exists.remote, false);
    assert.equal((await service.getBranches(cwd)).find(branch => branch.name === 'main')?.upstream, undefined);
  });
});

it('executes once without a shell and preserves proxy settings', async () => {
  const original = childProcess.spawn;
  const calls: unknown[][] = [];
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    calls.push(args);
    return original(...args);
  });
  const custom = new ProcessGitRunner({ ...process.env, HTTPS_PROXY: 'http://127.0.0.1:43210', NO_PROXY: 'localhost' });
  await assert.rejects(custom.run(['branch', '-d', '--', 'missing'], cwd), GitCommandError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'git');
  assert.deepEqual(calls[0][1], ['branch', '-d', '--', 'missing']);
  const options = calls[0][2] as childProcess.SpawnOptions;
  assert.equal(options.shell, undefined);
  assert.equal(options.env?.HTTPS_PROXY, 'http://127.0.0.1:43210');
  assert.equal(options.env?.NO_PROXY, 'localhost');
});

it('counts upstream commit differences for synced, ahead, behind and diverged branches', async () => {
  const remote = path.join(root, 'remote.git');
  await git(['init', '--bare', '--template=', remote]);
  await git(['remote', 'add', 'upstream', remote]);
  await git(['checkout', '-b', 'local-feature']);
  await git(['push', '-u', 'upstream', 'HEAD:server-feature']);
  const current = async () => (await service.getBranches(cwd)).find(item => item.name === 'local-feature')!;
  assert.deepEqual([(await current()).ahead, (await current()).behind], [0, 0]);
  await git(['branch', '--track', 'behind-only', 'upstream/server-feature']);
  const producer = path.join(root, 'producer');
  await git(['clone', '--template=', '--branch', 'server-feature', remote, producer]);
  for (let index = 0; index < 3; index++) await git(['commit', '--allow-empty', '-m', `local ${index}`]);
  assert.deepEqual([(await current()).ahead, (await current()).behind], [3, 0]);
  for (let index = 0; index < 2; index++) await git(['commit', '--allow-empty', '-m', `remote ${index}`], producer);
  await git(['push'], producer);
  // Reading local state alone must not contact the server.
  assert.deepEqual([(await current()).ahead, (await current()).behind], [3, 0]);
  await git(['fetch', '--prune', 'upstream']); // external tool equivalent
  assert.deepEqual([(await current()).ahead, (await current()).behind], [3, 2]);
  const behind = (await service.getBranches(cwd)).find(item => item.name === 'behind-only')!;
  assert.deepEqual([behind.ahead, behind.behind], [0, 2]);
});

it('switches a local branch without force or automatic remote branch creation', async () => {
  await git(['branch', 'target']);
  await service.switchBranch(cwd, 'target');
  assert.equal((await service.getBranches(cwd))[0].name, 'target');
  await assert.rejects(service.switchBranch(cwd, 'missing'));
  assert.equal(await exists('missing'), false);
});

it('times out and cancels a Git process with its child transport', async () => {
  const childScript = path.join(root, 'slow.cjs');
  const pidFile = path.join(root, 'pid');
  await fs.writeFile(childScript, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  // A test-only Git alias starts an inert Node child; no remote or user config is involved.
  await git(['config', 'alias.slow', `!"${process.execPath}" "${childScript}"`]);
  const pending = runner.run(['slow'], cwd, { timeoutMs: 1500 });
  await assert.rejects(pending, (error: unknown) => error instanceof GitCommandError && error.reason === 'timeout');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  if (process.platform !== 'win32') assert.throws(() => process.kill(pid, 0));
  const controller = new AbortController();
  const cancelled = runner.run(['slow'], cwd, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof GitCommandError && error.reason === 'cancelled');
});

it('watches external switches, nested refs, packed refs and fetches without polling or network work', async () => {
  let observe: () => void = () => {};
  const watcher = new RepositoryWatcher(await service.getGitDirectories(cwd), () => observe());
  await watcher.start();
  const change = async (action: () => Promise<unknown>, expected: (branches: Branch[]) => boolean) => {
    let timer: NodeJS.Timeout;
    const changed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('No matching Git change event')), 5000);
      observe = () => { void service.getBranches(cwd).then(branches => {
        if (expected(branches)) resolve();
      }, reject); };
    });
    try { await action(); await changed; } finally { clearTimeout(timer!); observe = () => {}; }
  };
  try {
    await change(() => git(['checkout', '-b', 'topic/nested/one']), branches => branches[0]?.name === 'topic/nested/one');
    await change(() => git(['checkout', 'main']), branches => branches[0]?.name === 'main');
    await change(() => git(['branch', '-d', 'topic/nested/one']), branches => branches.length === 1);
    await change(() => git(['branch', 'topic/nested/two']), branches => branches.some(b => b.name === 'topic/nested/two'));
    await change(async () => { await git(['pack-refs', '--all', '--prune']); await git(['branch', '-d', 'topic/nested/two']); }, branches => branches.length === 1);
    const remote = path.join(root, 'remote.git');
    await git(['init', '--bare', '--template=', remote]);
    await git(['remote', 'add', 'upstream', remote]);
    await git(['push', '-u', 'upstream', 'main']);
    const producer = path.join(root, 'producer');
    await git(['clone', '--template=', '--branch', 'main', remote, producer]);
    await git(['commit', '--allow-empty', '-m', 'external'], producer);
    await git(['push'], producer);
    await change(() => git(['fetch', 'upstream']), branches => branches[0]?.behind === 1);
  } finally { watcher.dispose(); }
});

it('watches linked worktree HEAD and common repository refs', async () => {
  const linked = path.join(root, 'linked');
  await git(['worktree', 'add', '-b', 'linked-branch', linked]);
  const directories = await service.getGitDirectories(linked);
  assert.equal(directories.length, 2);
  let notify: () => void = () => {};
  const watcher = new RepositoryWatcher(directories, () => notify());
  await watcher.start();
  let timer: NodeJS.Timeout;
  try {
    const changed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('No linked worktree event')), 5000);
      notify = () => { void service.getBranches(linked).then(branches => {
        if (branches[0]?.name === 'new-linked') resolve();
      }, reject); };
    });
    await git(['checkout', '-b', 'new-linked'], linked);
    await changed;
  } finally { clearTimeout(timer!); watcher.dispose(); }
});

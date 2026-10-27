import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createGitPathResolver, GitExtensionApi, GIT_PATH_TIMEOUT_MS } from '../../gitPath';
import { GitCommandError, ProcessGitRunner } from '../../services/GitRunner';

const gitPath = path.resolve('Git 安装目录', 'git executable');
const available: GitExtensionApi = { enabled: true, getAPI: () => ({ git: { path: gitPath } }) };

it('uses the API executable without reading or waiting for repository state', async () => {
  const logs: string[] = [];
  const extension = { ...available, get state(): never { throw new Error('Must not read repository state'); } };
  const resolve = createGitPathResolver(async () => extension, line => logs.push(line));
  assert.equal(await resolve(), gitPath);
  assert.equal(await resolve(), gitPath);
  assert.deepEqual(logs, ['git-path:source=vscode.git']);
});

it('falls back for absent, disabled, throwing or invalid APIs and retries successfully', async () => {
  const cases = [undefined, { ...available, enabled: false },
    { enabled: true, getAPI: () => { throw new Error('disabled'); } },
    { enabled: true, getAPI: () => ({ git: { path: '' } }) },
    { enabled: true, getAPI: () => ({ git: { path: 'git' } }) }];
  for (const value of cases) {
    let extension = value;
    const logs: string[] = [];
    const resolve = createGitPathResolver(async () => extension, line => logs.push(line));
    assert.equal(await resolve(), 'git');
    extension = available;
    assert.equal(await resolve(), gitPath);
    assert.deepEqual(logs, ['git-path:source=PATH reason=api-unavailable', 'git-path:source=vscode.git']);
  }
  assert.equal(await createGitPathResolver(async () => { throw new Error('activation failed'); }, () => {})(), 'git');
});

it('bounds activation waiting and ignores late results without caching failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (value: GitExtensionApi) => void;
  const activation = new Promise<GitExtensionApi>(resolve => { complete = resolve; });
  const logs: string[] = [];
  const resolve = createGitPathResolver(() => activation, line => logs.push(line));
  const pending = resolve();
  await Promise.resolve(); // Activation has started but has not settled.
  t.mock.timers.tick(GIT_PATH_TIMEOUT_MS);
  assert.equal(await pending, 'git');
  complete(available);
  await activation;
  assert.deepEqual(logs, ['git-path:source=PATH reason=api-timeout']);
  assert.equal(await resolve(), gitPath);
});

it('cancels executable resolution before spawning and ignores late activation rejection', async () => {
  const controller = new AbortController();
  let reject!: (reason: Error) => void;
  const activation = new Promise<GitExtensionApi>((_, no) => { reject = no; });
  const logs: string[] = [];
  const resolve = createGitPathResolver(() => activation, line => logs.push(line));
  const runner = new ProcessGitRunner({}, resolve);
  const pending = runner.run(['--version'], undefined, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof GitCommandError && error.reason === 'cancelled');
  reject(new Error('late activation failure'));
  await activation.catch(() => {});
  assert.deepEqual(logs, []);
  await assert.rejects(resolve(controller.signal), GitCommandError);
});

it('executes an explicitly resolved executable with an empty PATH', async () => {
  // Node stands in for Git to verify executable injection without relying on a Git install.
  const runner = new ProcessGitRunner({ ...process.env, PATH: '' }, async () => process.execPath);
  const result = await runner.run(['--version']);
  assert.equal(result.stdout.trim(), process.version);
});

it('passes paths containing spaces and Unicode literally without a shell', async (t) => {
  const original = childProcess.spawn;
  const calls: unknown[][] = [];
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    calls.push(args);
    // Observe the spawn boundary, substituting only the test executable.
    return original(process.execPath, args[1], args[2]);
  });
  const runner = new ProcessGitRunner(process.env, createGitPathResolver(async () => available, () => {}));
  await runner.run(['--version']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], gitPath);
  assert.deepEqual(calls[0][1], ['--version']);
  assert.equal((calls[0][2] as childProcess.SpawnOptions).shell, undefined);
});

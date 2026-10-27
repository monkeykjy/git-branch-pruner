const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function fixture(t, version = '0.2.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pruner-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project with spaces');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--template=', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.git/hooks'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../version.sh'), path.join(repo, 'version.sh'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'git-branch-pruner', version }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Change Log\n\n## [0.2.2] - Unreleased\n\n- Git path improvement.\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.vsix\n.calls\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const head = git('rev-parse', 'HEAD');
  // Stub build commands only: all Git, file edits, commits, tags and guards are real.
  fs.writeFileSync(path.join(bin, 'pnpm'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> .calls
if [[ "\${TEST_FAILURE:-}" == "$1" ]]; then exit 23; fi
if [[ "$1" == test && "\${TEST_MUTATION:-}" == other ]]; then echo changed >> README.md; fi
if [[ "$1" == test && "\${TEST_MUTATION:-}" == metadata ]]; then echo changed >> CHANGELOG.md; fi
if [[ "$1" == run && "\${TEST_MISSING_PACKAGE:-}" != yes ]]; then printf 'fixture-vsix' > "$4"; fi
`, { mode: 0o755 });
  const run = (args = ['0.2.2'], extra = {}) => spawnSync('bash', [path.join(repo, 'version.sh'), ...args], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000,
  });
  const unchanged = () => { assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('tag', '--list'), ''); };
  return { root, repo, env, git, head, run, unchanged };
}

test('prepares version files, creates an annotated tag, and only prints publishing commands', t => {
  const f = fixture(t);
  const result = f.run(['0.2.2', 'Test release description']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('cat-file', '-t', 'v0.2.2'), 'tag');
  assert.equal(f.git('rev-parse', 'v0.2.2^{}'), f.git('rev-parse', 'HEAD'));
  assert.equal(JSON.parse(f.git('show', 'v0.2.2:package.json')).version, '0.2.2');
  assert.match(f.git('show', 'v0.2.2:CHANGELOG.md'), /## \[0\.2\.2\] - \d{4}-\d{2}-\d{2}/);
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'CHANGELOG.md\npackage.json');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(f.repo, 'git-branch-pruner-0.2.2.vsix'), 'utf8'), 'fixture-vsix');
  assert.match(result.stdout, /尚未推送或发布/);
  assert.match(result.stdout, /publish --packagePath/);
  assert.equal(fs.readFileSync(path.join(f.repo, '.calls'), 'utf8').split('\n')[0], 'test');
  assert.doesNotMatch(fs.readFileSync(path.join(f.repo, '.calls'), 'utf8'), /publish/);
  const second = f.run();
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /tag v0.2.2 已存在/);
});

test('accepts the already prepared package version', t => {
  const f = fixture(t, '0.2.2');
  assert.equal(f.run().status, 0);
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'CHANGELOG.md');
});

for (const state of ['staged', 'unstaged', 'untracked']) {
  test(`rejects ${state} work before modifying metadata`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.repo, state === 'untracked' ? 'notes.txt' : 'README.md'), 'user work');
    if (state === 'staged') f.git('add', 'README.md');
    const before = f.git('status', '--porcelain');
    assert.notEqual(f.run().status, 0);
    f.unchanged();
    assert.equal(f.git('status', '--porcelain'), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo, 'package.json'))).version, '0.2.1');
  });
}

for (const version of ['v0.2.2', '0.2', '0.02.2', '0.2.2;echo bad', '0.2.0', '0.2.3']) {
  test(`rejects invalid, lower or undocumented version ${version}`, t => {
    const f = fixture(t);
    assert.notEqual(f.run([version]).status, 0);
    f.unchanged();
    assert.equal(f.git('status', '--porcelain'), '');
  });
}

for (const failure of ['test', 'run', 'missing-package', 'other-change', 'metadata-change', 'commit']) {
  test(`stops before tagging on ${failure}`, t => {
    const f = fixture(t);
    if (failure === 'commit') fs.writeFileSync(path.join(f.repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const extra = failure === 'missing-package' ? { TEST_MISSING_PACKAGE: 'yes' }
      : failure === 'other-change' ? { TEST_MUTATION: 'other' }
      : failure === 'metadata-change' ? { TEST_MUTATION: 'metadata' } : { TEST_FAILURE: failure };
    const result = f.run(undefined, extra);
    assert.notEqual(result.status, 0, result.stdout);
    f.unchanged();
    assert.doesNotMatch(result.stdout, /本地准备完成/);
  });
}

test('rejects a tag already on the local bare origin without fetching or changing files', t => {
  const f = fixture(t);
  const remote = path.join(f.root, 'origin.git');
  execFileSync('git', ['init', '--bare', '--template=', remote], { env: f.env, stdio: 'ignore' });
  f.git('remote', 'add', 'origin', remote);
  f.git('push', 'origin', 'HEAD:refs/tags/v0.2.2');
  assert.notEqual(f.run().status, 0);
  f.unchanged();
  assert.equal(f.git('status', '--porcelain'), '');
});

test('rejects an unreachable origin before editing files', t => {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', path.join(f.root, 'missing.git'));
  assert.notEqual(f.run().status, 0);
  f.unchanged();
  assert.equal(f.git('status', '--porcelain'), '');
});

test('tags an already prepared clean commit without an empty commit', t => {
  const f = fixture(t, '0.2.2');
  const changelog = path.join(f.repo, 'CHANGELOG.md');
  fs.writeFileSync(changelog, fs.readFileSync(changelog, 'utf8').replace('Unreleased', '2026-10-27'));
  f.git('add', 'CHANGELOG.md'); f.git('commit', '-m', 'prepare release');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.run().status, 0);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('rev-parse', 'v0.2.2^{}'), head);
});

test('refuses to tag when a commit hook changes the validated tree', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.git/hooks/pre-commit'), '#!/bin/sh\necho changed >> CHANGELOG.md\ngit add CHANGELOG.md\n', { mode: 0o755 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.git('tag', '--list'), '');
  assert.match(result.stderr, /提交钩子改变/);
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.head, 'retain the completed local commit for inspection');
});

test('rejects detached HEAD without changing files', t => {
  const f = fixture(t);
  f.git('checkout', '--detach');
  assert.notEqual(f.run().status, 0);
  f.unchanged();
  assert.equal(f.git('status', '--porcelain'), '');
});

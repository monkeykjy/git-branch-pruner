// Disposable local-only fixture for manual extension acceptance testing.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve relative to this project, even when invoked from another working directory.
const demoDirectory = path.resolve(__dirname, '../../tmp/demo');
fs.mkdirSync(demoDirectory, { recursive: true });
const root = fs.mkdtempSync(path.join(demoDirectory, 'run-'));
const repository = path.join(root, 'repository');
const peer = path.join(root, 'peer');
const remote = path.join(root, 'remote.git');
// Optional macOS/Linux fixture: enable with remote.origin.uploadpack in this demo only.
const slowUploadPack = path.join(root, 'slow-upload-pack.sh');
fs.writeFileSync(slowUploadPack, '#!/bin/sh\ncase "$1" in 8|35) ;; *) exit 1 ;; esac\nsleep "$1"\nshift\nexec git-upload-pack "$@"\n');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: 'Branch Pruner Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid',
  GIT_COMMITTER_NAME: 'Branch Pruner Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid',
});
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(cwd, message) { git(cwd, 'commit', '--allow-empty', '-m', message); }
fs.mkdirSync(repository);
git(root, 'init', '--bare', '--initial-branch=main', '--template=', remote);
git(repository, 'init', '--initial-branch=main', '--template=');
commit(repository, 'initial');
git(repository, 'remote', 'add', 'origin', remote);
git(repository, 'push', '-u', 'origin', 'main');
for (const name of ['feature/ahead', 'feature/behind', 'feature/diverged', 'feature/gone']) {
  git(repository, 'checkout', '-b', name, 'main');
  git(repository, 'push', '-u', 'origin', name);
}
git(repository, 'checkout', 'feature/ahead');
commit(repository, 'local ahead 1'); commit(repository, 'local ahead 2');
git(repository, 'checkout', 'feature/diverged');
for (let i = 1; i <= 3; i++) commit(repository, `local diverged ${i}`);
git(root, 'clone', '--template=', remote, peer);
for (const name of ['feature/behind', 'feature/diverged']) {
  git(peer, 'checkout', name);
  for (let i = 1; i <= 2; i++) commit(peer, `${name} remote ${i}`);
  git(peer, 'push');
}
git(repository, 'checkout', 'main');
git(repository, 'branch', 'local-only');
git(repository, 'branch', 'delete-safe');
git(repository, 'branch', 'master');
git(repository, 'fetch', '--prune');
git(repository, 'remote', 'set-head', 'origin', 'main');
// Keep this stale cached ref until the user's first manual remote update.
git(remote, 'update-ref', '-d', 'refs/heads/feature/gone');
console.log(JSON.stringify({ repository, peer, remote }, null, 2));
console.log('仅使用本地临时仓库；在扩展开发宿主中打开 repository。测试步骤见 docs/005.MANUAL_TESTS.md。');
console.log('macOS 慢速获取：在 repository 执行 git config remote.origin.uploadpack "sh ../slow-upload-pack.sh 8"。恢复：git config --unset remote.origin.uploadpack。');

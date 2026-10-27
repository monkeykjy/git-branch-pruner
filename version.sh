#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '用法: %s <版本号> [tag描述]\n例如: %s 0.2.2 "Release v0.2.2"\n' "$0" "$0"
  printf '仅在本地更新版本、测试、打包、提交版本文件并创建附注 tag；不会推送或发布。\n'
}
fail() { printf '错误: %s\n' "$*" >&2; exit 1; }
if [[ ${1:-} == '--help' || ${1:-} == '-h' ]]; then usage; exit 0; fi
if [[ $# -lt 1 || $# -gt 2 ]]; then usage >&2; exit 1; fi

# 从其他目录调用时，仍只操作脚本所在项目。
cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for tool in git node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "未找到 $tool，请先安装并加入 PATH。"
done
[[ $(git rev-parse --show-toplevel) == "$PWD" ]] || fail '请将脚本放在 Git 仓库根目录。'
[[ -z $(git status --porcelain --untracked-files=all) ]] || fail '工作区或暂存区不干净，请先提交本次功能、测试和发布说明。'
branch=$(git symbolic-ref --quiet --short HEAD) || fail '当前为 detached HEAD，请先切换到待发布分支。'
base_commit=$(git rev-parse HEAD)
git var GIT_AUTHOR_IDENT >/dev/null
git var GIT_COMMITTER_IDENT >/dev/null

new_version=$1
tag="v$new_version"
tag_message=${2:-Release $tag}
release_date=$(date +%Y-%m-%d)

# 用 Node 解析 JSON；只支持稳定版本，不生成空白发布说明。
node - "$new_version" <<'JS'
const fs = require('fs');
const version = process.argv[2];
const valid = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!valid.test(version)) throw new Error('版本号须为不带 v 前缀的稳定版本，例如 0.2.2');
const current = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
if (!valid.test(current)) throw new Error('package.json 中的当前版本无效');
const a = version.split('.').map(BigInt), b = current.split('.').map(BigInt);
const differing = a.findIndex((value, i) => value !== b[i]);
if (differing !== -1 && a[differing] < b[differing]) throw new Error('不允许版本倒退');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const heading = /^## \[([^\]]+)\] - (Unreleased|\d{4}-\d{2}-\d{2})\r?$/m.exec(changelog);
if (!heading || heading[1] !== version) throw new Error('请先在 CHANGELOG 顶部写好目标版本的发布说明并提交');
const notes = changelog.slice(heading.index + heading[0].length).split(/^## /m)[0].trim();
if (!notes) throw new Error('目标版本的发布说明不能为空');
JS

for ref in "$tag" "$new_version"; do
  if git show-ref --verify --quiet "refs/tags/$ref"; then fail "本地 tag $ref 已存在，不会覆盖。"; fi
done
# 只读检查 origin，避免本地尚未 fetch 到已发布 tag 时重复创建。
if git remote get-url origin >/dev/null 2>&1; then
  remote_tags=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$new_version") || fail '无法检查 origin 的 tag，未修改版本文件。'
  [[ -z $remote_tags ]] || fail 'origin 已有这个版本的 tag，不会覆盖。'
fi

package_dir=''
cleanup() { if [[ -n $package_dir ]]; then rm -rf -- "$package_dir"; fi; }
trap cleanup EXIT
trap 'printf "失败，已停止。请检查 git status；保留已产生的文件修改或本地提交，不自动回滚，也不推送。\n" >&2' ERR

node - "$new_version" "$release_date" <<'JS'
const fs = require('fs');
const [version, date] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
manifest.version = version;
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('CHANGELOG.md', changelog.replace(`## [${version}] - Unreleased`, `## [${version}] - ${date}`));
JS

metadata_hashes=$(git hash-object package.json CHANGELOG.md)
printf '正在验证并打包 %s...\n' "$tag"
pnpm test
# 使用独立目录，打包失败时不会把已有 VSIX 当成本次产物。
package_dir=$(mktemp -d "${TMPDIR:-/tmp}/branch-pruner-release.XXXXXX")
pnpm run package --out "$package_dir/release.vsix"
[[ -s "$package_dir/release.vsix" ]] || fail '未生成非空 VSIX，停止创建提交和 tag。'

[[ $(git rev-parse HEAD) == "$base_commit" ]] || fail '验证期间 HEAD 发生变化，请重新检查，未创建 tag。'
[[ $(git hash-object package.json CHANGELOG.md) == "$metadata_hashes" ]] || fail '版本文件在验证期间发生变化，未创建 tag。'
node - "$new_version" <<'JS'
const fs = require('fs');
const { execFileSync } = require('child_process');
const changes = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (changes.some(line => ![' M package.json', ' M CHANGELOG.md'].includes(line))) {
  throw new Error('验证期间出现其他工作区或暂存区改动，停止提交');
}
if (JSON.parse(fs.readFileSync('package.json', 'utf8')).version !== process.argv[2]) throw new Error('版本号在验证期间发生变化');
JS

expected_tree=$(git rev-parse 'HEAD^{tree}')
if ! git diff --quiet -- package.json CHANGELOG.md; then
  git add -- package.json CHANGELOG.md
  expected_tree=$(git write-tree)
  git commit -m "chore: release $tag" --only -- package.json CHANGELOG.md
fi
[[ $(git rev-parse 'HEAD^{tree}') == "$expected_tree" ]] || fail '提交钩子改变了已验证的内容，未创建 tag。'
[[ -z $(git status --porcelain --untracked-files=all) ]] || fail '提交后工作区不干净，未创建 tag。'
release_commit=$(git rev-parse HEAD)
artifact="git-branch-pruner-$new_version.vsix"
cp -- "$package_dir/release.vsix" "$artifact"
git tag -a "$tag" "$release_commit" -m "$tag_message"

printf '\n本地准备完成: %s (%s)\n安装包: %s\n' "$tag" "$release_commit" "$artifact"
printf '尚未推送或发布。请安装 VSIX 验收，然后由你操作:\n'
printf '1. 推送源码与 tag: git push origin %q && git push origin %q\n' "$branch" "$tag"
printf '2. 在 GitHub 为 %s 创建 Release，填写对应 CHANGELOG 内容并上传 %s。\n' "$tag" "$artifact"
printf '3. 向 Marketplace 上传同一份包: pnpm exec vsce publish --packagePath %q\n' "$artifact"

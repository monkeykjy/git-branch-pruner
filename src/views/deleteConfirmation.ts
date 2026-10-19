/** Text for the existing VS Code confirmation, with scope and risk before any long target list. */
export function getDeleteConfirmation(cwd: string, branches: string[], force: boolean, chinese: boolean) {
  const t = (cn: string, en: string) => chinese ? cn : en;
  const scope = t('只删除本地分支，不删除远程分支。', 'Only local branches are deleted. Remote branches are unaffected.');
  const risk = force
    ? t('强制删除：跳过未合并检查，可能丢失指向未合并提交的分支引用。',
      'Force deletion: skips the merge check and may remove branch references to unmerged commits.')
    : t('普通删除：尚未合并的分支会保留。Git 根据上游或 HEAD 检查，不代表已合并到主分支。',
      'Normal deletion: unmerged branches are kept. Git checks against upstream or HEAD, not necessarily the default branch.');
  const protection = t('当前分支、受保护分支和工作树占用分支仍会保留。',
    'Current, protected and worktree-occupied branches are still kept.');
  return {
    title: force ? t(`强制删除这 ${branches.length} 个本地分支？`, `Force delete these ${branches.length} local branches?`)
      : t(`删除这 ${branches.length} 个本地分支？`, `Delete these ${branches.length} local branches?`),
    button: force ? t('强制删除本地分支', 'Force delete local branches') : t('删除本地分支', 'Delete local branches'),
    detail: `${scope}\n\n${risk}\n${protection}\n\n${t('仓库：', 'Repository: ')}${cwd}\n\n` +
      `${t('目标分支：', 'Target branches:')}\n${branches.map((name, index) => `${index + 1}. ${name}`).join('\n')}`,
  };
}

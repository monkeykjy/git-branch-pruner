import { randomBytes } from 'crypto';
import { Branch, DeleteResult, DeleteStatus } from '../types';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!));
}

export function deleteStatusText(status: DeleteStatus, chinese: boolean): string {
  const labels: Record<DeleteStatus, [string, string]> = {
    deleted: ['已删除', 'Deleted'],
    notFound: ['分支已不存在', 'Branch no longer exists'],
    protected: ['受保护分支，已保留', 'Protected branch; kept'],
    worktree: ['被工作树使用，已保留', 'In use by a worktree; kept'],
    unmerged: ['尚未合并，已保留', 'Not fully merged; kept'],
    invalid: ['无效分支名', 'Invalid branch name'],
    failed: ['操作失败，分支状态请刷新核实', 'Operation failed; refresh to verify branch state'],
  };
  return labels[status][chinese ? 0 : 1];
}

const script = `
const vscode = acquireVsCodeApi();
let busy = false;
let repository = document.getElementById('content')?.dataset.repository || '';
const saved = vscode.getState() || {};
let selection = saved.repository === repository ? saved.selection || [] : [];
let query = saved.repository === repository ? saved.query || '' : '';
const selectable = () => Array.from(document.querySelectorAll('.branch-checkbox:not([data-protected])'));
const selected = () => selectable().filter(input => input.checked).map(input => input.dataset.branch);
function save() { vscode.setState({ repository, selection: selected(), query, scroll: window.scrollY }); }
function updateControls() {
  document.querySelectorAll('button').forEach(button => {
    button.disabled = busy || button.hasAttribute('data-unavailable') ||
      (button.dataset.delete !== undefined && selected().length === 0);
  });
  document.querySelectorAll('.branch-checkbox').forEach(input => {
    input.disabled = busy || input.hasAttribute('data-protected');
  });
  const visible = selectable().filter(input => !input.closest('.branch-item').hidden);
  const all = document.getElementById('selectAll');
  if (all) {
    const count = visible.filter(input => input.checked).length;
    all.disabled = busy || visible.length === 0;
    all.checked = count > 0 && count === visible.length;
    all.indeterminate = count > 0 && count < visible.length;
  }
}
function applyFilter() {
  document.querySelectorAll('.branch-item').forEach(row => {
    row.hidden = !row.dataset.name.toLowerCase().includes(query.toLowerCase());
  });
}
function restore() {
  selectable().forEach(input => input.checked = selection.includes(input.dataset.branch));
  const search = document.getElementById('search');
  if (search) search.value = query;
  applyFilter();
  updateControls();
}
function send(message) {
  if (busy) return;
  save(); busy = true; updateControls();
  vscode.postMessage(message);
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.id === 'refreshBtn') send({ type: 'refresh' });
  else if (button.id === 'fetchBtn') send({ type: 'fetch' });
  else if (button.dataset.switch !== undefined) send({ type: 'switch', branch: button.dataset.switch });
  else if (button.dataset.delete !== undefined && selected().length) {
    send({ type: 'confirmDelete', branches: selected(), force: button.dataset.delete === 'force' });
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'selectAll') {
    selectable().filter(input => !input.closest('.branch-item').hidden).forEach(input => input.checked = event.target.checked);
  }
  updateControls(); save();
});
document.addEventListener('input', event => {
  if (event.target.id === 'search') { query = event.target.value; applyFilter(); updateControls(); save(); }
});
window.addEventListener('scroll', save);
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'setControlsState' && typeof message.enabled === 'boolean') {
    busy = !message.enabled; updateControls();
  } else if (message?.type === 'updateBranches') {
    const scroll = window.scrollY;
    const focused = document.activeElement?.id;
    const cursor = document.getElementById('search')?.selectionStart;
    selection = message.repository === repository ? selected() : [];
    if (message.repository !== repository) query = '';
    repository = message.repository;
    document.getElementById('content').innerHTML = message.content;
    busy = message.busy;
    restore();
    if (focused === 'search') {
      const search = document.getElementById('search');
      search?.focus(); search?.setSelectionRange(cursor, cursor);
    }
    window.scrollTo(0, scroll); save();
  }
});
restore();
if (saved.repository === repository) window.scrollTo(0, saved.scroll || 0);
vscode.postMessage({ type: 'ready' });
`;

function page(content: string, chinese: boolean, interactive = false, repository = ''): string {
  const nonce = randomBytes(24).toString('base64');
  return `<!DOCTYPE html>
<html lang="${chinese ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<style nonce="${nonce}">
body { padding: 10px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
p { line-height: 1.4; }
.description { margin-bottom: 20px; }
.actions { margin: 10px 0; }
button { padding: 6px 12px; margin: 5px; border: none; border-radius: 2px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button:disabled { opacity: 0.6; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.branch-list { margin: 10px 0; }
.branch-item { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 8px; margin: 5px 0;
  background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.branch-item[hidden] { display: none; }
input[type="search"] { box-sizing: border-box; width: 100%; padding: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
.comparison { font-size: 12px; overflow-wrap: anywhere; min-width: 0; }
.branch-item label { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; }
.branch-name { flex: 1; margin-right: 10px; overflow-wrap: anywhere; min-width: 0; }
li { overflow-wrap: anywhere; }
.badge { padding: 2px 6px; border-radius: 3px; font-size: 12px; margin-right: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge.current { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
.badge.protected { background: var(--vscode-statusBarItem-prominentBackground); color: var(--vscode-statusBarItem-prominentForeground); }
.disabled { opacity: 0.7; }
.notice { color: var(--vscode-descriptionForeground); }
.error { color: var(--vscode-errorForeground); }
.results { border-top: 1px solid var(--vscode-panel-border); margin-top: 16px; }
</style>
</head>
<body><main id="content" data-repository="${escapeHtml(repository)}">${content}</main>${interactive ? `<script nonce="${nonce}">${script}</script>` : ''}</body>
</html>`;
}

export function getErrorContent(message: string, chinese: boolean): string {
  return page(`<p class="error" role="alert">${escapeHtml(message)}</p>
    <button id="refreshBtn">${chinese ? '重试' : 'Retry'}</button>`, chinese, true);
}

export function getLoadingContent(message: string, chinese: boolean): string {
  return page(`<p role="status">${escapeHtml(message)}</p>`, chinese);
}

export function getBranchListBody(
  branches: Branch[],
  chinese: boolean,
  results: DeleteResult[] = [],
  notice = ''
): string {
  const t = (cn: string, en: string) => chinese ? cn : en;
  const rows = branches.map((branch) => {
    const protectedBranch = branch.isMainBranch || branch.isCurrentBranch || branch.isWorktreeBranch;
    const badges: string[] = [];
    const protectionBadges = `${branch.isCurrentBranch ? `<span class="badge current">${t('当前', 'Current')}</span>` : ''}
      ${branch.isMainBranch ? `<span class="badge protected">${t('受保护', 'Protected')}</span>` : ''}`;
    if (branch.isWorktreeBranch && !branch.isCurrentBranch) badges.push(t('工作树使用中', 'In use by worktree'));
    if (!branch.upstream) {
      badges.push(t('未设置上游', 'No upstream'));
    } else if (!branch.upstream.startsWith('refs/remotes/')) {
      badges.push(t('跟踪本地分支', 'Local upstream'));
    } else {
      if (!branch.exists.remote) badges.push(t('上游引用已消失', 'Upstream ref missing'));
      else if (branch.ahead === undefined || branch.behind === undefined) badges.push(t('差距暂不可用', 'Comparison unavailable'));
      else if (branch.ahead === 0 && branch.behind === 0) badges.push(t('已同步', 'Up to date'));
      else badges.push(`Ahead ${branch.ahead} · Behind ${branch.behind}`);
    }
    return `<div data-name="${escapeHtml(branch.name)}" class="branch-item ${protectedBranch ? 'disabled' : ''}">
      <label><input type="checkbox" class="branch-checkbox" data-branch="${escapeHtml(branch.name)}"
        ${protectedBranch ? 'data-protected disabled' : ''}><span class="branch-name">${escapeHtml(branch.name)}</span></label>
      ${protectionBadges}${badges.map((badge) => `<span class="badge">${badge}</span>`).join('')}
      ${branch.upstream ? `<span class="comparison">↔ ${escapeHtml(branch.upstream.replace(/^refs\/(remotes|heads)\//, ''))}</span>` : ''}
      <button class="secondary" data-switch="${escapeHtml(branch.name)}" ${branch.isWorktreeBranch || branch.isCurrentBranch ? 'data-unavailable disabled' : ''}>${t('切换', 'Switch')}</button>
    </div>`;
  }).join('');
  const summary = results.length ? `<section class="results" aria-live="polite">
    <h3>${t('删除结果', 'Deletion results')}</h3>
    <ul>${results.map((result) => `<li>${escapeHtml(result.name)} — ${deleteStatusText(result.status, chinese)}</li>`).join('')}</ul>
  </section>` : '';
  return `
    <p class="description">${t('检查并清理本地 Git 分支。普通删除保留 Git 的未合并保护。', 'Review and clean up local Git branches. Normal deletion preserves Git’s unmerged-branch protection.')}</p>
    <p class="notice">${t('上游状态来自本地引用，不表示分支已合并或可以安全删除。', 'Upstream status comes from local refs; it does not mean a branch is merged or safe to delete.')}</p>
    ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}
    <div class="actions"><button id="fetchBtn">${t('更新远端状态', 'Update remote status')}</button>
      <button id="refreshBtn" class="secondary">${t('刷新本地', 'Refresh local')}</button></div>
    <input id="search" type="search" aria-label="${t('搜索本地分支', 'Search local branches')}" placeholder="${t('搜索本地分支', 'Search local branches')}">
    ${branches.length ? `
      <label><input id="selectAll" type="checkbox">${t('全选可操作分支', 'Select all available branches')}</label>
      <div class="branch-list">${rows}</div>
      <div class="actions">
        <button data-delete="normal" disabled>${t('删除选中', 'Delete selected')}</button>
        <button data-delete="force" class="secondary" disabled>${t('强制删除…', 'Force delete…')}</button>
      </div>` : `<p>${t('未找到本地分支', 'No local branches found')}</p>`}
    ${summary}`;
}

export function getBranchListContent(branches: Branch[], chinese: boolean, results: DeleteResult[] = [], notice = '', repository = ''): string {
  return page(getBranchListBody(branches, chinese, results, notice), chinese, true, repository);
}

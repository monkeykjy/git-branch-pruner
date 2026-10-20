import { randomBytes } from 'crypto';
import { Branch, DeleteResult, DeleteStatus, RemoteProgress } from '../types';

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
let busy = !!(document.getElementById('remoteProgress') || document.getElementById('localProgress'));
let progressTimer;
let repository = document.getElementById('content')?.dataset.repository || '';
const saved = vscode.getState() || {};
let selection = saved.repository === repository ? saved.selection || [] : [];
let query = saved.repository === repository ? saved.query || '' : '';
const selectable = () => Array.from(document.querySelectorAll('.branch-checkbox:not([data-protected])'));
const selected = () => selectable().filter(input => input.checked).map(input => input.dataset.branch);
function save() { vscode.setState({ repository, selection: selected(), query, scroll: window.scrollY }); }
function updateControls() {
  document.querySelectorAll('button').forEach(button => {
    button.disabled = (busy && button.id !== 'cancelFetchBtn') || button.hasAttribute('data-unavailable') ||
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
function updateProgress() {
  if (progressTimer !== undefined) { clearInterval(progressTimer); progressTimer = undefined; }
  const elapsed = document.getElementById('fetchElapsed');
  if (!elapsed) return;
  const slowNotice = document.getElementById('fetchSlowNotice');
  const tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(elapsed.dataset.started)) / 1000));
    elapsed.textContent = elapsed.dataset.prefix + seconds + elapsed.dataset.suffix;
    if (slowNotice) slowNotice.hidden = seconds < 30;
  };
  tick();
  progressTimer = setInterval(tick, 1000);
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
  updateProgress();
}
function send(message) {
  if (busy) return;
  save(); busy = true; updateControls();
  vscode.postMessage(message);
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.id === 'cancelFetchBtn') { button.disabled = true; vscode.postMessage({ type: 'cancelFetch' }); }
  else if (button.id === 'refreshBtn') send({ type: 'refresh' });
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
.branch-item { padding: 9px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.branch-header { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.branch-item:hover { background: var(--vscode-list-hoverBackground); }
.branch-item:has(.branch-checkbox:checked) { background: var(--vscode-list-inactiveSelectionBackground); }
.branch-item[hidden] { display: none; }
input[type="search"] { box-sizing: border-box; width: 100%; padding: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
.branch-details { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px;
  margin: 2px 0 0 22px; font-size: 12px; line-height: 18px; color: var(--vscode-descriptionForeground); }
.comparison { overflow-wrap: anywhere; min-width: 0; }
.branch-status { display: inline-flex; flex-wrap: wrap; gap: 0 6px; }
.commit-count { white-space: nowrap; font-variant-numeric: tabular-nums; }
.branch-item label { display: flex; align-items: flex-start; gap: 8px; flex: 1; min-width: 0; line-height: 22px; }
.branch-checkbox { flex: 0 0 14px; width: 14px; height: 14px; margin: 4px 0; accent-color: var(--vscode-focusBorder); }
.branch-name { overflow-wrap: anywhere; min-width: 0; }
.branch-flags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0 6px;
  max-width: 50%; font-size: 12px; line-height: 22px; color: var(--vscode-descriptionForeground); }
.branch-flags span { white-space: nowrap; }
.branch-flags .current { color: var(--vscode-foreground); }
.branch-item button.secondary { flex-shrink: 0; margin: 0; padding: 0 4px; min-height: 22px; font: inherit;
  font-size: 12px; color: var(--vscode-textLink-foreground); background: transparent; }
.branch-item button.secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
.branch-item button.secondary:active:not(:disabled) { transform: translateY(1px); }
li { overflow-wrap: anywhere; }
.notice { color: var(--vscode-descriptionForeground); }
.git-error { margin: 12px 0; overflow-wrap: anywhere; }
.git-error summary { cursor: pointer; color: var(--vscode-errorForeground); }
.git-error pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto;
  user-select: text; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5; }
.error { color: var(--vscode-errorForeground); }
.remote-progress { margin: 12px 0; }
.progress-heading { display: flex; align-items: center; gap: 8px; line-height: 1.5; }
.spinner { display: inline-block; flex: 0 0 12px; width: 12px; height: 12px; border: 2px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.progress-detail { margin: 4px 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
.progress-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.progress-controls button { margin: 0; }
.progress-controls button:active:not(:disabled):not(:focus-visible) { transform: translateY(1px); }
.elapsed { font-size: 12px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
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
  return page(`<p class="progress-heading" role="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(message)}</p>`, chinese);
}

export function getBranchListBody(
  branches: Branch[],
  chinese: boolean,
  results: DeleteResult[] = [],
  notice = '',
  progress?: RemoteProgress,
  refreshingLocal = false,
  remoteErrorDetails = ''
): string {
  const t = (cn: string, en: string) => chinese ? cn : en;
  const rows = branches.map((branch) => {
    const protectedBranch = branch.isMainBranch || branch.isCurrentBranch || branch.isWorktreeBranch;
    const flags = [branch.isCurrentBranch ? `<span class="current">${t('当前', 'Current')}</span>` : '',
      branch.isMainBranch ? `<span>${t('受保护', 'Protected')}</span>` : '',
      branch.isWorktreeBranch && !branch.isCurrentBranch ? `<span>${t('工作树使用中', 'In worktree')}</span>` : ''].join('');
    let status: string;
    if (!branch.upstream) {
      status = t('未设置上游', 'No upstream');
    } else if (!branch.upstream.startsWith('refs/remotes/')) {
      status = t('跟踪本地分支', 'Local upstream');
    } else {
      if (!branch.exists.remote) status = t('本地未找到上游引用', 'Upstream ref not found locally');
      else if (branch.ahead === undefined || branch.behind === undefined) status = t('差距暂不可用', 'Comparison unavailable');
      else if (branch.ahead === 0 && branch.behind === 0) status = t('已同步', 'Up to date');
      else status = `<span class="commit-count">${t('领先', 'Ahead')} ${branch.ahead}</span> <span class="commit-count">${t('落后', 'Behind')} ${branch.behind}</span>`;
    }
    return `<div data-name="${escapeHtml(branch.name)}" class="branch-item">
      <div class="branch-header">
      <label><input type="checkbox" class="branch-checkbox" data-branch="${escapeHtml(branch.name)}"
        ${protectedBranch ? 'data-protected disabled' : ''}><span class="branch-name">${escapeHtml(branch.name)}</span></label>
      ${flags ? `<span class="branch-flags">${flags}</span>` : ''}
      ${!branch.isWorktreeBranch && !branch.isCurrentBranch ? `<button class="secondary" data-switch="${escapeHtml(branch.name)}" aria-label="${escapeHtml(t('切换到 ', 'Switch to ') + branch.name)}">${t('切换', 'Switch')}</button>` : ''}
      </div>
      <div class="branch-details">
        ${branch.upstream ? `<span class="comparison">${escapeHtml(branch.upstream.replace(/^refs\/(remotes|heads)\//, ''))}&nbsp;·</span>` : ''}
        <span class="branch-status" title="${t('状态依据本地记录，不代表已合并或可安全删除。领先 / 落后是相对所列远端上游各自独有的提交数；本地缺少引用不能证明服务器已删除分支。', 'Status uses local records, not merge status or deletion safety. Ahead / Behind counts commits unique to each side of the listed remote upstream; a missing local ref does not prove server-side deletion.')}">${status}</span>
      </div>
    </div>`;
  }).join('');
  const summary = results.length ? `<section class="results" aria-live="polite">
    <h3>${t('删除结果', 'Deletion results')}</h3>
    <ul>${results.map((result) => `<li>${escapeHtml(result.name)} — ${deleteStatusText(result.status, chinese)}</li>`).join('')}</ul>
  </section>` : '';
  return `
    <p class="description">${t('检查并清理本地 Git 分支。普通删除保留 Git 的未合并保护。', 'Review and clean up local Git branches. Normal deletion preserves Git’s unmerged-branch protection.')}</p>
    <p class="notice">${t('领先 / 落后按提交数计算，依据本地上游引用，不是远端实时查询。状态不代表已合并或可安全删除。', 'Ahead / Behind counts commits using local upstream refs, not a live remote query. Status does not imply merged or safe to delete.')}</p>
    ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}
    ${remoteErrorDetails ? `<details class="git-error" open><summary>${t('Git 错误详情（可选中复制）', 'Git error details (select to copy)')}</summary><pre tabindex="0">${escapeHtml(remoteErrorDetails)}</pre><p class="notice">${t('已隐藏 URL 和常见认证字段；过长内容显示首尾，中间以 […] 标记。', 'URLs and common authentication fields are hidden. Long output shows the beginning and end, separated by […].')}</p></details>` : ''}
    ${progress ? `<section id="remoteProgress" class="remote-progress" role="status">
      <div class="progress-heading"><span class="spinner" aria-hidden="true"></span><strong>${progress.cancelling
        ? t('正在取消获取…', 'Cancelling fetch…') : t('正在获取远端状态…', 'Fetching remote status…')}</strong></div>
      <p class="progress-detail">${progress.cancelling
        ? t('正在等待 Git 结束，当前列表继续保留。', 'Waiting for Git to stop; the current list stays visible.')
        : t('当前显示本地引用，获取最长等待 5 分钟。可随时取消。', 'Showing local refs. Fetch times out after 5 minutes; you can cancel anytime.')}</p>
      ${!progress.cancelling ? `<p id="fetchSlowNotice" class="progress-detail" hidden>${t('获取时间较长，可继续等待或取消。', 'Fetch is taking longer. You can keep waiting or cancel.')}</p>` : ''}
      <div class="progress-controls"><span id="fetchElapsed" class="elapsed" role="timer" aria-live="off"
        data-started="${progress.startedAt}" data-prefix="${t('已等待 ', 'Elapsed ')}" data-suffix="${t(' 秒', ' s')}"></span>
        <button id="cancelFetchBtn" class="secondary" ${progress.cancelling ? 'data-unavailable disabled' : ''}>${t('取消获取', 'Cancel fetch')}</button></div>
    </section>` : ''}
    ${refreshingLocal ? `<p id="localProgress" class="progress-heading" role="status"><span class="spinner" aria-hidden="true"></span>${t('正在刷新本地状态…', 'Refreshing local state…')}</p>` : ''}
    <div class="actions"><button id="fetchBtn">${t('更新远端状态', 'Update remote status')}</button>
      <button id="refreshBtn" class="secondary">${t('刷新本地', 'Refresh local')}</button></div>
    <input id="search" type="search" aria-label="${t('搜索本地分支', 'Search local branches')}" placeholder="${t('搜索本地分支', 'Search local branches')}">
    ${branches.length ? `
      <label><input id="selectAll" type="checkbox">${t('全选可操作分支', 'Select all available branches')}</label>
      <div class="branch-list" aria-busy="${!!progress || refreshingLocal}">${rows}</div>
      <div class="actions">
        <button data-delete="normal" disabled>${t('删除选中', 'Delete selected')}</button>
        <button data-delete="force" class="secondary" disabled>${t('强制删除…', 'Force delete…')}</button>
      </div>` : `<p>${t('未找到本地分支', 'No local branches found')}</p>`}
    ${summary}`;
}

export function getBranchListContent(branches: Branch[], chinese: boolean, results: DeleteResult[] = [], notice = '', repository = '', progress?: RemoteProgress, refreshingLocal = false, remoteErrorDetails = ''): string {
  return page(getBranchListBody(branches, chinese, results, notice, progress, refreshingLocal, remoteErrorDetails), chinese, true, repository);
}

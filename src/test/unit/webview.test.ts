import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { Branch, parseWebviewMessage } from '../../types';
import { getBranchListContent, getErrorContent, getLoadingContent } from '../../views/webview';
import { getDeleteConfirmation } from '../../views/deleteConfirmation';

const branch: Branch = {
  name: 'topic/<b>"quoted"&demo</b>', isLocal: true, exists: { local: true, remote: false },
  isCurrentBranch: false, isMainBranch: false, isWorktreeBranch: false,
};

it('escapes names, results, notices and errors and uses nonce-bound scripts/styles', () => {
  const html = getBranchListContent([branch], true, [{ name: branch.name, status: 'unmerged' }], '<notice>');
  assert.ok(html.includes('topic/&lt;b&gt;&quot;quoted&quot;&amp;demo&lt;/b&gt;'));
  assert.ok(html.includes('&lt;notice&gt;'));
  assert.equal(html.includes(branch.name), false);
  assert.equal(/\son\w+=/.test(html), false);
  const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(getErrorContent('<img>', false).includes('&lt;img&gt;'));
  assert.ok(getLoadingContent('<img>', false).includes('&lt;img&gt;'));
});

it('rejects malformed deletion messages and requires an explicit boolean force mode', () => {
  for (const value of [null, [], 'delete', {}, { type: 'unknown' },
    { type: 'confirmDelete', branches: ['a'] },
    { type: 'confirmDelete', branches: ['a'], force: 'false' },
    { type: 'confirmDelete', branches: [], force: false },
    { type: 'confirmDelete', branches: [1], force: true },
    { type: 'confirmDelete', branches: ['bad\0name'], force: true }]) {
    assert.equal(parseWebviewMessage(value), undefined);
  }
  assert.deepEqual(parseWebviewMessage({ type: 'confirmDelete', branches: ['a', 'a'], force: false }),
    { type: 'confirmDelete', branches: ['a'], force: false });
  assert.deepEqual(parseWebviewMessage({ type: 'cancelFetch' }), { type: 'cancelFetch' });
});

it('selection and scroll survive automatic refresh, and controls distinguish local refresh from fetch', () => {
  type Listener = (event?: any) => void;
  function element(dataset: Record<string, string> = {}, id = '') {
    return { dataset, id, checked: false, disabled: false, hidden: false, indeterminate: false, value: '',
      innerHTML: '', selectionStart: 0,
      hasAttribute(name: string) { return name === 'data-protected' && dataset.protected !== undefined; },
      closest(selector: string): any { return selector === '.branch-item' ? row : this; },
      focus() {}, setSelectionRange() {},
    };
  }
  const row = element({ name: 'literal-branch' });
  const available = element({ branch: 'literal-branch' });
  const protectedBranch = element({ branch: 'main', protected: '' });
  const normal = element({ delete: 'normal' });
  const force = element({ delete: 'force' });
  const refresh = element({}, 'refreshBtn');
  const fetch = element({}, 'fetchBtn');
  const all = element({}, 'selectAll');
  const search = element({}, 'search');
  const content = element({ repository: '/repo' }, 'content');
  const cancel = element({}, 'cancelFetchBtn');
  const elapsed = { ...element({ started: '1000', prefix: 'Elapsed ', suffix: ' s' }, 'fetchElapsed'), textContent: '' };
  let showProgress = false;
  let now = 3000;
  let timer: (() => void) | undefined;
  const messages: unknown[] = [];
  const listeners: Record<string, Listener> = {};
  const windowListeners: Record<string, Listener> = {};
  let saved: unknown;
  let scroll = 120;
  const html = getBranchListContent([branch], false);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    Date: { now: () => now },
    setInterval: (tick: () => void) => { timer = tick; return 1; },
    clearInterval: () => { timer = undefined; },
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))),
      getState: () => undefined, setState: (state: unknown) => { saved = state; },
    }),
    window: {
      get scrollY() { return scroll; }, scrollTo: (_x: number, y: number) => { scroll = y; },
      addEventListener: (name: string, listener: Listener) => { windowListeners[name] = listener; },
    },
    document: {
      addEventListener: (name: string, listener: Listener) => { listeners[name] = listener; },
      getElementById: (id: string) => [refresh, fetch, all, search, content, ...(showProgress ? [elapsed, cancel] : [])].find(item => item.id === id),
      querySelectorAll: (selector: string) => {
        if (selector === 'button') return [normal, force, refresh, fetch, ...(showProgress ? [cancel] : [])];
        if (selector === '.branch-item') return [row];
        if (selector.includes(':not')) return [available];
        return [available, protectedBranch];
      },
    },
  });
  messages.length = 0; // ready handshake
  assert.equal(normal.disabled, true);
  all.checked = true;
  listeners.change({ target: all });
  assert.equal(available.checked, true);
  assert.equal(protectedBranch.checked, false);
  windowListeners.message({ data: { type: 'updateBranches', repository: '/repo', content: '<updated>', busy: false } });
  assert.equal(available.checked, true);
  assert.equal(scroll, 120);
  assert.equal(content.innerHTML, '<updated>');
  assert.ok(saved);
  listeners.click({ target: normal });
  assert.deepEqual(messages.pop(), { type: 'confirmDelete', branches: ['literal-branch'], force: false });
  assert.equal(available.disabled, true);
  windowListeners.message({ data: { type: 'setControlsState', enabled: true } });
  assert.equal(protectedBranch.disabled, true);
  listeners.click({ target: force });
  assert.deepEqual(messages.pop(), { type: 'confirmDelete', branches: ['literal-branch'], force: true });
  windowListeners.message({ data: { type: 'setControlsState', enabled: true } });
  listeners.click({ target: refresh });
  assert.deepEqual(messages.pop(), { type: 'refresh' });
  windowListeners.message({ data: { type: 'setControlsState', enabled: true } });
  listeners.click({ target: fetch });
  assert.deepEqual(messages.pop(), { type: 'fetch' });
  windowListeners.message({ data: { type: 'setControlsState', enabled: true } });
  all.checked = false;
  listeners.change({ target: all });
  assert.equal(normal.disabled, true);
  search.value = 'missing';
  listeners.input({ target: search });
  assert.equal(row.hidden, true);
  assert.equal(all.disabled, true);
  showProgress = true;
  windowListeners.message({ data: { type: 'updateBranches', repository: '/repo', content: '<pending>', busy: true } });
  assert.equal(fetch.disabled, true);
  assert.equal(cancel.disabled, false);
  assert.equal(elapsed.textContent, 'Elapsed 2 s');
  now = 8000; timer?.();
  assert.equal(elapsed.textContent, 'Elapsed 7 s');
  listeners.click({ target: cancel });
  assert.deepEqual(messages.pop(), { type: 'cancelFetch' });
  assert.equal(cancel.disabled, true);
  showProgress = false;
  windowListeners.message({ data: { type: 'updateBranches', repository: '/repo', content: '<cancelled>', busy: false } });
  assert.equal(timer, undefined);
  assert.equal(fetch.disabled, false);
});

it('puts deletion scope and mode before all targets, preserving long batch names in both languages', () => {
  const names = Array.from({ length: 30 }, (_, index) => `feature/${index}/` + 'long-name-'.repeat(12));
  for (const chinese of [true, false]) for (const force of [true, false]) {
    const confirmation = getDeleteConfirmation('/demo/repository', names, force, chinese);
    assert.ok(confirmation.detail.startsWith(chinese ? '只删除本地分支，不删除远程分支。' : 'Only local branches are deleted. Remote branches are unaffected.'));
    const risk = chinese ? (force ? '跳过未合并检查' : '尚未合并的分支会保留')
      : (force ? 'skips the merge check' : 'unmerged branches are kept');
    assert.ok(confirmation.detail.indexOf(risk) < confirmation.detail.indexOf(names[0]));
    for (const name of names) assert.ok(confirmation.detail.includes(name));
    assert.ok(confirmation.detail.includes(chinese ? '工作树占用分支' : 'worktree-occupied'));
    assert.ok(confirmation.button.includes(chinese ? '本地' : 'local'));
  }
});

it('shows commit counts and comparison target, but never invents zero counts without an upstream', () => {
  const tracked = { ...branch, upstream: 'refs/remotes/upstream/server', exists: { local: true, remote: true }, ahead: 3, behind: 2 };
  assert.ok(getBranchListContent([tracked], true).includes('领先 3'));
  assert.ok(getBranchListContent([tracked], true).includes('落后 2'));
  assert.ok(getBranchListContent([tracked], false).includes('Ahead 3'));
  assert.ok(getBranchListContent([tracked], false).includes('Behind 2'));
  assert.ok(getBranchListContent([tracked], true).includes('upstream/server'));
  assert.ok(getBranchListContent([{ ...tracked, ahead: 0, behind: 0 }], false).includes('Up to date'));
  const untracked = getBranchListContent([branch], false);
  assert.ok(untracked.includes('No upstream'));
  assert.equal(untracked.includes('Ahead 0'), false);
});

it('distinguishes missing local refs, local upstreams and unavailable counts in both languages', () => {
  const tracked = { ...branch, upstream: 'refs/remotes/upstream/server', exists: { local: true, remote: true } };
  for (const chinese of [true, false]) {
    const missing = getBranchListContent([{ ...tracked, exists: { local: true, remote: false } }], chinese);
    assert.ok(missing.includes(chinese ? '本地未找到上游引用' : 'Upstream ref not found locally'));
    assert.ok(missing.includes('upstream/server'));
    assert.ok(!missing.includes(chinese ? '领先 0' : 'Ahead 0'));
    const local = getBranchListContent([{ ...tracked, upstream: 'refs/heads/main' }], chinese);
    assert.ok(local.includes(chinese ? '跟踪本地分支' : 'Local upstream'));
    assert.ok(!local.includes(chinese ? '领先 0' : 'Ahead 0'));
    const unknown = getBranchListContent([tracked], chinese);
    assert.ok(unknown.includes(chinese ? '差距暂不可用' : 'Comparison unavailable'));
    assert.ok(!unknown.includes(chinese ? '已同步' : 'Up to date'));
  }
});

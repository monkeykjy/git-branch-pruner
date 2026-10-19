import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { Branch, parseWebviewMessage } from '../../types';
import { getBranchListContent, getErrorContent, getLoadingContent } from '../../views/webview';

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
  const messages: unknown[] = [];
  const listeners: Record<string, Listener> = {};
  const windowListeners: Record<string, Listener> = {};
  let saved: unknown;
  let scroll = 120;
  const html = getBranchListContent([branch], false);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
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
      getElementById: (id: string) => [refresh, fetch, all, search, content].find(item => item.id === id),
      querySelectorAll: (selector: string) => {
        if (selector === 'button') return [normal, force, refresh, fetch];
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
});

it('shows commit counts and comparison target, but never invents zero counts without an upstream', () => {
  const tracked = { ...branch, upstream: 'refs/remotes/upstream/server', exists: { local: true, remote: true }, ahead: 3, behind: 2 };
  assert.ok(getBranchListContent([tracked], true).includes('Ahead 3 · Behind 2'));
  assert.ok(getBranchListContent([tracked], true).includes('upstream/server'));
  assert.ok(getBranchListContent([{ ...tracked, ahead: 0, behind: 0 }], false).includes('Up to date'));
  const untracked = getBranchListContent([branch], false);
  assert.ok(untracked.includes('No upstream'));
  assert.equal(untracked.includes('Ahead 0'), false);
});

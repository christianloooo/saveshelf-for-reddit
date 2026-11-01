// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { hydrateIcons } from './icons.js';
import * as api from './api.js';
import { h, ic, fill, relTime, fmtDate, fmtNum, fmtCompact, highlight, debounce, meterLevel, syncedText } from './util.js';

const $ = (id) => document.getElementById(id);
const PAGE = 40;
hydrateIcons();

const state = {
  query: new URLSearchParams(location.search).get('q') ?? '',
  type: 'all',
  subreddits: new Set(),
  tags: new Set(),
  preset: 'any',
  from: null,
  to: null,
  sort: 'saved-desc',
  subFilter: '',
  showAllSubs: false,
  plan: null,
  lastSyncAt: null, // from getSyncStatus: has a sync ever finished?
  items: [],
  matched: 0,
  total: 0,
  editingTagFor: null,
  allTags: [],
  folder: null, // null = everything, 'none' = un-filed, otherwise a folder id
  folders: [],
  folderError: '',
  folderMode: null, // null | 'create' | folder id being renamed
  pendingMove: null, // item to file into the folder being created
};

/* ---------- query building ---------- */
function dateRange() {
  if (state.preset === 'any') return {};
  if (state.preset === 'custom') return { from: state.from, to: state.to };
  return { from: Date.now() - Number(state.preset) * 86_400_000 };
}
const filterParams = () => ({
  query: state.query,
  type: state.type,
  subreddits: [...state.subreddits],
  tags: [...state.tags],
  folderId: state.folder,
  ...dateRange(),
});
const otherFilters = () => state.type !== 'all' || state.subreddits.size || state.tags.size || state.preset !== 'any';
const hasFilters = () => otherFilters() || state.folder !== null;

/* ---------- rendering ---------- */
function renderTypeSeg(types) {
  const opts = [['all', 'All', types.post + types.comment], ['post', 'Posts', types.post], ['comment', 'Comments', types.comment]];
  $('type-seg').replaceChildren(
    ...opts.map(([value, label, n]) =>
      h('label', {},
        h('input', { type: 'radio', name: 'type', value, checked: state.type === value, onchange: () => { state.type = value; reload(); } }),
        h('span', {}, label, h('small', {}, fmtNum(n))),
      ),
    ),
  );
}

function renderSubs(subs) {
  const needle = state.subFilter.toLowerCase();
  let list = subs.filter((s) => s.name.toLowerCase().includes(needle));
  // keep selected subs visible even when they have zero matches in the current view
  for (const sel of state.subreddits) if (!list.some((s) => s.name === sel) && sel.toLowerCase().includes(needle)) list.push({ name: sel, count: 0 });
  const LIMIT = 8;
  const collapsed = !state.showAllSubs && !needle && list.length > LIMIT;
  const shown = collapsed ? list.slice(0, LIMIT) : list;
  $('subs').replaceChildren(
    ...shown.map((s) =>
      h('li', {},
        h('label', {},
          h('input', {
            type: 'checkbox', checked: state.subreddits.has(s.name),
            onchange: (e) => { e.target.checked ? state.subreddits.add(s.name) : state.subreddits.delete(s.name); reload(); },
          }),
          h('span', { class: 'name' }, `r/${s.name}`),
          h('span', { class: 'count' }, fmtNum(s.count)),
        ),
      ),
    ),
  );
  if (!shown.length) $('subs').append(h('li', { class: 'hint' }, 'No matching subreddits'));
  const more = $('subs-more');
  more.hidden = !(collapsed || (state.showAllSubs && list.length > LIMIT && !needle));
  more.textContent = collapsed ? `Show ${list.length - LIMIT} more` : 'Show fewer';
}

function renderTagFilters(tags) {
  const box = $('tag-filters');
  const names = new Set(tags.map((t) => t.name));
  const list = [...tags, ...[...state.tags].filter((t) => !names.has(t)).map((name) => ({ name, count: 0 }))];
  box.replaceChildren(
    ...list.map((t) =>
      h('button', {
        type: 'button', class: 'tag-toggle', 'aria-pressed': String(state.tags.has(t.name)),
        onclick: () => { state.tags.has(t.name) ? state.tags.delete(t.name) : state.tags.add(t.name); reload(); },
      }, t.name, h('span', { class: 'count' }, fmtNum(t.count))),
    ),
  );
  $('tag-hint').textContent = list.length ? 'Select several tags to narrow results.' : 'No tags yet. Add one from any saved item.';
}

function highlightQuery(text) { return highlight(text, state.query); }

function renderTags(item) {
  const wrap = h('div', { class: 'card-tags' },
    item.tags.map((t) =>
      h('span', { class: 'tag' }, highlightQuery(t),
        h('button', { type: 'button', 'aria-label': `Remove tag ${t}`, onclick: () => editTag(item, 'remove', t) }, ic('x', 12)),
      ),
    ),
  );
  if (state.editingTagFor === item.id) {
    const listId = 'tag-suggestions';
    const input = h('input', {
      class: 'tag-input', type: 'text', maxLength: 32, placeholder: 'tag name', list: listId, 'aria-label': 'New tag name',
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); state.editingTagFor = null; v ? editTag(item, 'add', v) : rerenderCard(item); }
        if (e.key === 'Escape') { state.editingTagFor = null; rerenderCard(item); }
      },
      onblur: () => { if (state.editingTagFor === item.id) { state.editingTagFor = null; rerenderCard(item); } },
    });
    const dl = h('datalist', { id: listId }, state.allTags.filter((t) => !item.tags.includes(t)).map((t) => h('option', { value: t })));
    wrap.append(input, dl);
    queueMicrotask(() => input.focus());
  } else {
    wrap.append(h('button', { type: 'button', class: 'tag-add', onclick: () => { state.editingTagFor = item.id; rerenderCard(item); } }, ic('plus', 12), 'Add tag'));
  }
  return wrap;
}

function renderCard(item) {
  const li = h('li', { class: 'card', dataset: { id: item.id } });
  li.append(...[
    h('div', { class: 'card-head' },
      h('a', { class: 'card-title', href: item.url, target: '_blank', rel: 'noopener' }, highlightQuery(item.title), ic('external-link', 14)),
    ),
    h('div', { class: 'meta' },
      h('span', { class: 'type' }, ic(item.type === 'comment' ? 'message-square' : 'file-text', 14), item.type === 'comment' ? 'Comment' : 'Post'),
      h('span', { class: 'sub' }, highlightQuery(`r/${item.subreddit}`)),
      h('span', {}, highlightQuery(`u/${item.author}`)),
      h('span', { title: new Date(item.savedAt).toLocaleString() }, `Saved ${relTime(item.savedAt)}`),
      h('span', {}, `${fmtCompact(item.score)} points`),
      item.type === 'post' ? h('span', {}, `${fmtCompact(item.numComments)} comments`) : null,
    ),
    typeof item.snippet === 'string' && item.snippet.trim() ? h('p', { class: 'snippet' }, highlightQuery(item.snippet)) : null,
    h('div', { class: 'card-foot' }, renderTags(item), renderMoveBtn(item)),
  ].filter(Boolean)); // Element.append() would render a null child as the text "null"
  return li;
}

function rerenderCard(item) {
  const old = $('cards').querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  old?.replaceWith(renderCard(item));
}

function renderList({ append = false } = {}) {
  const ul = $('cards');
  if (!append) ul.replaceChildren();
  const start = append ? ul.children.length : 0;
  ul.append(...state.items.slice(start).map(renderCard));
  $('more').hidden = state.items.length >= state.matched;
  $('more').textContent = `Show ${Math.min(PAGE, state.matched - state.items.length)} more`;

  $('summary').textContent = state.matched
    ? `${fmtNum(state.matched)} ${state.matched === 1 ? 'save' : 'saves'}${state.matched !== state.total ? ` of ${fmtNum(state.total)}` : ''}`
    : '';

  renderEmpty();
}

function renderEmpty() {
  const empty = $('empty');
  empty.hidden = state.matched > 0;
  if (!empty.hidden) {
    const none = state.total === 0;
    const synced = none && state.lastSyncAt !== null; // synced at least once and Reddit had nothing
    const bare = state.folder !== null && !state.query.trim() && !otherFilters(); // a folder with nothing in it
    const unfiled = state.folder === 'none';
    fill(empty,
      ic(none ? 'inbox' : bare ? 'folder-open' : 'search-x', 32),
      h('h3', {}, none ? (synced ? '0 saves' : 'No saves yet') : bare ? (unfiled ? 'Everything is filed' : 'This folder is empty') : 'No saves match'),
      h('p', {}, none ? (synced ? 'Reddit has no saved posts for this account yet. Save a post on Reddit, then sync again.' : 'Sync your Reddit saved posts to build your library.')
        : bare ? (unfiled ? 'Every save is in a folder.' : 'Use “Move to folder” on any save to put it here.')
        : 'Try a different search or clear some filters.'),
      none ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: clearAll }, bare ? 'Show all saves' : 'Clear search and filters'),
    );
  }
}

function renderActive() {
  const chips = [];
  const add = (label, onRemove) => chips.push(
    h('span', { class: 'chip' }, label, h('button', { type: 'button', 'aria-label': `Remove filter ${label}`, onclick: onRemove }, ic('x', 12))),
  );
  if (state.folder !== null) add(state.folder === 'none' ? 'Unfiled' : `Folder: ${folderName(state.folder) ?? 'unknown'}`, () => { state.folder = null; reload(); });
  if (state.type !== 'all') add(state.type === 'post' ? 'Posts' : 'Comments', () => { state.type = 'all'; reload(); });
  for (const s of state.subreddits) add(`r/${s}`, () => { state.subreddits.delete(s); reload(); });
  for (const t of state.tags) add(`#${t}`, () => { state.tags.delete(t); reload(); });
  if (state.preset !== 'any') {
    const label = state.preset === 'custom' ? 'Custom dates' : `Last ${state.preset === '365' ? 'year' : state.preset + ' days'}`;
    add(label, () => { state.preset = 'any'; $('date-preset').value = 'any'; $('date-custom').hidden = true; reload(); });
  }
  $('active-filters').replaceChildren(...chips);
  $('clear').hidden = !hasFilters();
}

function renderBanner() {
  const p = state.plan;
  const b = $('cap-banner');
  $('pro-chip').hidden = p.plan !== 'pro';
  $('upgrade-btn').hidden = p.plan === 'pro';
  if (p.plan === 'pro' || p.count / p.cap < 0.8) { b.hidden = true; return; }
  b.hidden = false;
  const full = p.limitReached;
  b.dataset.kind = full ? 'full' : 'near';
  const meter = h('div', { class: 'meter', 'data-level': meterLevel(p), role: 'progressbar', 'aria-label': 'Free library usage', 'aria-valuemin': 0, 'aria-valuemax': p.cap, 'aria-valuenow': p.count },
    h('span', { style: `width:${Math.min(100, (p.count / p.cap) * 100)}%` }));
  b.replaceChildren(
    ic(full ? 'circle-alert' : 'layers', 20),
    h('div', { class: 'grow' },
      full
        ? h('p', {}, h('strong', {}, `Free library full (${fmtNum(p.count)} of ${fmtNum(p.cap)}). `),
            p.pending ? `${fmtNum(p.pending)} more saves are waiting to be added.` : 'New saves won’t be added until you upgrade. Search and export still work.')
        : h('p', {}, h('strong', {}, `${fmtNum(p.count)} of ${fmtNum(p.cap)} free items used. `), 'Pro removes the limit for a one-time $9.'),
      meter,
    ),
    h('button', { class: `btn ${full ? 'btn-primary' : ''}`, type: 'button', command: 'show-modal', commandfor: 'upsell' }, full ? 'Unlock unlimited · $9' : 'See Pro'),
  );
  $('upsell-lead').textContent = p.pending
    ? `Reddit only shows your latest 1,000 saves. You’ve filled the ${fmtNum(p.cap)} free slots and ${fmtNum(p.pending)} more are waiting to be added.`
    : `Reddit only shows your latest 1,000 saves. Free keeps ${fmtNum(p.cap)}; Pro keeps all of them, forever.`;
}

async function renderSync() {
  const s = await api.getSyncStatus();
  $('sync-dot').dataset.state = s.state;
  $('sync').classList.toggle('is-syncing', s.state === 'syncing');
  $('sync-text').textContent =
    s.state === 'syncing' ? (s.progress ? `Syncing ${fmtNum(s.progress.done)} of ${fmtNum(s.progress.total)}` : 'Syncing…')
    : s.state === 'error' ? 'Sync failed'
    : s.state === 'needs-login' ? 'Sign in to Reddit to sync'
    : s.lastSyncAt ? syncedText(s) : 'Not synced yet';
  $('sync').title = s.message ?? '';
  const synced = s.lastSyncAt ?? null;
  if ((synced === null) !== (state.lastSyncAt === null)) { state.lastSyncAt = synced; if (state.total === 0) renderEmpty(); }
  state.lastSyncAt = synced;
}

/* ---------- folders ---------- */
const folderName = (id) => state.folders.find((f) => f.id === id)?.name;

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, 3500);
}

async function refreshFolders() {
  try {
    state.folders = await api.listFolders();
    state.folderError = '';
  } catch (err) {
    console.error(err);
    state.folders = [];
    state.folderError = 'Folders are unavailable right now.';
  }
  if (state.folder && state.folder !== 'none' && !folderName(state.folder)) state.folder = null; // deleted elsewhere
  renderFolders();
  renderActive();
}

function pickFolder(id) {
  state.folder = state.folder === id ? null : id;
  reload();
}

function filterRow({ id, label, icon, count }) {
  const on = state.folder === id;
  return h('li', { class: 'folder-row', dataset: { active: String(on) } },
    h('button', { type: 'button', class: 'folder-btn', 'aria-pressed': String(on), title: label, onclick: () => pickFolder(id) },
      ic(icon, 16), h('span', { class: 'name' }, label), h('span', { class: 'count' }, fmtNum(count))),
  );
}

let draft = null; // text typed into a folder form that failed validation, so it survives the re-render
function folderForm({ value = '', label, submit, onSubmit, onCancel }) {
  const input = h('input', {
    type: 'text', maxLength: 60, value: draft ?? value, placeholder: 'Folder name', autocomplete: 'off', 'aria-label': label,
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } },
  });
  const form = h('form', { class: 'folder-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); onSubmit(input.value); } },
    input,
    h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, submit),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: onCancel }, 'Cancel'),
    state.folderError ? h('p', { class: 'form-error', role: 'alert' }, state.folderError) : null,
  );
  queueMicrotask(() => { input.focus(); input.select(); });
  return form;
}

function folderItem(f) {
  if (state.folderMode === f.id) {
    return h('li', { class: 'folder-row editing' }, folderForm({
      value: f.name, label: `New name for folder ${f.name}`, submit: 'Save',
      onSubmit: (name) => saveFolder(f.id, name),
      onCancel: () => closeFolderForm(`[data-rename="${CSS.escape(f.id)}"]`),
    }));
  }
  const on = state.folder === f.id;
  return h('li', { class: 'folder-row', dataset: { active: String(on) } },
    h('button', { type: 'button', class: 'folder-btn', 'aria-pressed': String(on), title: f.name, onclick: () => pickFolder(f.id) },
      ic(on ? 'folder-open' : 'folder', 16), h('span', { class: 'name' }, f.name), h('span', { class: 'count' }, fmtNum(f.count))),
    h('span', { class: 'folder-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-xs', dataset: { rename: f.id }, 'aria-label': `Rename folder ${f.name}`, title: 'Rename', onclick: () => { state.folderMode = f.id; state.folderError = ''; draft = null; renderFolders(); } }, ic('pencil', 14)),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-xs', dataset: { del: f.id }, 'aria-label': `Delete folder ${f.name}`, title: 'Delete', onclick: () => askDelete(f) }, ic('trash-2', 14)),
    ),
  );
}

function renderFolders() {
  const filed = state.folders.reduce((n, f) => n + f.count, 0);
  const rows = [filterRow({ id: null, label: 'All saves', icon: 'library', count: state.total })];
  if (state.folders.length) rows.push(filterRow({ id: 'none', label: 'Unfiled', icon: 'inbox', count: Math.max(0, state.total - filed) }));
  rows.push(...state.folders.map(folderItem));
  if (state.folderMode === 'create') {
    rows.push(h('li', { class: 'folder-row editing' }, folderForm({
      label: 'New folder name', submit: 'Create',
      onSubmit: (name) => saveFolder(null, name),
      onCancel: () => closeFolderForm('#folder-add'),
    })));
  } else if (!state.folders.length) {
    rows.push(h('li', { class: 'hint' }, state.folderError || 'Group saves into folders. Use + to make the first one.'));
  } else if (state.folderError) rows.push(h('li', { class: 'hint' }, state.folderError));
  $('folder-list').replaceChildren(...rows);
  $('folder-add').disabled = state.folderMode === 'create';
}

function closeFolderForm(focusSel) {
  state.folderMode = null; state.folderError = ''; state.pendingMove = null; draft = null;
  renderFolders();
  document.querySelector(focusSel)?.focus();
}

function startCreate(forItem = null) {
  state.folderMode = 'create'; state.folderError = ''; state.pendingMove = forItem; draft = null;
  renderFolders();
  $('folder-list').lastElementChild?.scrollIntoView({ block: 'nearest' });
}

async function saveFolder(id, name) {
  try {
    if (id) {
      await api.renameFolder(id, name);
      toast('Folder renamed');
    } else {
      const f = await api.createFolder(name);
      if (state.pendingMove) {
        const item = state.pendingMove;
        await api.moveToFolder([item.id], f.id);
        item.folderId = f.id;
        toast(`Moved to “${f.name}”`);
      } else toast(`Folder “${f.name}” created`);
    }
  } catch (err) {
    state.folderError = err.message; draft = name; // empty or duplicate name: keep the form open
    renderFolders();
    return;
  }
  const moved = state.pendingMove;
  state.folderMode = null; state.folderError = ''; state.pendingMove = null; draft = null;
  await refreshFolders();
  if (moved) { state.folder !== null ? await reload() : rerenderCard(moved); } else renderActive();
  document.querySelector(id ? `[data-rename="${CSS.escape(id)}"]` : '#folder-add')?.focus();
}

/* delete (with confirmation) */
const delDialog = $('folder-delete');
let deleting = null;
function askDelete(f) {
  deleting = f;
  $('folder-delete-title').textContent = `Delete “${f.name}”?`;
  $('folder-delete-body').textContent = f.count
    ? `The ${fmtNum(f.count)} ${f.count === 1 ? 'save' : 'saves'} in this folder won’t be deleted. They’ll move to Unfiled.`
    : 'This folder is empty. Your saves aren’t affected.';
  delDialog.showModal();
}
delDialog.addEventListener('close', async () => {
  const f = deleting, choice = delDialog.returnValue;
  delDialog.returnValue = '';
  if (!f) return;
  deleting = null;
  if (choice !== 'delete') { document.querySelector(`[data-del="${CSS.escape(f.id)}"]`)?.focus(); return; }
  try {
    await api.deleteFolder(f.id);
    if (state.folder === f.id) state.folder = null;
    toast(`Folder “${f.name}” deleted. Its saves were kept.`);
  } catch (err) {
    toast(`Could not delete folder: ${err.message}`);
  }
  await refreshFolders();
  await reload();
  document.querySelector('.folder-btn[aria-pressed="true"]')?.focus();
});

/* move to folder (per card) */
const moveMenu = $('move-menu');
let moveFor = null;

function renderMoveBtn(item) {
  const name = item.folderId ? folderName(item.folderId) : null;
  return h('button', {
    type: 'button', class: `folder-pill${name ? ' is-filed' : ''}`, dataset: { move: item.id }, 'aria-haspopup': 'menu',
    'aria-label': name ? `Folder: ${name}. Change folder` : 'Move to folder',
    onclick: (e) => openMoveMenu(item, e.currentTarget),
  }, ic(name ? 'folder' : 'folder-input', 14), h('span', {}, name ?? 'Move to folder'));
}

function openMoveMenu(item, anchor) {
  moveFor = item;
  const opt = (label, icon, folderId, extra = {}) => {
    const current = folderId !== undefined && (item.folderId ?? null) === folderId;
    return h('button', {
      type: 'button', role: extra.role ?? 'menuitemradio', class: 'menu-item', tabindex: '-1',
      'aria-checked': extra.role ? null : String(current),
      onclick: extra.onclick ?? (() => { moveMenu.hidePopover(); moveItem(item, folderId); }),
    }, ic(icon, 16), h('span', {}, h('b', {}, label)), current ? ic('check', 14) : null);
  };
  moveMenu.replaceChildren(
    h('p', { class: 'menu-note' }, 'Move to folder'),
    opt('No folder', 'inbox', null),
    ...state.folders.map((f) => opt(f.name, 'folder', f.id)),
    h('hr', { class: 'menu-sep' }),
    opt('New folder…', 'folder-plus', undefined, { role: 'menuitem', onclick: () => { moveMenu.hidePopover(); startCreate(item); } }),
  );
  const r = anchor.getBoundingClientRect();
  moveMenu.style.left = `${Math.max(8, Math.min(r.right - 248, innerWidth - 256))}px`;
  moveMenu.style.top = `${r.bottom + 6}px`;
  moveMenu.showPopover();
  const h2 = moveMenu.offsetHeight;
  if (r.bottom + 6 + h2 > innerHeight - 8) moveMenu.style.top = `${Math.max(8, r.top - 6 - h2)}px`; // flip above
  (moveMenu.querySelector('[aria-checked="true"]') ?? moveMenu.querySelector('[role^="menuitem"]'))?.focus();
}

moveMenu.addEventListener('keydown', (e) => {
  const items = [...moveMenu.querySelectorAll('[role^="menuitem"]')];
  const i = items.indexOf(document.activeElement);
  const to = { ArrowDown: (i + 1) % items.length, ArrowUp: (i - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  items[to].focus();
});

async function moveItem(item, folderId) {
  if ((item.folderId ?? null) === folderId) return;
  try {
    await api.moveToFolder([item.id], folderId);
  } catch (err) {
    toast(`Could not move: ${err.message}`);
    return;
  }
  item.folderId = folderId;
  await refreshFolders();
  const stays = state.folder === null || (state.folder === 'none' ? folderId === null : state.folder === folderId);
  if (stays) rerenderCard(item); else await reload();
  toast(folderId ? `Moved to “${folderName(folderId)}”` : 'Removed from folder');
  const btn = $('cards').querySelector(`[data-move="${CSS.escape(item.id)}"]`);
  (btn ?? document.querySelector('.folder-btn[aria-pressed="true"]'))?.focus();
}

/* ---------- data flow ---------- */
let seq = 0;
async function reload() {
  const mine = ++seq;
  try {
    const [res, facets] = await Promise.all([
      api.getItems({ ...filterParams(), sort: state.sort, offset: 0, limit: PAGE }),
      api.getFacets(filterParams()),
    ]);
    if (mine !== seq) return; // a newer request superseded this one
    Object.assign(state, { items: res.items, matched: res.matched, total: res.total, allTags: facets.allTags });
    renderFolders();
    renderTypeSeg(facets.types);
    renderSubs(facets.subreddits);
    renderTagFilters(facets.tags);
    renderActive();
    renderList();
  } catch (err) {
    $('empty').hidden = false;
    fill($('empty'), ic('cloud-off', 32), h('h3', {}, 'Could not load your library'), h('p', {}, err.message));
  }
}

async function loadMore() {
  const res = await api.getItems({ ...filterParams(), sort: state.sort, offset: state.items.length, limit: PAGE });
  state.items.push(...res.items);
  renderList({ append: true });
}

async function refreshPlan() {
  state.plan = await api.getPlan();
  renderBanner();
}

async function editTag(item, op, tag) {
  try {
    item.tags = await (op === 'add' ? api.addTag(item.id, tag) : api.removeTag(item.id, tag));
    const facets = await api.getFacets(filterParams());
    state.allTags = facets.allTags;
    renderTagFilters(facets.tags);
    if (state.tags.size && ![...state.tags].every((t) => item.tags.includes(t))) { await reload(); return; }
    rerenderCard(item);
  } catch (err) {
    console.error(err);
    rerenderCard(item);
  }
}

function clearAll() {
  Object.assign(state, { query: '', type: 'all', preset: 'any', from: null, to: null, folder: null });
  state.subreddits.clear(); state.tags.clear();
  $('q').value = ''; $('date-preset').value = 'any'; $('date-custom').hidden = true;
  reload();
}

/* ---------- events ---------- */
$('q').value = state.query;
$('q').addEventListener('input', debounce((e) => { state.query = e.target.value; reload(); }));
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; reload(); });
$('sub-filter').addEventListener('input', (e) => { state.subFilter = e.target.value; reload(); });
$('subs-more').addEventListener('click', () => { state.showAllSubs = !state.showAllSubs; reload(); });
$('more').addEventListener('click', loadMore);
$('folder-add').addEventListener('click', () => startCreate());
$('clear').addEventListener('click', clearAll);
$('date-preset').addEventListener('change', (e) => {
  state.preset = e.target.value;
  $('date-custom').hidden = state.preset !== 'custom';
  reload();
});
const setDate = () => {
  const f = $('date-from').value, t = $('date-to').value;
  state.from = f ? new Date(f + 'T00:00:00').getTime() : null;
  state.to = t ? new Date(t + 'T23:59:59').getTime() : null;
  reload();
};
$('date-from').addEventListener('change', setDate);
$('date-to').addEventListener('change', setDate);

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); $('q').focus(); }
});

$('sync-btn').addEventListener('click', async () => { $('sync').classList.add('is-syncing'); await api.syncNow(); await Promise.all([renderSync(), refreshPlan(), reload()]); });

// Export menu: anchor under the button, export what is currently shown (search + filters).
const menu = $('export-menu');
menu.addEventListener('beforetoggle', (e) => {
  if (e.newState !== 'open') return;
  const r = $('export-btn').getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, r.right - 264)}px`;
  $('export-note').textContent = hasFilters() || state.query
    ? `Exports the ${fmtNum(state.matched)} saves matching your search and filters.`
    : `Exports all ${fmtNum(state.total)} saved items.`;
});
menu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-format]');
  if (!btn) return;
  menu.hidePopover();
  try { api.download(await api.exportItems(filterParams(), btn.dataset.format)); } catch (err) { alert('Export failed: ' + err.message); }
});

// Upsell dialog result
const upsell = $('upsell');
upsell.addEventListener('close', async () => {
  const choice = upsell.returnValue;
  upsell.returnValue = '';
  if (choice !== 'upgrade') return;
  try { await api.upgrade(); } catch (err) { alert('Could not open checkout: ' + err.message); }
  await Promise.all([refreshPlan(), reload()]);
});

api.onChange(() => Promise.all([renderSync(), refreshPlan(), refreshFolders(), reload()]));

await Promise.all([refreshPlan(), renderSync(), refreshFolders(), reload()]);
if (new URLSearchParams(location.search).get('upsell') === '1') upsell.showModal();

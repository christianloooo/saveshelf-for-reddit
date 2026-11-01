/**
 * Data API used by every UI page (popup + library). The UI never touches storage directly.
 *
 * Inside the extension every call is forwarded to the service worker as
 *   chrome.runtime.sendMessage({ ns: 'saveshelf', method, args })
 * and must be answered with { ok: true, result } or { ok: false, error: string }.
 * Outside the extension (opening ui/library.html from a static server) a stand-in backend is used so the UI can
 * be developed and screenshotted without the service worker; that code is removed from the packaged build.
 *
 * Full contract (types, semantics): see ../README-ui.md
 */

const NS = 'saveshelf';
const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

// dev-only:start -- stripped from the packaged extension by scripts/package.mjs (the mock never ships)
let mockPromise;
function getMock() {
  mockPromise ??= import('./mock/mock-backend.js').then((m) => m.createMock(new URLSearchParams(location.search)));
  return mockPromise;
}
// dev-only:end

async function call(method, ...args) {
  // dev-only:start
  if (!inExtension) {
    const mock = await getMock();
    return mock[method](...args);
  }
  // dev-only:end
  const res = await chrome.runtime.sendMessage({ ns: NS, method, args });
  if (!res?.ok) throw new Error(res?.error || `Backend did not answer "${method}"`);
  return res.result;
}

/**
 * Items matching search + filters. Params: see README, plus the UI-side `folderId` (a folder id, or 'none' for un-filed).
 * Returns { items, matched, total }; items carry `folderId` (string|null) when called through this module.
 * Folders are layered on top of the backend contract here (see "Folders" below), so the backend's getItems is unchanged.
 */
export async function getItems(params = {}) {
  const { folderId, ...rest } = params;
  const assigned = await folderAssignments();
  const tag = (items) => items.map((i) => ({ ...i, folderId: assigned.get(i.id) ?? null }));
  if (!folderId) return call('getItems', rest).then((r) => ({ ...r, items: tag(r.items) }));
  const inScope = scopeTest(folderId, assigned);
  const { offset = 0, limit, ...unpaged } = rest;
  const all = await call('getItems', unpaged);
  const hits = all.items.filter(inScope);
  return { items: tag(hits.slice(offset, limit == null ? undefined : offset + limit)), matched: hits.length, total: all.total };
}
/** Alias kept for readability at call sites: free-text search is `params.query`. */
export const search = (query, params = {}) => call('getItems', { ...params, query });
/** The N most recently saved items (newest first). */
export const getRecent = (limit = 5) => call('getItems', { sort: 'saved-desc', limit }).then((r) => r.items);
/** Counts for the filter UI: { subreddits:[{name,count}], tags:[{name,count}], types:{post,comment} }. Honours `folderId` like getItems. */
export async function getFacets(params = {}) {
  const { folderId, ...rest } = params;
  if (!folderId) return call('getFacets', rest);
  // The backend does not know about folders: rebuild each facet from the folder's items (a facet ignores its own filter).
  const inScope = scopeTest(folderId, await folderAssignments());
  const base = async (omit) => (await call('getItems', { ...rest, [omit]: undefined })).items.filter(inScope);
  const tally = (list, pick) => {
    const m = new Map();
    for (const i of list) for (const k of pick(i)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  const [subs, tags, types, all] = await Promise.all([base('subreddits'), base('tags'), base('type'), call('getFacets', {})]);
  return {
    subreddits: tally(subs, (i) => [i.subreddit]),
    tags: tally(tags, (i) => i.tags),
    allTags: all.allTags,
    types: { post: types.filter((i) => i.type === 'post').length, comment: types.filter((i) => i.type === 'comment').length },
  };
}
export const addTag = (id, tag) => call('addTag', id, tag);
export const removeTag = (id, tag) => call('removeTag', id, tag);
/** { filename, mime, content } - UI turns it into a download. format: 'json' | 'csv'. */
export async function exportItems(params = {}, format = 'json') {
  const { folderId, ...rest } = params;
  if (!folderId) return call('exportItems', rest, format);
  // Export what the user is looking at: filter to the folder's items, then ask the shared formatter.
  const inScope = scopeTest(folderId, await folderAssignments());
  const { items } = await call('getItems', rest);
  const { buildExport } = await import('./export-format.js');
  return buildExport(items.filter(inScope), format === 'csv' ? 'csv' : 'json');
}
/** { plan:'free'|'pro', cap:number|null, count, pending, limitReached, priceLabel } */
export const getPlan = () => call('getPlan');
/** Opens the ExtensionPay checkout. Resolves once the page is opened (not once paid). */
export const upgrade = () => call('upgrade');
/** { state:'idle'|'syncing'|'error'|'needs-login', lastSyncAt:number|null, added:number, progress:{done,total}|null, message?:string } */
export const getSyncStatus = () => call('getSyncStatus');
export const syncNow = () => call('syncNow');

/** Subscribe to backend changes (new items synced, plan changed, tags edited). Returns unsubscribe fn. */
export function onChange(cb) {
  if (!inExtension) return () => {};
  const listener = (msg) => {
    if (msg?.ns === NS && msg.event === 'changed') { assignmentsCache = null; cb(msg); }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** Open the full-page library, optionally pre-searching. Works in and out of the extension. */
export function openLibraryUrl(query = '') {
  const path = 'library.html' + (query ? `?q=${encodeURIComponent(query)}` : '');
  return inExtension ? chrome.runtime.getURL(`ui/${path}`) : path + (location.search && !query ? location.search : '');
}

/** Trigger a browser download from an exportItems() result. */
export function download({ filename, mime, content }) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ---------------------------------------------------------------------------------------------------------------
 * Folders
 * The UI contract (README-ui.md) has no folder methods, but the data layer does (src/lib/api.js -> api.folders.*).
 * Extension pages share the extension's IndexedDB, so inside the extension the library page talks to that API directly
 * (the options page does the same). Item -> folder assignments are read from it and applied here, client-side.
 * Outside the extension a small in-memory stand-in is used (a development stand-in that is stripped from the package).
 * --------------------------------------------------------------------------------------------------------------- */

/** @typedef {{id:string, name:string, count:number}} Folder */

let providerPromise;
let assignmentsCache = null;

function provider() {
  providerPromise ??= (async () => {
    // dev-only:start
    if (!inExtension) {
      const m = await import('./mock/mock-folders.js');
      return m.createMockFolders(new URLSearchParams(location.search), async () => (await getMock()).getItems({ sort: 'saved-desc', limit: 400 }).then((r) => r.items));
    }
    // dev-only:end
    const [{ createApi }, { buildPageDeps }] = await Promise.all([import('../src/lib/api.js'), import('../src/lib/runtime.js')]);
    const depsPromise = buildPageDeps();
    const api = createApi(() => depsPromise);
    // A fresh API object per read: its search index is cached and would not see moves made in other pages.
    const fresh = () => createApi(async () => ({ ...(await depsPromise), channel: undefined }));
    return {
      list: () => api.folders.list(),
      create: (name) => api.folders.create(name),
      rename: (id, name) => api.folders.rename(id, name),
      remove: (id) => api.folders.delete(id),
      move: (ids, folderId) => api.folders.move(ids, folderId),
      async assignments() {
        const folders = await api.folders.list();
        const reader = fresh();
        const map = new Map();
        for (const f of folders) {
          for (let offset = 0, more = true; more; offset += 500) {
            const page = await reader.library.search({ folderId: f.id, limit: 500, offset, sort: 'saved' });
            for (const it of page.items) map.set(it.id, f.id);
            more = page.hasMore;
          }
        }
        return map;
      },
    };
  })();
  return providerPromise;
}

async function folderAssignments() {
  if (!assignmentsCache) {
    assignmentsCache = provider().then((p) => p.assignments()).catch((err) => { assignmentsCache = null; console.error('folders unavailable', err); return new Map(); });
  }
  return assignmentsCache;
}

/** (item) => boolean for a folder filter: a folder id, or 'none' for items in no folder. */
function scopeTest(folderId, assigned) {
  return folderId === 'none' ? (i) => !assigned.has(i.id) : (i) => assigned.get(i.id) === folderId;
}

const notifyFolders = () => {
  if (inExtension) chrome.runtime.sendMessage({ ns: NS, event: 'changed', reason: 'folders' }).catch(() => {});
};

/** All folders with item counts, oldest first. Rejects if the folder store is unavailable. */
export const listFolders = async () => (await provider()).list();
/** Create a folder. Rejects with a readable message for empty / duplicate names. Returns the new folder. */
export async function createFolder(name) {
  const f = await (await provider()).create(name);
  assignmentsCache = null; notifyFolders();
  return f;
}
export async function renameFolder(id, name) {
  const f = await (await provider()).rename(id, name);
  notifyFolders();
  return f;
}
/** Deleting a folder never deletes its items; they become un-filed. */
export async function deleteFolder(id) {
  await (await provider()).remove(id);
  assignmentsCache = null; notifyFolders();
}
/** Put items in a folder; folderId = null takes them out of any folder. */
export async function moveToFolder(ids, folderId) {
  await (await provider()).move(ids, folderId);
  assignmentsCache = null; notifyFolders();
}

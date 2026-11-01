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
 * Items matching search + filters. Params: see README (incl. `folderId`: a folder id, or 'none' for un-filed saves).
 * Returns { items, matched, total }; every item carries `folderId` (string|null).
 */
export const getItems = (params = {}) => call('getItems', params);
/** Alias kept for readability at call sites: free-text search is `params.query`. */
export const search = (query, params = {}) => call('getItems', { ...params, query });
/** The N most recently saved items (newest first). */
export const getRecent = (limit = 5) => call('getItems', { sort: 'saved-desc', limit }).then((r) => r.items);
/** Counts for the filter UI: { subreddits:[{name,count}], tags:[{name,count}], types:{post,comment} }. Honours `folderId` like getItems. */
export const getFacets = (params = {}) => call('getFacets', params);
export const addTag = (id, tag) => call('addTag', id, tag);
export const removeTag = (id, tag) => call('removeTag', id, tag);
/** { filename, mime, content } - UI turns it into a download. format: 'json' | 'csv'. */
export const exportItems = (params = {}, format = 'json') => call('exportItems', params, format);
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
    if (msg?.ns !== NS || msg.event !== 'changed') return;
    // This page already knows about its own folder edits (the worker's broadcast also reaches the sender).
    if (msg.reason === 'folders' && performance.now() - lastOwnFolderEdit < 1000) return;
    cb(msg);
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
 * Folders: plain RPC methods like the rest (see README-ui.md). Items carry `folderId`; getItems / getFacets /
 * exportItems take a `folderId` filter (a folder id, or 'none' for un-filed saves).
 * --------------------------------------------------------------------------------------------------------------- */

/** @typedef {{id:string, name:string, createdAt:number, count:number}} Folder */

let lastOwnFolderEdit = -Infinity;
async function folderCall(method, ...args) {
  lastOwnFolderEdit = performance.now();
  try { return await call(method, ...args); } finally { lastOwnFolderEdit = performance.now(); }
}

/** All folders with item counts. Rejects if the folder store is unavailable. */
export const listFolders = () => call('listFolders');
/** Create a folder. Rejects with a readable message for empty / duplicate names. Returns the new folder. */
export const createFolder = (name) => folderCall('createFolder', name);
/** Rejects like createFolder (and for an unknown id). Returns the renamed folder. */
export const renameFolder = (id, name) => folderCall('renameFolder', id, name);
/** Deleting a folder never deletes its items; they become un-filed. */
export const deleteFolder = (id) => folderCall('deleteFolder', id);
/** Put items in a folder; folderId = null takes them out of any folder. */
export const moveToFolder = (ids, folderId) => folderCall('moveToFolder', ids, folderId);

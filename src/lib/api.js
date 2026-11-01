// Public data API for the popup / library UI. See docs/DATA_API.md for the full contract.
//
//   import { api } from '../src/lib/api.js';          // in any extension page (popup, library, ...)
//   const { items, total } = await api.library.search({ q: 'rust r/programming', limit: 50 });
//
// Every method is async, returns plain JSON-serialisable data, and rejects with a LibraryError
// (`err.code`) on expected failures. The free-tier cap and Pro gating are enforced HERE and in the
// store/sync layers, never in the UI.

import { CONFIG } from '../config.js';
import { LibraryError } from './errors.js';
import { buildIndex, searchIndex, parseQuery, SORTERS } from './search.js';
import { toJSON, toCSV, parseImport } from './export.js';

export { LibraryError } from './errors.js';
export { SYNC_STATUS } from './sync.js';

const DEFAULT_SETTINGS = Object.freeze({ autoSync: false, autoSyncHours: CONFIG.AUTO_SYNC_DEFAULT_HOURS });
const dayStamp = (ms) => new Date(ms).toISOString().slice(0, 10);
const clampInt = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.trunc(Number(v)))) : d);

/**
 * Build the API from injected dependencies. Production wiring is in runtime.js; tests inject fakes.
 * @param {() => Promise<object>} getDeps resolves { store, license, analytics, syncer?, remoteSync?,
 *   kv, stateKv, channel?, version, onSettingsChanged?, now? }
 */
export function createApi(getDeps) {
  let depsPromise;
  const deps = () => (depsPromise ??= getDeps().then((d) => {
    d.channel?.addEventListener?.('message', (e) => {
      if (e.data?.type === 'changed') index = null;
    });
    return d;
  }));

  let index = null; // { built, folderNames, idx }

  async function changed(what) {
    index = null;
    const d = await deps();
    try {
      d.channel?.postMessage?.({ type: 'changed', what });
    } catch {
      /* channel closed */
    }
  }

  async function getIndex() {
    const d = await deps();
    if (!index) {
      const [items, folders] = await Promise.all([d.store.allItems(), d.store.listFolders()]);
      const folderNames = new Map(folders.map((f) => [f.id, f.name]));
      index = { folderNames, idx: buildIndex(items, { folderNames }) };
    }
    return index;
  }

  const decorate = (it, folderNames) => ({ ...it, folderName: it.folderId ? folderNames.get(it.folderId) ?? null : null });

  // ---- library -----------------------------------------------------------------------------
  const library = {
    /**
     * Search + filter + sort + paginate.
     * @param {{q?:string, sort?:'relevance'|'saved'|'saved-asc'|'created'|'created-asc'|'score'|'title',
     *   folderId?:string|null|'none', tag?:string, kind?:'post'|'comment', subreddit?:string,
     *   limit?:number, offset?:number}} [opts]  folderId: a folder id, or 'none' for un-filed items.
     * @returns {Promise<{items:object[], total:number, offset:number, limit:number, hasMore:boolean}>}
     */
    async search(opts = {}) {
      const { q = '', sort, folderId, tag, kind, subreddit } = opts;
      const limit = clampInt(opts.limit, 1, 500, 50);
      const offset = clampInt(opts.offset, 0, 1e9, 0);
      const { idx, folderNames } = await getIndex();
      const parsed = parseQuery(q);
      const hasText = parsed.terms.length > 0 || parsed.phrases.length > 0;
      let { items } = searchIndex(idx, parsed);

      if (folderId === 'none') items = items.filter((i) => !i.folderId);
      else if (typeof folderId === 'string') items = items.filter((i) => i.folderId === folderId);
      if (tag) items = items.filter((i) => i.tags?.includes(String(tag).toLowerCase().trim()));
      if (kind) items = items.filter((i) => i.kind === kind);
      if (subreddit) items = items.filter((i) => i.subreddit.toLowerCase() === String(subreddit).replace(/^r\//i, '').toLowerCase());

      const mode = sort ?? (hasText ? 'relevance' : 'saved');
      if (mode !== 'relevance' && SORTERS[mode]) items = [...items].sort(SORTERS[mode]);
      // ('relevance' keeps searchIndex's ranking)

      const page = items.slice(offset, offset + limit).map((i) => decorate(i, folderNames));
      return { items: page, total: items.length, offset, limit, hasMore: offset + limit < items.length };
    },

    async get(id) {
      const d = await deps();
      const it = await d.store.getItem(id);
      if (!it) return null;
      const { folderNames } = await getIndex();
      return decorate(it, folderNames);
    },

    /** Delete items from the library (and remember them so sync does not silently re-import). */
    async delete(ids) {
      const d = await deps();
      const r = await d.store.deleteItems(ids);
      await changed('items');
      return r;
    },

    /** Forget local deletions so the next sync may re-import them. */
    async restoreDeleted() {
      const d = await deps();
      const r = await d.store.clearTombstones();
      await changed('tombstones');
      return r;
    },

    /** Distinct subreddits with counts, most-saved first. */
    async subreddits() {
      const { idx } = await getIndex();
      const counts = new Map();
      for (const { item } of idx.docs) counts.set(item.subreddit, (counts.get(item.subreddit) ?? 0) + 1);
      return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    },

    /**
     * Counts, cap and tier. `cap` is null for Pro (unlimited).
     * @returns {Promise<{total:number,posts:number,comments:number,cap:number|null,remaining:number|null,atCap:boolean,tier:'free'|'pro',lastSync:object|null,redditUser:string|null,deletedCount:number}>}
     */
    async stats() {
      const d = await deps();
      const items = await d.store.allItems();
      const cap = await d.license.getCap();
      const finite = Number.isFinite(cap);
      const total = items.length;
      return {
        total,
        posts: items.filter((i) => i.kind === 'post').length,
        comments: items.filter((i) => i.kind === 'comment').length,
        cap: finite ? cap : null,
        remaining: finite ? Math.max(0, cap - total) : null,
        atCap: finite && total >= cap,
        tier: (await d.license.isPro()) ? 'pro' : 'free',
        lastSync: (await d.store.getMeta('lastSync', null)) ?? null,
        redditUser: (await d.store.getMeta('redditUser', null)) ?? null,
        deletedCount: await d.store.tombstoneCount(),
      };
    },

    /** Delete EVERYTHING stored locally (items, folders, settings stay). Requires confirm === true. */
    async clearAll({ confirm } = {}) {
      if (confirm !== true) throw new LibraryError('CONFIRM_REQUIRED', 'Pass { confirm: true } to wipe the library');
      const d = await deps();
      await d.store.clearAll();
      await changed('all');
      return { cleared: true };
    },
  };

  // ---- tags --------------------------------------------------------------------------------
  const tags = {
    list: async () => (await deps()).store.listTags(),
    async add(ids, names) {
      const r = await (await deps()).store.addTags(ids, names);
      await changed('tags');
      return r;
    },
    async remove(ids, names) {
      const r = await (await deps()).store.removeTags(ids, names);
      await changed('tags');
      return r;
    },
    /** Replace one item's tags. */
    async set(id, names) {
      const r = await (await deps()).store.setTags(id, names);
      await changed('tags');
      return r;
    },
    async rename(from, to) {
      const r = await (await deps()).store.renameTag(from, to);
      await changed('tags');
      return r;
    },
    /** Remove a tag from every item. */
    async delete(name) {
      const r = await (await deps()).store.deleteTag(name);
      await changed('tags');
      return r;
    },
  };

  // ---- folders -----------------------------------------------------------------------------
  const folders = {
    /** @returns {Promise<{id:string,name:string,createdAt:number,count:number}[]>} */
    list: async () => (await deps()).store.listFolders(),
    async create(name) {
      const r = await (await deps()).store.createFolder(name);
      await changed('folders');
      return r;
    },
    async rename(id, name) {
      const r = await (await deps()).store.renameFolder(id, name);
      await changed('folders');
      return r;
    },
    /** Deleting a folder un-files its items; items are never deleted. */
    async delete(id) {
      const r = await (await deps()).store.deleteFolder(id);
      await changed('folders');
      return r;
    },
    /** Put items in a folder; folderId = null removes them from any folder. */
    async move(ids, folderId) {
      const r = await (await deps()).store.moveToFolder(ids, folderId);
      await changed('folders');
      return r;
    },
  };

  // ---- sync --------------------------------------------------------------------------------
  const sync = {
    /**
     * Start a sync. Resolves when it finishes (may take a minute: pages are fetched politely).
     * In extension pages the work runs in the service worker so it survives the popup closing.
     * @param {{full?: boolean}} [opts] full = re-walk the whole listing instead of stopping at known items
     * @returns {Promise<{status:string, added:number, updated:number, skipped:number, pages:number, fetched:number, user:string|null, error:{code:string,message:string}|null}>}
     *   status: 'ok' | 'capped' | 'not_logged_in' | 'rate_limited' | 'busy' | 'aborted' | 'error'
     */
    async start({ full = false } = {}) {
      const d = await deps();
      const result = d.remoteSync ? await d.remoteSync({ full }) : await d.syncer.run({ full });
      await changed('sync');
      return result;
    },
    /** @returns {Promise<{running:boolean, progress:object|null, last:object|null}>} */
    async status() {
      const d = await deps();
      const progress = (await d.stateKv.get('syncProgress', null)) ?? null;
      // a worker killed mid-sync leaves running:true behind; treat old progress as stale
      const fresh = progress?.running && (d.now?.() ?? Date.now()) - (progress.at ?? 0) < 2 * 60 * 1000;
      return {
        running: Boolean(d.syncer?.isRunning?.()) || Boolean(fresh),
        progress,
        last: (await d.store.getMeta('lastSync', null)) ?? null,
      };
    },
    /** Subscribe to progress events ({phase:'identify'|'fetching'|'saved'|'waiting'|'done', ...}). Returns unsubscribe(). */
    onProgress(cb) {
      let ch;
      (async () => {
        const d = await deps();
        ch = d.progressChannel;
        ch?.addEventListener?.('message', handler);
      })();
      const handler = (e) => cb(e.data);
      return () => ch?.removeEventListener?.('message', handler);
    },
  };

  // ---- export / import ---------------------------------------------------------------------
  async function itemsForExport(opts = {}) {
    const d = await deps();
    let items;
    if (Array.isArray(opts.ids)) items = await d.store.getItems(opts.ids);
    else if (opts.query) {
      const all = await library.search({ ...opts.query, limit: 500, offset: 0 });
      const ids = [];
      let page = all;
      let off = 0;
      for (;;) {
        ids.push(...page.items.map((i) => i.id));
        if (!page.hasMore) break;
        off += 500;
        page = await library.search({ ...opts.query, limit: 500, offset: off });
      }
      items = await d.store.getItems(ids);
    } else items = await d.store.allItems();
    return { items, folders: await d.store.listFolders(), d };
  }

  const exporter = {
    /** Lossless backup (tags, folders, order). opts: { ids?: string[], query?: <library.search opts> } */
    async json(opts = {}) {
      const { items, folders: fl, d } = await itemsForExport(opts);
      const now = d.now?.() ?? Date.now();
      return {
        filename: `saveshelf-${dayStamp(now)}.json`,
        mime: 'application/json',
        content: toJSON(items, fl, { exportedAt: now, appVersion: d.version }),
        count: items.length,
      };
    },
    /** Spreadsheet export. Same options as json(). */
    async csv(opts = {}) {
      const { items, folders: fl, d } = await itemsForExport(opts);
      const now = d.now?.() ?? Date.now();
      return {
        filename: `saveshelf-${dayStamp(now)}.csv`,
        mime: 'text/csv;charset=utf-8',
        content: toCSV(items, fl),
        count: items.length,
      };
    },
  };

  const importer = {
    /**
     * Restore/merge a JSON export. Subject to the free cap.
     * @returns {Promise<{added:number, merged:number, skipped:number, foldersCreated:number, total:number}>}
     */
    async json(text) {
      const d = await deps();
      const data = parseImport(text);
      const r = await d.store.importData(data, { cap: await d.license.getCap() });
      await changed('import');
      return r;
    },
  };

  // ---- license -----------------------------------------------------------------------------
  const license = {
    /** @returns {Promise<{tier:'free'|'pro', paid:boolean, source:string, stub:boolean, checkedAt:number|null, cap:number|null, priceUsd:number}>} */
    async status() {
      const d = await deps();
      const s = await d.license.status();
      const cap = await d.license.getCap();
      return { ...s, cap: Number.isFinite(cap) ? cap : null, priceUsd: CONFIG.PRO_PRICE_USD };
    },
    /** Re-check entitlement with the license provider (network in real mode). */
    async refresh() {
      const d = await deps();
      await d.license.refresh();
      return license.status();
    },
    /** Open the payment page (real mode) or report that payments are stubbed. */
    async upgrade() {
      const d = await deps();
      return d.license.startUpgrade();
    },
    /** Test mode only (STUB_LICENSE = true): toggle local Pro. Throws otherwise. */
    async setStubPro(enabled) {
      const d = await deps();
      await d.license.setStubPro(enabled);
      await changed('license');
      return license.status();
    },
  };

  // ---- settings / analytics ----------------------------------------------------------------
  const settings = {
    /** @returns {Promise<{autoSync:boolean, autoSyncHours:number, analyticsOptIn:boolean}>} */
    async get() {
      const d = await deps();
      const s = { ...DEFAULT_SETTINGS, ...((await d.kv.get('settings', {})) ?? {}) };
      return { autoSync: Boolean(s.autoSync), autoSyncHours: s.autoSyncHours, analyticsOptIn: await d.analytics.isEnabled() };
    },
    async set(patch = {}) {
      const d = await deps();
      const cur = { ...DEFAULT_SETTINGS, ...((await d.kv.get('settings', {})) ?? {}) };
      if ('autoSync' in patch) cur.autoSync = Boolean(patch.autoSync);
      if ('autoSyncHours' in patch) cur.autoSyncHours = clampInt(patch.autoSyncHours, 1, 168, DEFAULT_SETTINGS.autoSyncHours);
      await d.kv.set('settings', cur);
      if ('analyticsOptIn' in patch) await d.analytics.setEnabled(Boolean(patch.analyticsOptIn));
      await d.onSettingsChanged?.();
      return settings.get();
    },
    /** The exact payload an analytics event would carry (for transparency in the UI). */
    analyticsPreview: async () => (await deps()).analytics.preview('active'),
  };

  return { library, tags, folders, sync, export: exporter, import: importer, license, settings, config: CONFIG };
}

// Default instance for extension pages. Wiring lives in runtime.js and is loaded lazily so this
// module stays importable from tests / node without chrome.* present.
export const api = createApi(async () => (await import('./runtime.js')).buildPageDeps());

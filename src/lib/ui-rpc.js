// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Handlers for the UI contract owned by leuifrontend (ui/README-ui.md, ui/api.js).
// The UI sends chrome.runtime.sendMessage({ns:'saveshelf', method, args}); the service worker
// maps that to these handlers via registerUiRpc(handlers) from ui/sw-bridge.js.
//
//   getItems getFacets addTag removeTag exportItems getPlan upgrade getSyncStatus syncNow
//   listFolders createFolder renameFolder deleteFolder moveToFolder
//
// Pure of chrome.*: all I/O goes through injected deps so the same code is tested in node against
// fake-indexeddb, side by side with the UI's stand-in backend (tests/ui-contract.test.js).

import { CONFIG } from '../config.js';
import { SYNC_STATUS } from './sync.js';
import { buildExport } from '../../ui/export-format.js';

export const MAX_UI_TAG = 32;
export const SNIPPET_CHARS = 300;
const EST_TOTAL = 1000; // Reddit exposes roughly the latest 1,000 saves

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

/** Contract tag rule: trim, lowercase, whitespace -> '-', max 32 chars. */
export function uiTag(raw) {
  return String(raw ?? '')
    .normalize('NFKC').trim().toLowerCase()
    .replace(/[,;\s]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, MAX_UI_TAG);
}

/** Library item -> UI Item (exact key set from the contract; no internals leak). */
export function toUiItem(it) {
  let body = String(it.body ?? '').replace(/\s+/g, ' ').trim();
  // link posts have no text: show where they point instead of an empty card
  if (!body && it.kind === 'post' && it.url) body = it.url;
  const savedAt = Math.floor((it.seq ?? 0) / 1000);
  return {
    id: it.id,
    type: it.kind,
    title: it.title || (it.kind === 'comment' ? `Comment in r/${it.subreddit}` : '(untitled)'),
    subreddit: it.subreddit,
    author: it.author,
    url: it.permalink,
    snippet: body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS - 1)}…` : body,
    score: it.score ?? 0,
    numComments: it.numComments ?? 0,
    savedAt,
    createdAt: it.createdAt ?? 0,
    tags: [...(it.tags ?? [])],
    folderId: it.folderId ?? null, // id of the folder it is filed in, or null
  };
}

const SORTERS = {
  'saved-desc': (a, b) => b._seq - a._seq,
  'saved-asc': (a, b) => a._seq - b._seq,
  'score-desc': (a, b) => b.score - a.score || b._seq - a._seq,
  'posted-desc': (a, b) => b.createdAt - a.createdAt || b._seq - a._seq,
};

function matcher(p) {
  const words = fold(p.query ?? '').split(/\s+/).filter(Boolean);
  const subs = p.subreddits?.length ? new Set(p.subreddits) : null;
  return (i) => {
    if (p.type && p.type !== 'all' && i.type !== p.type) return false;
    if (subs && !subs.has(i.subreddit)) return false;
    if (p.tags?.length && !p.tags.every((t) => i.tags.includes(t))) return false;
    if (p.folderId != null && (p.folderId === 'none' ? i.folderId !== null : i.folderId !== p.folderId)) return false;
    if (p.from != null && i.savedAt < p.from) return false;
    if (p.to != null && i.savedAt > p.to) return false;
    if (words.length && !words.every((w) => i._hay.includes(w))) return false;
    return true;
  };
}

/**
 * @param {() => Promise<object>} getDeps  { store, license, syncer, stateKv, [now] }
 * @param {{notifyChanged?: (reason?: string) => void}} [hooks]
 */
export function createUiHandlers(getDeps, { notifyChanged = () => {} } = {}) {
  async function load() {
    const d = await getDeps();
    const raw = await d.store.allItems();
    return raw.map((r) => {
      const it = toUiItem(r);
      // full body (not just the 300-char snippet) is searchable
      Object.defineProperty(it, '_hay', { enumerable: false, value: fold([r.title, r.body, r.subreddit, r.author, r.domain, ...(r.tags ?? [])].join(' \n ')) });
      Object.defineProperty(it, '_seq', { enumerable: false, value: r.seq ?? 0 });
      return it;
    });
  }

  const tally = (list, pick) => {
    const m = new Map();
    for (const i of list) for (const k of pick(i)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  async function planInfo() {
    const d = await getDeps();
    const pro = await d.license.isPro();
    const count = await d.store.count();
    const cap = pro ? null : CONFIG.FREE_CAP;
    return {
      plan: pro ? 'pro' : 'free',
      cap,
      count,
      pending: pro ? 0 : Number(await d.store.getMeta('pending', 0)) || 0,
      limitReached: !pro && count >= cap,
      priceLabel: `$${CONFIG.PRO_PRICE_USD} one-time`,
    };
  }

  /** After a free -> Pro flip: backfill what the cap kept out, then tell the UI. */
  async function onPlanMaybeChanged(before) {
    const d = await getDeps();
    const after = await planInfo();
    if (before.plan !== after.plan) {
      notifyChanged('plan');
      if (after.plan === 'pro') {
        d.syncer.run().then(() => notifyChanged('sync'), () => {}); // fire and forget; progress is persisted
      }
    }
    return after;
  }

  const handlers = {
    async getItems(p = {}) {
      const all = await load();
      const sort = SORTERS[p.sort ?? 'saved-desc'] ?? SORTERS['saved-desc'];
      const hits = all.filter(matcher(p)).sort(sort);
      const start = Math.max(0, p.offset ?? 0);
      const end = p.limit == null ? undefined : start + Math.max(0, p.limit);
      return { items: hits.slice(start, end), matched: hits.length, total: all.length };
    },

    async getFacets(p = {}) {
      const all = await load();
      // each facet's counts ignore that facet's own filter, so users can broaden a selection
      const base = (omit) => all.filter(matcher({ ...p, [omit]: undefined }));
      const typeBase = base('type');
      return {
        subreddits: tally(base('subreddits'), (i) => [i.subreddit]),
        tags: tally(base('tags'), (i) => i.tags),
        allTags: tally(all, (i) => i.tags).map((t) => t.name).sort(),
        types: { post: typeBase.filter((i) => i.type === 'post').length, comment: typeBase.filter((i) => i.type === 'comment').length },
      };
    },

    async addTag(id, tag) {
      const d = await getDeps();
      const t = uiTag(tag);
      const cur = await d.store.getItem(id);
      if (!cur) return [];
      if (t) await d.store.addTags([id], [t]);
      notifyChanged('tags');
      return (await d.store.getItem(id))?.tags ?? [];
    },

    async removeTag(id, tag) {
      const d = await getDeps();
      if (!(await d.store.getItem(id))) return [];
      await d.store.removeTags([id], [String(tag ?? '').trim().toLowerCase()]);
      notifyChanged('tags');
      return (await d.store.getItem(id))?.tags ?? [];
    },

    /** Export is free on every tier. */
    async exportItems(p = {}, format = 'json') {
      const all = await load();
      const hits = all.filter(matcher(p)).sort(SORTERS['saved-desc']);
      // the export file format is unchanged: folderId is an opaque id, folders travel in the options-page backup
      return buildExport(hits.map(({ folderId, ...rest }) => rest), format === 'csv' ? 'csv' : 'json');
    },

    // ---- folders ------------------------------------------------------------------------------
    // Errors are LibraryError with readable messages (empty / duplicate name, unknown folder); the bridge relays them.
    async listFolders() {
      return (await getDeps()).store.listFolders();
    },
    async createFolder(name) {
      const f = await (await getDeps()).store.createFolder(name);
      notifyChanged('folders');
      return f;
    },
    async renameFolder(id, name) {
      const f = await (await getDeps()).store.renameFolder(id, name);
      notifyChanged('folders');
      return f;
    },
    /** Deleting a folder never deletes its items; they become un-filed. */
    async deleteFolder(id) {
      await (await getDeps()).store.deleteFolder(id);
      notifyChanged('folders');
    },
    /** folderId = null takes the items out of any folder. */
    async moveToFolder(ids, folderId = null) {
      await (await getDeps()).store.moveToFolder(ids, folderId);
      notifyChanged('folders');
    },

    async getPlan() {
      const d = await getDeps();
      const before = await planInfo();
      if (before.plan === 'free') {
        const st = await d.license.status();
        // real mode: the UI re-reads the plan after the checkout page closes -> re-verify (rate-limited)
        if (!st.stub && (d.now?.() ?? Date.now()) - (st.checkedAt ?? 0) > 30_000) {
          await d.license.refresh().catch(() => {});
          return onPlanMaybeChanged(before);
        }
      }
      return before;
    },

    async upgrade() {
      const d = await getDeps();
      const before = await planInfo();
      const r = await d.license.startUpgrade();
      if (r.stub) {
        // Stub build: no payment exists, so the button flips the local test flag so the whole Pro
        // path (cap lifted + backfill) is demonstrable. Real mode opens the ExtensionPay page instead.
        await d.license.setStubPro(true);
        await onPlanMaybeChanged(before);
        return { opened: false, stub: true };
      }
      return { opened: true, stub: false };
    },

    async getSyncStatus() {
      const d = await getDeps();
      const running = Boolean(d.syncer.isRunning());
      const progress = (await d.stateKv.get('syncProgress', null)) ?? null;
      const last = (await d.store.getMeta('lastSync', null)) ?? null;
      const lastOkAt = (await d.store.getMeta('lastOkAt', null)) ?? null;
      const staleness = (d.now?.() ?? Date.now()) - (progress?.at ?? 0);
      const live = running || Boolean(progress?.running && staleness < 2 * 60 * 1000);
      const base = { lastSyncAt: lastOkAt, added: last?.added ?? 0, total: await d.store.count(), progress: null };
      if (live) {
        const done = Math.max(0, progress?.fetched ?? 0);
        return { ...base, state: 'syncing', progress: { done, total: Math.max(done, EST_TOTAL) } };
      }
      switch (last?.status) {
        case SYNC_STATUS.NOT_LOGGED_IN:
          return { ...base, state: 'needs-login', message: 'Sign in to Reddit in this browser to sync.' };
        case SYNC_STATUS.RATE_LIMITED:
          return { ...base, state: 'error', message: 'Reddit asked us to slow down. Try again in a few minutes.' };
        case SYNC_STATUS.ERROR:
          return { ...base, state: 'error', message: last.error?.message ?? 'Sync failed.' };
        default:
          return { ...base, state: 'idle' };
      }
    },

    async syncNow() {
      const d = await getDeps();
      const before = await planInfo();
      // real mode: pick up a purchase made on the ExtensionPay page since the last check
      if (before.plan === 'free') await d.license.refresh().catch(() => {});
      await d.syncer.run();
      notifyChanged('sync');
      if ((await planInfo()).plan !== before.plan) notifyChanged('plan');
      return handlers.getSyncStatus();
    },
  };
  return handlers;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Repository over IndexedDB: items, folders, tags, tombstones, meta.
// All free-tier cap enforcement happens in the write paths that ADD items (upsertItems, importData),
// inside the same transaction as the insert, so the cap cannot be raced past.

import { STORES, withTx, getAll, getOne, putOne, countAll, reqToPromise } from './db.js';
import { LibraryError } from './errors.js';
import { isRemovedBody } from './normalize.js';

export const MAX_TAGS_PER_ITEM = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_FOLDER_NAME = 60;

const CONTENT_FIELDS = [
  'kind', 'title', 'body', 'url', 'domain', 'permalink', 'subreddit', 'author',
  'score', 'numComments', 'createdAt', 'nsfw', 'flair',
];

export function normalizeTag(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[,;\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}

export function normalizeTags(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_TAGS_PER_ITEM);
}

function mergeExisting(old, incoming, now) {
  const merged = { ...old };
  if (incoming.removedOnReddit && !old.removedOnReddit) {
    // Reddit now reports the content as removed/deleted: keep the copy we already have.
    merged.removedOnReddit = true;
    merged.score = incoming.score;
  } else if (incoming.removedOnReddit && old.removedOnReddit) {
    merged.score = incoming.score;
  } else {
    for (const f of CONTENT_FIELDS) if (incoming[f] !== undefined) merged[f] = incoming[f];
    merged.removedOnReddit = false;
    // A post whose body was blanked but not flagged: never replace real text with a placeholder.
    if (isRemovedBody(incoming.body) && old.body && !isRemovedBody(old.body)) merged.body = old.body;
  }
  merged.lastSyncedAt = now;
  return merged;
}

export function createStore(db, { now = () => Date.now(), uuid = () => crypto.randomUUID() } = {}) {
  const S = STORES;


  // ---- items -------------------------------------------------------------------------------
  /**
   * Insert new items / refresh existing ones. `items` must be ordered NEWEST-SAVED FIRST and each
   * should carry a `seq` (higher = saved more recently); a missing seq is assigned below the
   * current minimum.
   * @returns {{added:number, updated:number, skipped:number, ignored:number, known:number, total:number}}
   *   skipped = new items refused by the cap (ids in skippedIds); ignored = locally-deleted (tombstoned) ids;
   *   known = updated + ignored (items we had already seen).
   */
  async function upsertItems(items, { cap = Infinity } = {}) {
    return withTx(db, [S.ITEMS, S.TOMBSTONES], 'readwrite', async (st) => {
      let count = await countAll(st[S.ITEMS]);
      const t = now();
      let added = 0, updated = 0, skipped = 0, ignored = 0;
      const skippedIds = [];
      for (const incoming of items) {
        if (await getOne(st[S.TOMBSTONES], incoming.id)) {
          ignored += 1;
          continue;
        }
        const old = await getOne(st[S.ITEMS], incoming.id);
        if (old) {
          await putOne(st[S.ITEMS], mergeExisting(old, incoming, t));
          updated += 1;
        } else if (count < cap) {
          await putOne(st[S.ITEMS], {
            ...incoming,
            tags: normalizeTags(incoming.tags),
            folderId: incoming.folderId ?? null,
            seq: incoming.seq ?? t * 1000,
            firstSyncedAt: t,
            lastSyncedAt: t,
          });
          count += 1;
          added += 1;
        } else {
          skipped += 1;
          skippedIds.push(incoming.id);
        }
      }
      return { added, updated, skipped, skippedIds, ignored, known: updated + ignored, total: count };
    });
  }

  const count = () => withTx(db, S.ITEMS, 'readonly', (st) => countAll(st[S.ITEMS]));
  const getItem = (id) => withTx(db, S.ITEMS, 'readonly', (st) => getOne(st[S.ITEMS], id));
  const allItems = () => withTx(db, S.ITEMS, 'readonly', (st) => getAll(st[S.ITEMS]));

  async function getItems(ids) {
    return withTx(db, S.ITEMS, 'readonly', async (st) => {
      const out = [];
      for (const id of ids) {
        const it = await getOne(st[S.ITEMS], id);
        if (it) out.push(it);
      }
      return out;
    });
  }

  async function existingIds(ids) {
    const found = await getItems(ids);
    return new Set(found.map((i) => i.id));
  }

  /** Delete items. Adds tombstones so a later sync does not silently re-import them. */
  async function deleteItems(ids, { tombstone = true } = {}) {
    return withTx(db, [S.ITEMS, S.TOMBSTONES], 'readwrite', async (st) => {
      let deleted = 0;
      for (const id of ids) {
        if (await getOne(st[S.ITEMS], id)) {
          await reqToPromise(st[S.ITEMS].delete(id));
          deleted += 1;
        }
        if (tombstone) await putOne(st[S.TOMBSTONES], { id, at: now() });
      }
      return { deleted };
    });
  }

  const tombstoneCount = () => withTx(db, S.TOMBSTONES, 'readonly', (st) => countAll(st[S.TOMBSTONES]));
  async function clearTombstones() {
    return withTx(db, S.TOMBSTONES, 'readwrite', async (st) => {
      const n = await countAll(st[S.TOMBSTONES]);
      await reqToPromise(st[S.TOMBSTONES].clear());
      return { cleared: n };
    });
  }

  async function mutateItems(ids, mutator) {
    return withTx(db, S.ITEMS, 'readwrite', async (st) => {
      let changed = 0;
      for (const id of ids) {
        const it = await getOne(st[S.ITEMS], id);
        if (!it) continue;
        const next = mutator(structuredClone(it));
        if (next) {
          await putOne(st[S.ITEMS], next);
          changed += 1;
        }
      }
      return { changed };
    });
  }

  // ---- tags --------------------------------------------------------------------------------
  const setTags = (id, tags) =>
    mutateItems([id], (it) => ({ ...it, tags: normalizeTags(tags) }));

  const addTags = (ids, tags) => {
    const add = normalizeTags(tags);
    return mutateItems(ids, (it) => ({ ...it, tags: normalizeTags([...(it.tags ?? []), ...add]) }));
  };

  const removeTags = (ids, tags) => {
    const rm = new Set(normalizeTags(tags));
    return mutateItems(ids, (it) => ({ ...it, tags: (it.tags ?? []).filter((t) => !rm.has(t)) }));
  };

  async function listTags() {
    const counts = new Map();
    for (const it of await allItems()) for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, n]) => ({ tag, count: n })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async function renameTag(from, to) {
    const a = normalizeTag(from), b = normalizeTag(to);
    if (!a || !b) throw new LibraryError('INVALID_TAG', 'Tag name is empty');
    const ids = (await allItems()).filter((i) => i.tags?.includes(a)).map((i) => i.id);
    return mutateItems(ids, (it) => ({ ...it, tags: normalizeTags(it.tags.map((t) => (t === a ? b : t))) }));
  }

  async function deleteTag(tag) {
    const a = normalizeTag(tag);
    const ids = (await allItems()).filter((i) => i.tags?.includes(a)).map((i) => i.id);
    return removeTags(ids, [a]);
  }

  // ---- folders -----------------------------------------------------------------------------
  const listFoldersRaw = () => withTx(db, S.FOLDERS, 'readonly', (st) => getAll(st[S.FOLDERS]));

  function cleanFolderName(name) {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME);
    if (!n) throw new LibraryError('INVALID_FOLDER', 'Folder name is empty');
    return n;
  }

  async function createFolder(name) {
    const clean = cleanFolderName(name);
    const existing = await listFoldersRaw();
    if (existing.some((f) => f.name.toLowerCase() === clean.toLowerCase())) {
      throw new LibraryError('FOLDER_EXISTS', `Folder "${clean}" already exists`);
    }
    const folder = { id: `f_${uuid()}`, name: clean, createdAt: now() };
    await withTx(db, S.FOLDERS, 'readwrite', (st) => putOne(st[S.FOLDERS], folder));
    return folder;
  }

  async function renameFolder(id, name) {
    const clean = cleanFolderName(name);
    const existing = await listFoldersRaw();
    const target = existing.find((f) => f.id === id);
    if (!target) throw new LibraryError('NOT_FOUND', 'Folder not found');
    if (existing.some((f) => f.id !== id && f.name.toLowerCase() === clean.toLowerCase())) {
      throw new LibraryError('FOLDER_EXISTS', `Folder "${clean}" already exists`);
    }
    const next = { ...target, name: clean };
    await withTx(db, S.FOLDERS, 'readwrite', (st) => putOne(st[S.FOLDERS], next));
    return next;
  }

  async function deleteFolder(id) {
    return withTx(db, [S.FOLDERS, S.ITEMS], 'readwrite', async (st) => {
      let unassigned = 0;
      const items = await reqToPromise(st[S.ITEMS].index('folderId').getAll(id));
      for (const it of items) {
        await putOne(st[S.ITEMS], { ...it, folderId: null });
        unassigned += 1;
      }
      await reqToPromise(st[S.FOLDERS].delete(id));
      return { unassigned };
    });
  }

  async function listFolders() {
    const [folders, items] = await Promise.all([listFoldersRaw(), allItems()]);
    const counts = new Map();
    for (const it of items) if (it.folderId) counts.set(it.folderId, (counts.get(it.folderId) ?? 0) + 1);
    return folders
      .map((f) => ({ ...f, count: counts.get(f.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Move items into a folder, or out of any folder with folderId = null. */
  async function moveToFolder(ids, folderId) {
    if (folderId !== null) {
      const folders = await listFoldersRaw();
      if (!folders.some((f) => f.id === folderId)) throw new LibraryError('NOT_FOUND', 'Folder not found');
    }
    return mutateItems(ids, (it) => ({ ...it, folderId }));
  }

  // ---- import ------------------------------------------------------------------------------
  /**
   * Merge a previously exported library. New items count against `cap`; existing items just gain
   * the imported tags and (if they have none) the imported folder. Explicit import overrides
   * tombstones.
   * @param {{items:object[], folders:{id:string,name:string}[]}} data
   */
  async function importData({ items, folders = [] }, { cap = Infinity } = {}) {
    // Resolve folders by name first (separate tx; creating a folder is idempotent by name).
    const idMap = new Map();
    let foldersCreated = 0;
    const existing = await listFoldersRaw();
    for (const f of folders) {
      const name = cleanFolderName(f.name);
      const found = existing.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (found) idMap.set(f.id, found.id);
      else {
        const created = await createFolder(name);
        existing.push(created);
        idMap.set(f.id, created.id);
        foldersCreated += 1;
      }
    }
    const ordered = [...items].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    return withTx(db, [S.ITEMS, S.TOMBSTONES], 'readwrite', async (st) => {
      let c = await countAll(st[S.ITEMS]);
      const t = now();
      let added = 0, merged = 0, skipped = 0;
      for (const raw of ordered) {
        const folderId = raw.folderId ? idMap.get(raw.folderId) ?? null : null;
        const old = await getOne(st[S.ITEMS], raw.id);
        if (old) {
          await putOne(st[S.ITEMS], {
            ...old,
            tags: normalizeTags([...(old.tags ?? []), ...(raw.tags ?? [])]),
            folderId: old.folderId ?? folderId,
          });
          merged += 1;
        } else if (c < cap) {
          await reqToPromise(st[S.TOMBSTONES].delete(raw.id));
          await putOne(st[S.ITEMS], {
            ...raw,
            tags: normalizeTags(raw.tags),
            folderId,
            seq: raw.seq ?? t * 1000,
            firstSyncedAt: raw.firstSyncedAt ?? t,
            lastSyncedAt: raw.lastSyncedAt ?? t,
          });
          c += 1;
          added += 1;
        } else {
          skipped += 1;
        }
      }
      return { added, merged, skipped, foldersCreated, total: c };
    });
  }

  // ---- meta --------------------------------------------------------------------------------
  const getMeta = (key, fallback = undefined) =>
    withTx(db, S.META, 'readonly', async (st) => (await getOne(st[S.META], key))?.value ?? fallback);
  const setMeta = (key, value) => withTx(db, S.META, 'readwrite', (st) => putOne(st[S.META], { key, value }));

  /** Wipe everything (items, folders, tombstones, meta). */
  async function clearAll() {
    return withTx(db, [S.ITEMS, S.FOLDERS, S.META, S.TOMBSTONES], 'readwrite', async (st) => {
      for (const n of Object.values(S)) await reqToPromise(st[n].clear());
    });
  }

  return {
    upsertItems, count, getItem, getItems, allItems, existingIds, deleteItems,
    tombstoneCount, clearTombstones,
    setTags, addTags, removeTags, listTags, renameTag, deleteTag,
    createFolder, renameFolder, deleteFolder, listFolders, moveToFolder,
    importData, getMeta, setMeta, clearAll,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers/env.js';
import { normalizeChild } from '../src/lib/normalize.js';
import { makeChildren } from './helpers/fixtures.js';
import { LibraryError } from '../src/lib/errors.js';

const mk = (n, from = 0) => makeChildren(n, from).map((c, i) => ({ ...normalizeChild(c), seq: 1e6 - from - i }));

describe('store', () => {
  it('upserts, keeps user data (tags/folder/seq) on refresh, and enforces the cap atomically', async () => {
    const { store } = await makeEnv();
    const first = await store.upsertItems(mk(10), { cap: 8 });
    expect(first).toMatchObject({ added: 8, skipped: 2, updated: 0, total: 8 });
    expect(await store.count()).toBe(8);
    // newest-first order means the oldest two were refused
    expect(await store.getItem(mk(10)[0].id)).toBeTruthy();
    expect(await store.getItem(mk(10)[9].id)).toBeUndefined();

    const f = await store.createFolder('Later');
    const id = mk(10)[0].id;
    await store.addTags([id], ['Rust', ' rust ', 'To Read']);
    await store.moveToFolder([id], f.id);
    const fresh = { ...mk(1)[0], score: 9999, seq: 5 };
    const r = await store.upsertItems([fresh], { cap: 8 });
    expect(r).toMatchObject({ added: 0, updated: 1 });
    const after = await store.getItem(id);
    expect(after.score).toBe(9999);
    expect(after.tags).toEqual(['rust', 'to read']);
    expect(after.folderId).toBe(f.id);
    expect(after.seq).toBe(mk(10)[0].seq); // seq preserved
  });

  it('never overwrites saved text with a removed/deleted placeholder', async () => {
    const { store } = await makeEnv();
    const orig = { ...mk(1)[0], id: 't3_x1', body: 'precious original text', author: 'bob', title: 'Original title' };
    await store.upsertItems([orig]);
    await store.upsertItems([{ ...orig, body: '[removed]', author: '[deleted]', removedOnReddit: true, score: 5 }]);
    const it = await store.getItem('t3_x1');
    expect(it).toMatchObject({ body: 'precious original text', author: 'bob', title: 'Original title', removedOnReddit: true, score: 5 });
  });

  it('manages tags: normalise, add, remove, rename, delete, count', async () => {
    const { store } = await makeEnv();
    const items = mk(3);
    await store.upsertItems(items);
    const [a, b, c] = items.map((i) => i.id);
    await store.addTags([a, b], ['Alpha', 'beta,gamma']);
    await store.addTags([c], ['alpha']);
    expect(await store.listTags()).toEqual([
      { tag: 'alpha', count: 3 }, { tag: 'beta gamma', count: 2 },
    ]);
    await store.renameTag('alpha', 'omega');
    expect((await store.getItem(c)).tags).toEqual(['omega']);
    await store.removeTags([a], ['omega']);
    expect((await store.getItem(a)).tags).toEqual(['beta gamma']);
    await store.deleteTag('beta gamma');
    expect((await store.listTags()).map((t) => t.tag)).toEqual(['omega']);
    await store.setTags(a, ['x', 'x', 'y']);
    expect((await store.getItem(a)).tags).toEqual(['x', 'y']);
    await expect(store.renameTag('', 'z')).rejects.toMatchObject({ code: 'INVALID_TAG' });
  });

  it('manages folders: unique names, rename, move, delete un-files items', async () => {
    const { store } = await makeEnv();
    const items = mk(4);
    await store.upsertItems(items);
    const f1 = await store.createFolder('  Work  ');
    expect(f1.name).toBe('Work');
    await expect(store.createFolder('work')).rejects.toMatchObject({ code: 'FOLDER_EXISTS' });
    await expect(store.createFolder('   ')).rejects.toBeInstanceOf(LibraryError);
    const f2 = await store.createFolder('Recipes');
    await store.moveToFolder([items[0].id, items[1].id], f1.id);
    await store.moveToFolder([items[2].id], f2.id);
    expect((await store.listFolders()).map((f) => [f.name, f.count])).toEqual([['Recipes', 1], ['Work', 2]]);
    await store.renameFolder(f1.id, 'Projects');
    await expect(store.renameFolder(f1.id, 'recipes')).rejects.toMatchObject({ code: 'FOLDER_EXISTS' });
    await expect(store.moveToFolder([items[0].id], 'f_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.deleteFolder(f1.id);
    expect((await store.getItem(items[0].id)).folderId).toBeNull();
    expect(await store.count()).toBe(4); // items survive folder deletion
    await store.moveToFolder([items[2].id], null);
    expect((await store.getItem(items[2].id)).folderId).toBeNull();
  });

  it('deleting adds tombstones so re-sync ignores them, until cleared', async () => {
    const { store } = await makeEnv();
    const items = mk(3);
    await store.upsertItems(items);
    await store.deleteItems([items[0].id]);
    expect(await store.count()).toBe(2);
    const r = await store.upsertItems(items);
    expect(r).toMatchObject({ added: 0, ignored: 1, updated: 2, known: 3 });
    await store.clearTombstones();
    expect((await store.upsertItems(items)).added).toBe(1);
  });

  it('import merges, remaps folders by name, respects cap and overrides tombstones', async () => {
    const { store } = await makeEnv();
    const items = mk(5).map((i, n) => ({ ...i, tags: n < 2 ? ['t'] : [], folderId: n < 2 ? 'old-f' : null }));
    const r = await store.importData({ items, folders: [{ id: 'old-f', name: 'Imported' }] }, { cap: 4 });
    expect(r).toMatchObject({ added: 4, skipped: 1, foldersCreated: 1 });
    const folders = await store.listFolders();
    expect(folders[0]).toMatchObject({ name: 'Imported', count: 2 });
    expect((await store.getItem(items[0].id)).folderId).toBe(folders[0].id);
    // merge again: no duplicates
    const r2 = await store.importData({ items, folders: [{ id: 'old-f', name: 'imported' }] }, { cap: 4 });
    expect(r2).toMatchObject({ added: 0, merged: 4, foldersCreated: 0 });
    expect(await store.count()).toBe(4);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers/env.js';
import { makeChildren, makeChild } from './helpers/fixtures.js';

describe('data API (integration)', () => {
  it('sync -> stats -> search -> filters -> sort -> pagination', async () => {
    const env = await makeEnv({ children: makeChildren(120), pro: true });
    const res = await env.api.sync.start();
    expect(res).toMatchObject({ status: 'ok', added: 120 });
    const stats = await env.api.library.stats();
    expect(stats).toMatchObject({ total: 120, posts: 96, comments: 24, tier: 'pro', cap: null, redditUser: 'alice' });
    expect(stats.lastSync).toMatchObject({ status: 'ok' });

    const page1 = await env.api.library.search({ limit: 50 });
    expect(page1).toMatchObject({ total: 120, offset: 0, hasMore: true });
    expect(page1.items[0].id).toBe(makeChild(0).data.name); // newest saved first
    const page3 = await env.api.library.search({ limit: 50, offset: 100 });
    expect(page3.items).toHaveLength(20);
    expect(page3.hasMore).toBe(false);

    const q = await env.api.library.search({ q: 'sourdough', kind: 'post' });
    expect(q.total).toBeGreaterThan(0);
    expect(q.items.every((i) => i.kind === 'post' && /sourdough/i.test(i.title + i.body))).toBe(true);
    const sub = await env.api.library.search({ subreddit: 'r/Rust' });
    expect(sub.items.every((i) => i.subreddit === 'rust')).toBe(true);
    const byScore = await env.api.library.search({ sort: 'score', limit: 3 });
    expect(byScore.items.map((i) => i.score)).toEqual([...byScore.items.map((i) => i.score)].sort((a, b) => b - a));
    const subs = await env.api.library.subreddits();
    expect(subs.reduce((n, s) => n + s.count, 0)).toBe(120);
  });

  it('tags + folders flow through search filters and keep the index fresh', async () => {
    const env = await makeEnv({ children: makeChildren(30), pro: true });
    await env.api.sync.start();
    const first = (await env.api.library.search({ limit: 3 })).items;
    await env.api.tags.add([first[0].id, first[1].id], ['Must Read']);
    expect((await env.api.library.search({ tag: 'must read' })).total).toBe(2);
    expect((await env.api.library.search({ q: 'tag:"must read"' })).total).toBe(2);
    await env.api.tags.remove([first[1].id], ['must read']);
    expect((await env.api.library.search({ tag: 'must read' })).total).toBe(1);
    await env.api.tags.rename('must read', 'done');
    expect((await env.api.tags.list())).toEqual([{ tag: 'done', count: 1 }]);

    const f = await env.api.folders.create('Inbox');
    await env.api.folders.move([first[0].id, first[2].id], f.id);
    const inFolder = await env.api.library.search({ folderId: f.id });
    expect(inFolder.items.map((i) => i.folderName)).toEqual(['Inbox', 'Inbox']);
    expect((await env.api.library.search({ q: 'folder:inbox' })).total).toBe(2);
    expect((await env.api.library.search({ folderId: 'none' })).total).toBe(28);
    await env.api.folders.delete(f.id);
    expect((await env.api.library.search({ folderId: 'none' })).total).toBe(30);
  });

  it('delete + restoreDeleted + clearAll', async () => {
    const env = await makeEnv({ children: makeChildren(10), pro: true });
    await env.api.sync.start();
    const [a] = (await env.api.library.search({ limit: 1 })).items;
    await env.api.library.delete([a.id]);
    expect(await env.api.library.get(a.id)).toBeNull();
    expect((await env.api.library.stats()).deletedCount).toBe(1);
    await env.api.sync.start();
    expect((await env.api.library.stats()).total).toBe(9); // not silently re-imported
    await env.api.library.restoreDeleted();
    await env.api.sync.start();
    expect((await env.api.library.stats()).total).toBe(10);
    await expect(env.api.library.clearAll()).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await env.api.library.clearAll({ confirm: true });
    expect((await env.api.library.stats()).total).toBe(0);
  });

  it('settings persist and validate', async () => {
    const env = await makeEnv();
    expect(await env.api.settings.get()).toEqual({ autoSync: false, autoSyncHours: 6, analyticsOptIn: false });
    await env.api.settings.set({ autoSync: true, autoSyncHours: 9999 });
    expect(await env.api.settings.get()).toMatchObject({ autoSync: true, autoSyncHours: 168 });
  });

  it('sync status/progress after a run', async () => {
    const env = await makeEnv({ children: makeChildren(5), pro: true });
    await env.api.sync.start();
    const s = await env.api.sync.status();
    expect(s.running).toBe(false);
    expect(s.last).toMatchObject({ status: 'ok', added: 5 });
  });

  it('exposes a documented, stable surface', async () => {
    const env = await makeEnv();
    const shape = Object.fromEntries(Object.entries(env.api).filter(([k]) => k !== 'config').map(([k, v]) => [k, Object.keys(v).sort()]));
    expect(shape).toEqual({
      library: ['clearAll', 'delete', 'get', 'restoreDeleted', 'search', 'stats', 'subreddits'],
      tags: ['add', 'delete', 'list', 'remove', 'rename', 'set'],
      folders: ['create', 'delete', 'list', 'move', 'rename'],
      sync: ['onProgress', 'start', 'status'],
      export: ['csv', 'json'],
      import: ['json'],
      license: ['refresh', 'setStubPro', 'status', 'upgrade'],
      settings: ['analyticsPreview', 'get', 'set'],
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// End-to-end over the real message path: ui/api.js -> chrome.runtime.sendMessage -> sw-bridge
// registerUiRpc -> our handlers. chrome.* is stubbed with a tiny in-process bus.
import { describe, it, expect, beforeAll } from 'vitest';
import { makeEnv } from './helpers/env.js';
import { makeChildren } from './helpers/fixtures.js';
import { createUiHandlers } from '../src/lib/ui-rpc.js';

let ui, bridge, listeners, broadcasts;

beforeAll(async () => {
  listeners = [];
  broadcasts = [];
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: (l) => listeners.push(l), removeListener: (l) => listeners.splice(listeners.indexOf(l), 1) },
      sendMessage: (msg) => new Promise((resolve, reject) => {
        if (msg?.event) { broadcasts.push(msg); return reject(new Error('no receiver')); }
        let answered = false;
        for (const l of [...listeners]) {
          const keep = l(msg, { id: 'test-extension-id' }, (res) => { answered = true; resolve(res); });
          if (keep) return;
        }
        if (!answered) resolve(undefined);
      }),
    },
  };
  bridge = await import('../ui/sw-bridge.js');
  ui = await import('../ui/api.js'); // sees chrome.runtime.id -> real (non-mock) path
  const env = await makeEnv({ children: makeChildren(150) });
  await env.syncer.run();
  bridge.registerUiRpc(createUiHandlers(async () => env.deps, { notifyChanged: bridge.notifyChanged }));
});

describe('UI <-> service worker RPC', () => {
  it('answers every contract method through {ns, method, args} -> {ok, result}', async () => {
    const r = await ui.getItems({ limit: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.total).toBe(150);
    expect((await ui.getRecent(5))).toHaveLength(5);
    expect((await ui.getFacets({})).types.post).toBeGreaterThan(0);
    expect(await ui.addTag(r.items[0].id, 'Wire Test')).toContain('wire-test');
    expect(await ui.removeTag(r.items[0].id, 'wire-test')).not.toContain('wire-test');
    expect((await ui.exportItems({}, 'csv')).filename).toMatch(/\.csv$/);
    expect(await ui.getPlan()).toMatchObject({ plan: 'free', cap: 300, count: 150, pending: 0, limitReached: false });
    expect((await ui.getSyncStatus()).state).toBe('idle');
    expect((await ui.syncNow()).state).toBe('idle');
    expect(await ui.upgrade()).toHaveProperty('opened');
    expect((await ui.getPlan()).plan).toBe('pro');
  });

  it('search() alias and errors surface as thrown Errors', async () => {
    expect((await ui.search('zzzzqqqq')).matched).toBe(0);
    const res = await chrome.runtime.sendMessage({ ns: 'saveshelf', method: 'nope', args: [] });
    expect(res).toEqual({ ok: false, error: 'Unknown method nope' });
  });

  it('ignores messages for other namespaces and broadcasts changes', async () => {
    expect(await chrome.runtime.sendMessage({ ns: 'other', method: 'getItems' })).toBeUndefined();
    await ui.addTag((await ui.getRecent(1))[0].id, 'ping');
    expect(broadcasts.some((b) => b.ns === 'saveshelf' && b.event === 'changed')).toBe(true);
  });

  it('folders go over the same bus: errors are readable, edits broadcast, own broadcast is not echoed to the page', async () => {
    const f = await ui.createFolder('Wire');
    await expect(ui.createFolder('wire')).rejects.toThrow(/already exists/);
    const [item] = (await ui.getItems({ limit: 1 })).items;
    await ui.moveToFolder([item.id], f.id);
    expect((await ui.getItems({ folderId: f.id })).items.map((i) => i.id)).toEqual([item.id]);
    expect((await ui.listFolders()).find((x) => x.id === f.id).count).toBe(1);
    expect(broadcasts.filter((b) => b.reason === 'folders').length).toBeGreaterThanOrEqual(2);

    // onChange: a folders broadcast right after this page's own edit is swallowed, other pages' edits and other reasons are not
    const seen = [];
    const off = ui.onChange((m) => seen.push(m.reason));
    const fire = (reason) => listeners.forEach((l) => l({ ns: 'saveshelf', event: 'changed', reason }));
    await ui.renameFolder(f.id, 'Wire 2');
    fire('folders');
    fire('sync');
    await new Promise((r) => setTimeout(r, 1100));
    fire('folders'); // another page's edit, well after ours
    off();
    expect(seen).toEqual(['sync', 'folders']);
    await ui.deleteFolder(f.id);
    expect((await ui.getItems({ folderId: 'none' })).matched).toBe(150);
  });
});

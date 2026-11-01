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
});

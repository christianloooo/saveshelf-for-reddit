import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers/env.js';
import { makeChildren, makeChild } from './helpers/fixtures.js';

describe('sync', () => {
  it('walks every page via the after cursor and stores everything (250 items / 3 pages)', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    const r = await env.syncer.run();
    expect(r).toMatchObject({ status: 'ok', user: 'alice', pages: 3, fetched: 250, added: 250, updated: 0, incremental: false });
    expect(await env.store.count()).toBe(250);
    const saved = env.reddit.calls.filter((c) => c.path.endsWith('/saved.json'));
    expect(saved).toHaveLength(3);
    expect(saved[0].search).toContain('limit=100');
    expect(saved[0].search).toContain('raw_json=1');
  });

  it('paginates with the last fullname of the previous page as the cursor', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    await env.syncer.run();
    const urls = env.reddit.calls.filter((c) => c.path.endsWith('/saved.json')).map((c) => new URL(c.url).searchParams.get('after'));
    expect(urls).toEqual([null, makeChild(99).data.name, makeChild(199).data.name]);
  });

  it('is polite: sequential requests, a pause between pages, own endpoints only, session cookies', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    await env.syncer.run();
    expect(env.sleeps).toHaveLength(2); // between 3 pages
    expect(env.sleeps.every((ms) => ms >= 1500 && ms <= 2000)).toBe(true);
    for (const c of env.reddit.calls) {
      expect(c.url.startsWith('https://www.reddit.com/')).toBe(true);
      expect(c.path === '/api/me.json' || c.path === '/user/alice/saved.json').toBe(true);
      expect(c.init.credentials).toBe('include');
      expect(c.init.method).toBe('GET');
    }
  });

  it('preserves saved order: most recently saved item has the highest seq', async () => {
    const env = await makeEnv({ children: makeChildren(150), pro: true });
    await env.syncer.run();
    const all = (await env.store.allItems()).sort((a, b) => b.seq - a.seq);
    expect(all[0].id).toBe(makeChild(0).data.name);
    expect(all.at(-1).id).toBe(makeChild(149).data.name);
  });

  it('syncs incrementally: stops at the first page that reaches known items', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    await env.syncer.run();
    env.reddit.calls.length = 0;
    // 5 new saves appear on top
    env.reddit.children.unshift(...makeChildren(5, 1000));
    const r = await env.syncer.run();
    expect(r).toMatchObject({ status: 'ok', incremental: true, pages: 1, added: 5 });
    expect(env.reddit.calls.filter((c) => c.path.endsWith('/saved.json'))).toHaveLength(1);
    expect(await env.store.count()).toBe(255);
    const newest = (await env.store.allItems()).sort((a, b) => b.seq - a.seq)[0];
    expect(newest.id).toBe(makeChild(1000).data.name);
    // nothing new -> still one cheap request, zero adds
    const r2 = await env.syncer.run();
    expect(r2).toMatchObject({ added: 0, pages: 1 });
  });

  it('full sync ignores the early stop', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    await env.syncer.run();
    env.reddit.calls.length = 0;
    const r = await env.syncer.run({ full: true });
    expect(r).toMatchObject({ incremental: false, pages: 3, updated: 250 });
  });

  it('an interrupted first sync resumes from the top (no early stop until complete)', async () => {
    const env = await makeEnv({
      children: makeChildren(250), pro: true,
      plan: [{ match: /after=/, status: 500, repeat: true }],
    });
    const bad = await env.syncer.run();
    expect(bad.status).toBe('error');
    expect(await env.store.count()).toBe(100); // page 1 was committed
    env.reddit.plan.length = 0;
    const r = await env.syncer.run();
    expect(r).toMatchObject({ status: 'ok', incremental: false, added: 150, updated: 100, pages: 3 });
    expect(await env.store.count()).toBe(250);
  });

  it('honours Retry-After on 429 and then succeeds', async () => {
    const env = await makeEnv({
      children: makeChildren(30), pro: true,
      plan: [{ match: /saved\.json/, status: 429, headers: { 'retry-after': '7' } }],
    });
    const r = await env.syncer.run();
    expect(r.status).toBe('ok');
    expect(env.sleeps).toContain(7000);
    expect(r.added).toBe(30);
  });

  it('gives up after bounded retries with exponential backoff -> rate_limited', async () => {
    const env = await makeEnv({
      children: makeChildren(30), pro: true,
      plan: [{ match: /saved\.json/, status: 429, repeat: true }],
    });
    const r = await env.syncer.run();
    expect(r.status).toBe('rate_limited');
    expect(env.sleeps).toEqual([2000, 4000, 8000]);
    expect(env.reddit.calls.filter((c) => c.path.endsWith('/saved.json'))).toHaveLength(4);
  });

  it('waits out an exhausted rate-limit budget header', async () => {
    const env = await makeEnv({
      children: makeChildren(30), pro: true,
      plan: [{ match: /saved\.json/, status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12' }, body: JSON.stringify({ kind: 'Listing', data: { after: null, children: [] } }) }],
    });
    await env.syncer.run();
    expect(env.sleeps).toContain(12000);
  });

  it('retries transient network failures', async () => {
    const env = await makeEnv({ children: makeChildren(10), pro: true, plan: [{ match: /me\.json/, throw: true }] });
    const r = await env.syncer.run();
    expect(r.status).toBe('ok');
    expect(env.sleeps[0]).toBe(2000);
  });

  it.each([
    ['logged-out me.json', { loggedIn: false }],
    ['HTTP 403', { plan: [{ match: /me\.json/, status: 403 }] }],
    ['HTML interstitial', { plan: [{ match: /me\.json/, status: 200, body: '<html>', headers: { 'content-type': 'text/html' } }] }],
  ])('reports not_logged_in (%s) and stores nothing', async (_n, opts) => {
    const env = await makeEnv({ children: makeChildren(10), pro: true, ...opts });
    const r = await env.syncer.run();
    expect(r.status).toBe('not_logged_in');
    expect(await env.store.count()).toBe(0);
    expect(env.reddit.calls.some((c) => c.path.endsWith('/saved.json'))).toBe(false);
  });

  it('rejects an unexpected response shape', async () => {
    const env = await makeEnv({ children: [], pro: true, plan: [{ match: /saved\.json/, status: 200, body: '{"hello":1}' }] });
    expect((await env.syncer.run()).error.code).toBe('BAD_RESPONSE');
  });

  it('free tier: caps at 300 newest items, reports capped, then makes no requests while full', async () => {
    const env = await makeEnv({ children: makeChildren(450) });
    const r = await env.syncer.run();
    expect(r.status).toBe('capped');
    expect(r.added).toBe(300);
    expect(r.skipped).toBe(150); // keeps paging to count what is waiting
    expect(await env.store.count()).toBe(300);
    const stored = new Set((await env.store.allItems()).map((i) => i.id));
    expect(stored.has(makeChild(0).data.name)).toBe(true); // newest kept
    expect(stored.has(makeChild(300).data.name)).toBe(false);

    expect(await env.store.getMeta('pending')).toBe(150); // 450 on Reddit - 300 stored

    // Still full: one cheap request (page 1 is all known), nothing stored, pending unchanged.
    env.reddit.calls.length = 0;
    const again = await env.syncer.run();
    expect(again).toMatchObject({ status: 'capped', added: 0, pages: 1, incremental: true });
    expect(env.reddit.calls.filter((c) => c.path.endsWith('/saved.json'))).toHaveLength(1);
    expect(await env.store.count()).toBe(300);
    expect(await env.store.getMeta('pending')).toBe(150);

    // 5 brand-new saves while at the cap: counted as pending, never stored, nothing deleted.
    env.reddit.children.unshift(...makeChildren(5, 2000));
    const more = await env.syncer.run();
    expect(more).toMatchObject({ status: 'capped', added: 0, skipped: 5 });
    expect(await env.store.count()).toBe(300);
    expect(await env.store.getMeta('pending')).toBe(155);
  });

  it('upgrading to Pro lifts the cap and backfills the older saves', async () => {
    const env = await makeEnv({ children: makeChildren(450) });
    await env.syncer.run();
    expect(await env.store.count()).toBe(300);
    await env.license.setStubPro(true);
    const r = await env.syncer.run();
    expect(r.status).toBe('ok');
    expect(r.incremental).toBe(false); // capped run left the initial sync incomplete
    expect(r.added).toBe(150);
    expect(await env.store.count()).toBe(450);
  });

  it('free tier: deleting items frees slots for the next sync', async () => {
    const env = await makeEnv({ children: makeChildren(310) });
    await env.syncer.run();
    const stored = await env.store.allItems();
    await env.store.deleteItems(stored.slice(0, 5).map((i) => i.id));
    const r = await env.syncer.run();
    // 5 slots free; deleted ids are tombstoned so they are not re-imported, the 10 skipped older ones fill the slots
    expect(r.ignored).toBe(5);
    expect(r.added).toBe(5);
    expect(await env.store.count()).toBe(300);
  });

  it('refuses concurrent syncs', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    const [a, b] = await Promise.all([env.syncer.run(), env.syncer.run()]);
    expect([a.status, b.status].sort()).toEqual(['busy', 'ok']);
  });

  it('can be aborted', async () => {
    const env = await makeEnv({ children: makeChildren(250), pro: true });
    const ac = new AbortController();
    const syncer = (await import('../src/lib/sync.js')).createSyncer({
      fetchImpl: env.reddit.fetch, store: env.store, getCap: async () => Infinity, config: env.config,
      sleep: async () => ac.abort(), random: () => 0,
    });
    const r = await syncer.run({ signal: ac.signal });
    expect(r.status).toBe('aborted');
    expect(await env.store.count()).toBe(100);
  });

  it('records the last sync result and caps the walk at MAX_PAGES (Reddit exposes ~1000 saves)', async () => {
    const env = await makeEnv({ children: makeChildren(1200), pro: true, maxItems: 1200 });
    const r = await env.syncer.run();
    expect(r.pages).toBe(12);
    expect((await env.store.getMeta('lastSync')).added).toBe(1200);
  });
});

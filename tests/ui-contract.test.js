// Runs the SAME assertions against (a) leuifrontend's mock backend (the executable spec) and
// (b) our real handlers (src/lib/ui-rpc.js) on fake-indexeddb + a fake Reddit.
import { describe, it, expect } from 'vitest';
import { createMock } from '../ui/mock/mock-backend.js';
import { makeEnv } from './helpers/env.js';
import { makeChildren } from './helpers/fixtures.js';
import { createUiHandlers } from '../src/lib/ui-rpc.js';

const ITEM_KEYS = ['author', 'createdAt', 'id', 'numComments', 'score', 'savedAt', 'snippet', 'subreddit', 'tags', 'title', 'type', 'url'].sort();

const backends = {
  mock: {
    async make(scenario) {
      const q = { default: 'count=120', capped: 'count=300&pending=700', pro: 'count=120&plan=pro' }[scenario];
      return { h: createMock(new URLSearchParams(q)), capCount: 300 };
    },
  },
  real: {
    async make(scenario) {
      const env = await makeEnv({ children: makeChildren(scenario === 'capped' ? 1000 : 120), pro: scenario === 'pro', maxItems: 1000 });
      const changes = [];
      const h = createUiHandlers(async () => env.deps, { notifyChanged: (r) => changes.push(r) });
      await env.syncer.run(); // initial sync (free scenario caps at 300)
      return { h, env, changes, capCount: 300 };
    },
  },
};

const sortedDesc = (arr, f) => arr.every((x, i) => i === 0 || f(arr[i - 1]) >= f(x));

describe.each(Object.keys(backends))('UI contract: %s', (name) => {
  const make = (s = 'default') => backends[name].make(s);

  it('getItems: shape, default order, paging, totals', async () => {
    const { h } = await make();
    const r = await h.getItems({});
    expect(Object.keys(r).sort()).toEqual(['items', 'matched', 'total']);
    expect(r.matched).toBe(r.total);
    expect(r.total).toBe(120);
    expect(r.items[0] && Object.keys(r.items[0]).sort()).toEqual(ITEM_KEYS);
    for (const i of r.items) {
      expect(['post', 'comment']).toContain(i.type);
      expect(i.url).toMatch(/^https:\/\/www\.reddit\.com\//);
      expect(i.snippet.length).toBeLessThanOrEqual(300);
      expect(i.tags.every((t) => t === t.toLowerCase() && t.length <= 32 && !/\s/.test(t))).toBe(true);
    }
    expect(sortedDesc(r.items, (i) => i.savedAt)).toBe(true);
    const p1 = await h.getItems({ limit: 40, offset: 0 });
    const p2 = await h.getItems({ limit: 40, offset: 40 });
    expect(p1.items).toHaveLength(40);
    expect(p1.items[0].id).toBe(r.items[0].id);
    expect(p2.items[0].id).toBe(r.items[40].id);
    expect(p1.matched).toBe(120);
    const recent = await h.getItems({ sort: 'saved-desc', limit: 5 });
    expect(recent.items.map((i) => i.id)).toEqual(r.items.slice(0, 5).map((i) => i.id));
  });

  it('getItems: search is case-insensitive AND across words and never grows when words are added', async () => {
    const { h } = await make();
    const all = (await h.getItems({})).items;
    const target = all.find((i) => i.title.split(/\s+/).filter((w) => /^[a-z]{4,}$/i.test(w)).length >= 2);
    const [w1, w2] = target.title.split(/\s+/).filter((w) => /^[a-z]{4,}$/i.test(w));
    const one = await h.getItems({ query: w1.toUpperCase() });
    const two = await h.getItems({ query: `${w1} ${w2}` });
    expect(one.items.map((i) => i.id)).toContain(target.id);
    expect(two.items.map((i) => i.id)).toContain(target.id);
    expect(two.matched).toBeLessThanOrEqual(one.matched);
    expect((await h.getItems({ query: 'zzzz-no-such-thing-qq' })).matched).toBe(0);
    expect((await h.getItems({ query: '   ' })).matched).toBe(120);
    // subreddit / author / tags are searchable too
    expect((await h.getItems({ query: target.subreddit.toLowerCase() })).items.map((i) => i.id)).toContain(target.id);
    expect((await h.getItems({ query: target.author })).items.map((i) => i.id)).toContain(target.id);
  });

  it('getItems: type, subreddit, tag(AND) and date filters + sorts', async () => {
    const { h } = await make();
    const all = (await h.getItems({})).items;
    const posts = await h.getItems({ type: 'post' });
    const comments = await h.getItems({ type: 'comment' });
    expect(posts.matched + comments.matched).toBe(120);
    expect(posts.items.every((i) => i.type === 'post')).toBe(true);
    expect((await h.getItems({ type: 'all' })).matched).toBe(120);

    const subs = [...new Set(all.map((i) => i.subreddit))].slice(0, 2);
    const bySub = await h.getItems({ subreddits: subs });
    expect(bySub.items.every((i) => subs.includes(i.subreddit))).toBe(true);
    expect(bySub.matched).toBe(all.filter((i) => subs.includes(i.subreddit)).length);

    const withTags = await (async () => {
      const a = all.find((i) => i.tags.length >= 1);
      return a ? { tag: a.tags[0] } : null;
    })();
    if (withTags) {
      const r = await h.getItems({ tags: [withTags.tag] });
      expect(r.items.every((i) => i.tags.includes(withTags.tag))).toBe(true);
      expect((await h.getItems({ tags: [withTags.tag, 'no-such-tag'] })).matched).toBe(0); // AND
    }

    const mid = all[Math.floor(all.length / 2)].savedAt;
    const recent = await h.getItems({ from: mid });
    const older = await h.getItems({ to: mid });
    expect(recent.items.every((i) => i.savedAt >= mid)).toBe(true);
    expect(older.items.every((i) => i.savedAt <= mid)).toBe(true);

    expect(sortedDesc((await h.getItems({ sort: 'score-desc' })).items, (i) => i.score)).toBe(true);
    expect(sortedDesc((await h.getItems({ sort: 'posted-desc' })).items, (i) => i.createdAt)).toBe(true);
    const asc = (await h.getItems({ sort: 'saved-asc' })).items;
    expect(asc.map((i) => i.id)).toEqual([...all].reverse().map((i) => i.id));
  });

  it('getFacets: counts, allTags, and each facet ignores its own filter', async () => {
    const { h } = await make();
    const all = (await h.getItems({})).items;
    const f = await h.getFacets({});
    expect(Object.keys(f).sort()).toEqual(['allTags', 'subreddits', 'tags', 'types']);
    expect(f.types.post + f.types.comment).toBe(120);
    expect(f.subreddits.reduce((n, s) => n + s.count, 0)).toBe(120);
    expect(f.subreddits.length).toBeGreaterThan(1);
    expect(sortedDesc(f.subreddits, (s) => s.count)).toBe(true);
    expect([...f.allTags]).toEqual([...f.allTags].sort());

    const sub = f.subreddits[0].name;
    const fs = await h.getFacets({ subreddits: [sub] });
    expect(fs.subreddits.map((s) => s.name).sort()).toEqual(f.subreddits.map((s) => s.name).sort()); // broadening still possible
    expect(fs.types.post + fs.types.comment).toBe(f.subreddits[0].count); // other facets narrowed
    expect(fs.allTags).toEqual(f.allTags); // unfiltered

    const ft = await h.getFacets({ type: 'comment' });
    expect(ft.types).toEqual(f.types); // type facet ignores the type filter
    expect(ft.subreddits.reduce((n, s) => n + s.count, 0)).toBe(f.types.comment);
    void all;
  });

  it('addTag / removeTag: normalisation, idempotence, unknown ids, facets, filters', async () => {
    const { h } = await make();
    const [first, second] = (await h.getItems({ limit: 2 })).items;
    expect(await h.addTag(first.id, '  Must   Read ')).toContain('must-read');
    const again = await h.addTag(first.id, 'must-read');
    expect(again.filter((t) => t === 'must-read')).toHaveLength(1);
    const long = await h.addTag(first.id, 'x'.repeat(50));
    expect(long.find((t) => t.startsWith('xxxx'))).toHaveLength(32);
    const before = (await h.getItems({ limit: 1 })).items[0].tags;
    expect(await h.addTag(first.id, '   ')).toEqual(before);
    expect(await h.addTag('t3_doesnotexist', 'a')).toEqual([]);
    expect(await h.removeTag('t3_doesnotexist', 'a')).toEqual([]);

    await h.addTag(second.id, 'must-read');
    expect((await h.getItems({ tags: ['must-read'] })).matched).toBe(2);
    expect((await h.getFacets({})).tags.find((t) => t.name === 'must-read').count).toBe(2);
    expect((await h.getFacets({})).allTags).toContain('must-read');
    expect((await h.getItems({ query: 'must-read' })).items.map((i) => i.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    const left = await h.removeTag(first.id, 'must-read');
    expect(left).not.toContain('must-read');
    expect((await h.getItems({ tags: ['must-read'] })).matched).toBe(1);
  });

  it('exportItems: free on every tier, honours filters, json + csv', async () => {
    const { h } = await make();
    const sub = (await h.getFacets({})).subreddits[0];
    const json = await h.exportItems({ subreddits: [sub.name] }, 'json');
    expect(Object.keys(json).sort()).toEqual(['content', 'filename', 'mime']);
    expect(json.filename).toMatch(/^saveshelf-\d{4}-\d{2}-\d{2}\.json$/);
    expect(json.mime).toBe('application/json');
    const doc = JSON.parse(json.content);
    expect(doc.count).toBe(sub.count);
    expect(doc.items.every((i) => i.subreddit === sub.name)).toBe(true);
    expect(sortedDesc(doc.items, (i) => i.savedAt)).toBe(true);
    const csv = await h.exportItems({}, 'csv');
    expect(csv.filename).toMatch(/\.csv$/);
    expect(csv.mime).toMatch(/^text\/csv/);
    expect(csv.content.startsWith('\ufeffid,type,title,subreddit,author,url,saved_at,created_at,score,comments,tags,text\r\n')).toBe(true);
    expect(csv.content.split('\r\n').length).toBeGreaterThanOrEqual(121);
  });

  it('getPlan: free tier at 120 items', async () => {
    const { h } = await make();
    const p = await h.getPlan();
    expect(Object.keys(p).sort()).toEqual(['cap', 'count', 'limitReached', 'pending', 'plan', 'priceLabel']);
    expect(p).toMatchObject({ plan: 'free', cap: 300, count: 120, pending: 0, limitReached: false });
    expect(p.priceLabel).toMatch(/\$9/);
  });

  it('getPlan: at the cap -> limitReached + pending; search/tags/export keep working; nothing is deleted', async () => {
    const { h } = await make('capped');
    const p = await h.getPlan();
    expect(p).toMatchObject({ plan: 'free', cap: 300, count: 300, limitReached: true, pending: 700 });
    expect((await h.getItems({ limit: 5 })).total).toBe(300);
    const [it] = (await h.getItems({ limit: 1 })).items;
    expect(await h.addTag(it.id, 'still-works')).toContain('still-works');
    expect(JSON.parse((await h.exportItems({}, 'json')).content).count).toBe(300);
    expect((await h.getPlan()).count).toBe(300);
  });

  it('getPlan: pro has no cap and no pending', async () => {
    const { h } = await make('pro');
    expect(await h.getPlan()).toMatchObject({ plan: 'pro', cap: null, pending: 0, limitReached: false });
  });

  it('upgrade(): flips to pro and clears the limit', async () => {
    const { h } = await make('capped');
    const r = await h.upgrade();
    expect(r).toHaveProperty('opened');
    const p = await h.getPlan();
    expect(p).toMatchObject({ plan: 'pro', cap: null, pending: 0, limitReached: false });
  });

  it('getSyncStatus / syncNow: shape', async () => {
    const { h } = await make();
    const s = await h.getSyncStatus();
    expect(['idle', 'syncing', 'error', 'needs-login']).toContain(s.state);
    expect(typeof s.added).toBe('number');
    expect(s.lastSyncAt === null || typeof s.lastSyncAt === 'number').toBe(true);
    expect(s.progress === null || (typeof s.progress.done === 'number' && typeof s.progress.total === 'number')).toBe(true);
    const n = await h.syncNow();
    expect(['idle', 'syncing', 'error', 'needs-login']).toContain(n.state);
  });
});

describe('real backend specifics', () => {
  it('stores comment titles as the parent post title and keeps snippets plain', async () => {
    const { h } = await backends.real.make();
    const comments = (await h.getItems({ type: 'comment' })).items;
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) {
      expect(c.title.length).toBeGreaterThan(5);
      expect(c.title).not.toMatch(/^Comment \d/);
      expect(c.snippet).toMatch(/^Comment \d+:/);
    }
  });

  it('at the cap: new saves become pending, stored items are never removed, plan counts update', async () => {
    const { h, env, changes } = await backends.real.make('capped');
    const before = (await h.getItems({})).items.map((i) => i.id);
    env.reddit.children.unshift(...makeChildren(3, 5000));
    const st = await h.syncNow();
    expect(st.state).toBe('idle');
    expect(st.added).toBe(0);
    expect(await h.getPlan()).toMatchObject({ count: 300, pending: 703, limitReached: true });
    expect((await h.getItems({})).items.map((i) => i.id).sort()).toEqual([...before].sort());
    expect(changes).toContain('sync');
  });

  it('upgrade backfills the pending saves and tells the UI', async () => {
    const { h, env, changes } = await backends.real.make('capped');
    await h.upgrade();
    for (let i = 0; i < 200 && !(changes.includes('sync') && (await env.store.count()) === 1000); i++) await new Promise((r) => setTimeout(r, 10));
    expect(await env.store.count()).toBe(1000);
    expect(await h.getPlan()).toMatchObject({ plan: 'pro', pending: 0, count: 1000 });
    expect(changes).toContain('plan');
    expect(changes).toContain('sync');
  });

  it('sync status reflects progress, login and error states', async () => {
    const live = await backends.real.make();
    await live.env.stateKv.set('syncProgress', { phase: 'fetching', fetched: 340, running: true, at: live.env.now() });
    // `now` in deps is the env clock; progress `at` is "fresh" relative to it
    expect(await live.h.getSyncStatus()).toMatchObject({ state: 'syncing', progress: { done: 340, total: 1000 } });

    const out = await makeEnv({ children: makeChildren(5), loggedIn: false });
    const ho = createUiHandlers(async () => out.deps);
    const s = await ho.syncNow();
    expect(s).toMatchObject({ state: 'needs-login', lastSyncAt: null });
    expect(s.message).toMatch(/Reddit/);

    const bad = await makeEnv({ children: makeChildren(5), plan: [{ match: /saved\.json/, status: 500, repeat: true }] });
    const hb = createUiHandlers(async () => bad.deps);
    expect((await hb.syncNow()).state).toBe('error');
    const good = await makeEnv({ children: makeChildren(5) });
    const hg = createUiHandlers(async () => good.deps);
    const gs = await hg.syncNow();
    expect(gs).toMatchObject({ state: 'idle', added: 5 });
    expect(typeof gs.lastSyncAt).toBe('number');
  });

  it('link posts get their outbound URL as snippet (never an empty/null card)', async () => {
    const { h } = await backends.real.make();
    const posts = (await h.getItems({ type: 'post' })).items;
    const link = posts.find((p) => /^https:\/\/(github|youtube|arxiv|blog|i\.redd)/.test(p.snippet));
    expect(link).toBeTruthy();
    expect(posts.every((p) => typeof p.snippet === 'string')).toBe(true);
  });

  it('internal fields never leak into UI items (even non-enumerable ones are not serialised)', async () => {
    const { h } = await backends.real.make();
    const r = await h.getItems({ limit: 1 });
    expect(Object.keys(r.items[0])).not.toEqual(expect.arrayContaining(['seq']));
    expect(JSON.parse(JSON.stringify(r.items[0]))).not.toHaveProperty('_hay');
    expect(JSON.parse(JSON.stringify(r.items[0]))).not.toHaveProperty('_seq');
    expect(JSON.parse(JSON.stringify(r.items[0]))).not.toHaveProperty('folderId');
  });
});

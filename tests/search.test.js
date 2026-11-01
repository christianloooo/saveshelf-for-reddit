import { describe, it, expect } from 'vitest';
import { buildIndex, searchIndex, parseQuery, tokenize } from '../src/lib/search.js';
import { normalizeChild } from '../src/lib/normalize.js';
import { makeChildren } from './helpers/fixtures.js';

const items = makeChildren(60).map((c, i) => ({ ...normalizeChild(c), seq: 1000 - i, tags: [], folderId: null }));
const ids = (r) => r.items.map((i) => i.id);

describe('search', () => {
  it('tokenizes with diacritics folded', () => {
    expect(tokenize('Café-style Résumé')).toEqual(['cafe', 'style', 'resume']);
  });

  it('parses terms, phrases, negation and filters', () => {
    const q = parseQuery('rust "borrow checking" -python r/rust tag:"to read" type:post');
    expect(q.terms).toEqual(['rust']);
    expect(q.phrases).toEqual(['borrow checking']);
    expect(q.exclude).toEqual([{ token: 'python' }]);
    expect(q.filters.sub).toEqual([{ value: 'rust', neg: false }]);
    expect(q.filters.tag).toEqual([{ value: 'to read', neg: false }]);
    expect(q.filters.type).toEqual([{ value: 'post', neg: false }]);
  });

  it('finds by title/body words with prefix matching and AND semantics', () => {
    const idx = buildIndex(items);
    const r = searchIndex(idx, 'borrow rust');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => /borrow/i.test(i.title))).toBe(true);
    expect(searchIndex(idx, 'borr').items.length).toBe(r.items.length === 0 ? 0 : searchIndex(idx, 'borrow').items.length);
    expect(searchIndex(idx, 'borrow sourdough').items).toEqual([]); // AND
  });

  it('matches accent-insensitively', () => {
    const idx = buildIndex(items);
    expect(searchIndex(idx, 'cafe').items.length).toBeGreaterThan(0);
    expect(searchIndex(idx, 'café').items.length).toBe(searchIndex(idx, 'cafe').items.length);
  });

  it('searches comment bodies and unique tokens', () => {
    const idx = buildIndex(items);
    const r = searchIndex(idx, 'zeta4'); // prefix search also matches zeta49..., exact token ranks first
    expect(r.items[0].id).toBe(items[4].id);
    expect(r.items[0].kind).toBe('comment');
  });

  it('supports phrases, exclusions, subreddit and type filters', () => {
    const idx = buildIndex(items);
    const phrase = searchIndex(idx, '"borrow checking in rust"');
    expect(phrase.items.length).toBeGreaterThan(0);
    const all = searchIndex(idx, 'rust');
    const noBorrow = searchIndex(idx, 'rust -borrow');
    expect(noBorrow.items.length).toBeLessThan(all.items.length);
    expect(noBorrow.items.some((i) => /borrow/i.test(i.title))).toBe(false);
    const sub = searchIndex(idx, 'r/cooking');
    expect(sub.items.length).toBeGreaterThan(0);
    expect(sub.items.every((i) => i.subreddit === 'cooking')).toBe(true);
    expect(searchIndex(idx, 'type:comment').items.every((i) => i.kind === 'comment')).toBe(true);
    expect(searchIndex(idx, '-type:comment').items.every((i) => i.kind === 'post')).toBe(true);
    expect(searchIndex(idx, 'nsfw:yes').items.every((i) => i.nsfw)).toBe(true);
  });

  it('ranks title matches above body matches and falls back to saved order', () => {
    const a = { id: 't3_a', kind: 'post', title: 'nothing', body: 'mentions kubernetes once', subreddit: 'x', author: 'u', seq: 2, tags: [] };
    const b = { id: 't3_b', kind: 'post', title: 'kubernetes guide', body: '', subreddit: 'x', author: 'u', seq: 1, tags: [] };
    const r = searchIndex(buildIndex([a, b]), 'kubernetes');
    expect(ids(r)).toEqual(['t3_b', 't3_a']);
    expect(ids(searchIndex(buildIndex([a, b]), ''))).toEqual(['t3_a', 't3_b']); // newest saved first
  });

  it('indexes tags and folders for filters', () => {
    const tagged = items.slice(0, 3).map((i, n) => ({ ...i, tags: n === 0 ? ['read later', 'rust'] : [], folderId: n === 0 ? 'f1' : null }));
    const idx = buildIndex(tagged, { folderNames: new Map([['f1', 'Reading List']]) });
    expect(ids(searchIndex(idx, 'tag:"read later"'))).toEqual([tagged[0].id]);
    expect(ids(searchIndex(idx, 'folder:"reading list"'))).toEqual([tagged[0].id]);
    expect(ids(searchIndex(idx, 'later'))).toEqual([tagged[0].id]); // tags are searchable text
  });

  it('is fast enough on a few thousand items', () => {
    const big = makeChildren(5000).map((c, i) => ({ ...normalizeChild(c), seq: 5000 - i, tags: [] }));
    const t0 = performance.now();
    const idx = buildIndex(big);
    const t1 = performance.now();
    searchIndex(idx, 'transformer attention');
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(3000);
    expect(t2 - t1).toBeLessThan(500);
  });
});

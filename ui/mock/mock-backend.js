// Mock implementation of the data API (same method names/shapes as ../api.js).
// lecoder: this file is the executable spec for search/filter semantics. Replace with the real service-worker handlers.
// Folders: items carry folderId, getItems/getFacets/exportItems take a folderId filter, plus the folder methods (./mock-folders.js; ?folders=demo seeds some).
// Scenarios via URL: ?snippet=null|empty|blank (first 3 items get no usable snippet) ?count=243 &plan=free|pro &cap=300 &pending=0 &sync=idle|syncing|error|needs-login|never (never synced) &added=12 (items added by the last sync)
import { buildExport } from '../export-format.js';
import { createMockFolders } from './mock-folders.js';
import { SEED, FILLER_SUBS, FILLER_TOPICS, FILLER_FORMS, FILLER_AUTHORS, FILLER_TAGS } from './sample-data.js';

const DAY = 86_400_000;

function rng(seed) { // mulberry32 - deterministic so screenshots are stable
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildItems(count) {
  const rand = rng(7);
  const now = Date.now();
  const items = [];
  let savedAgo = 0.04 * DAY; // newest first, gaps grow slowly
  for (let n = 0; n < count; n++) {
    const seed = SEED[n];
    let type, subreddit, title, author, snippet, score, numComments, tags;
    if (seed) {
      [type, subreddit, title, author, snippet, score, numComments, tags] = seed;
    } else {
      const topic = FILLER_TOPICS[Math.floor(rand() * FILLER_TOPICS.length)];
      subreddit = FILLER_SUBS[Math.floor(rand() * FILLER_SUBS.length)];
      title = FILLER_FORMS[Math.floor(rand() * FILLER_FORMS.length)](topic);
      author = FILLER_AUTHORS[Math.floor(rand() * FILLER_AUTHORS.length)];
      type = rand() < 0.18 ? 'comment' : 'post';
      if (type === 'comment') title = 'Re: ' + title;
      snippet = `Long thread about ${topic} with practical examples, trade-offs and a few strong opinions in the replies.`;
      score = Math.floor(200 + rand() * 6000);
      numComments = Math.floor(10 + rand() * 400);
      tags = FILLER_TAGS[Math.floor(rand() * FILLER_TAGS.length)];
    }
    savedAgo += (0.15 + rand() * 1.1) * DAY * (n < 12 ? 0.6 : 1);
    const savedAt = now - savedAgo;
    items.push({
      id: (type === 'comment' ? 't1_' : 't3_') + (1000 + n * 7919).toString(36),
      type, title, subreddit, author, snippet, score, numComments,
      url: `https://www.reddit.com/r/${subreddit}/comments/${(1000 + n * 7919).toString(36)}/`,
      savedAt, createdAt: savedAt - (1 + rand() * 400) * DAY,
      tags: [...tags],
    });
  }
  return items;
}

const norm = (s) => s.toLowerCase();

export function createMock(params) {
  const count = Number(params.get('count') ?? 243);
  const plan = params.get('plan') ?? 'free';
  const cap = Number(params.get('cap') ?? 300);
  const pending = Number(params.get('pending') ?? 0);
  const syncState = params.get('sync') ?? 'idle';
  const items = buildItems(count);
  const SNIPPETS = { null: null, empty: '', blank: '   ' };
  const kind = params.get('snippet');
  const noSnippet = kind !== null && Object.hasOwn(SNIPPETS, kind) ? SNIPPETS[kind] : undefined;
  if (noSnippet !== undefined) for (const i of items.slice(0, 3)) i.snippet = noSnippet; // regression scenario: cards must omit the snippet line
  const state = { items, plan };
  const folders = createMockFolders(params, async () => state.items); // in-memory; ?folders=demo seeds a few
  /** Items as the contract returns them: a copy carrying folderId (string|null). */
  const withFolders = async (list = state.items) => {
    const assigned = await folders.assignments();
    return list.map((i) => ({ ...i, folderId: assigned.get(i.id) ?? null }));
  };
  const lastSyncAt = Date.now() - 4 * 60_000;

  const matches = (i, p) => {
    if (p.type && p.type !== 'all' && i.type !== p.type) return false;
    if (p.subreddits?.length && !p.subreddits.includes(i.subreddit)) return false;
    if (p.tags?.length && !p.tags.every((t) => i.tags.includes(t))) return false;
    if (p.folderId != null && (p.folderId === 'none' ? i.folderId !== null : i.folderId !== p.folderId)) return false;
    if (p.from != null && i.savedAt < p.from) return false;
    if (p.to != null && i.savedAt > p.to) return false;
    if (p.query?.trim()) {
      const hay = norm([i.title, i.snippet ?? '', i.subreddit, i.author, i.tags.join(' ')].join(' '));
      if (!norm(p.query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  };

  const sorters = {
    'saved-desc': (a, b) => b.savedAt - a.savedAt,
    'saved-asc': (a, b) => a.savedAt - b.savedAt,
    'score-desc': (a, b) => b.score - a.score,
    'posted-desc': (a, b) => b.createdAt - a.createdAt,
  };

  const tally = (list, pick) => {
    const m = new Map();
    for (const i of list) for (const k of pick(i)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  const planInfo = () => ({
    plan: state.plan,
    cap: state.plan === 'pro' ? null : cap,
    count: state.items.length,
    pending: state.plan === 'pro' ? 0 : pending,
    limitReached: state.plan !== 'pro' && state.items.length >= cap,
    priceLabel: '$9 one-time',
  });

  return {
    async getItems(p = {}) {
      const all = (await withFolders()).filter((i) => matches(i, p)).sort(sorters[p.sort ?? 'saved-desc']);
      const start = p.offset ?? 0;
      const end = p.limit == null ? undefined : start + p.limit;
      return { items: all.slice(start, end), matched: all.length, total: state.items.length };
    },
    async getFacets(p = {}) {
      // Facet counts ignore the facet's own filter so users can broaden a selection.
      const withF = await withFolders();
      const base = (omit) => withF.filter((i) => matches(i, { ...p, [omit]: undefined }));
      return {
        subreddits: tally(base('subreddits'), (i) => [i.subreddit]),
        tags: tally(base('tags'), (i) => i.tags),
        allTags: tally(state.items, (i) => i.tags).map((t) => t.name).sort(),
        types: { post: base('type').filter((i) => i.type === 'post').length, comment: base('type').filter((i) => i.type === 'comment').length },
      };
    },
    async addTag(id, tag) {
      const t = tag.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
      const item = state.items.find((i) => i.id === id);
      if (item && t && !item.tags.includes(t)) item.tags.push(t);
      return item?.tags ?? [];
    },
    async removeTag(id, tag) {
      const item = state.items.find((i) => i.id === id);
      if (item) item.tags = item.tags.filter((t) => t !== tag);
      return item?.tags ?? [];
    },
    async exportItems(p = {}, format = 'json') {
      const items = (await withFolders()).filter((i) => matches(i, p)).sort(sorters['saved-desc']);
      return buildExport(items.map(({ folderId, ...rest }) => rest), format);
    },
    listFolders: () => folders.list(),
    createFolder: (name) => folders.create(name),
    renameFolder: (id, name) => folders.rename(id, name),
    deleteFolder: (id) => folders.remove(id),
    moveToFolder: (ids, folderId = null) => folders.move(ids, folderId),
    async getPlan() { return planInfo(); },
    async upgrade() { state.plan = 'pro'; return { opened: true, mock: true }; },
    async getSyncStatus() {
      return {
        state: syncState === 'never' ? 'idle' : syncState,
        lastSyncAt: syncState === 'needs-login' || syncState === 'never' ? null : lastSyncAt,
        added: Number(params.get('added') ?? 12),
        total: state.items.length,
        progress: syncState === 'syncing' ? { done: 340, total: 1000 } : null,
        message: syncState === 'error' ? 'Reddit rate-limited the request. Retrying in 2 min.' : syncState === 'needs-login' ? 'Sign in to Reddit in this browser to sync.' : undefined,
      };
    },
    async syncNow() { return this.getSyncStatus(); },
  };
}

// Full-text search over the library. Pure functions (no IndexedDB, no chrome.*) so they are easy to
// test and can run in any extension context. The index is built in memory from all items; a library
// of several thousand items indexes in tens of milliseconds.
//
// Query syntax (all optional, combine freely):
//   word word        every word must match (prefix match: "javasc" finds "javascript")
//   "exact phrase"   case-insensitive substring match across title/body/etc.
//   -word            exclude items containing the word
//   r/sub  sub:x     subreddit filter           tag:x          tag filter (use tag:"two words")
//   type:post|comment  author:x  domain:x  folder:name  nsfw:yes|no

const FIELD_WEIGHTS = { title: 3, tags: 3, subreddit: 2, flair: 2, body: 1, author: 1, domain: 1, note: 1 };

export function tokenize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

/** Parse a query string into text terms, phrases, negations and filters. */
export function parseQuery(input) {
  const q = { terms: [], phrases: [], exclude: [], filters: {} };
  const re = /(-?)(?:(\w+):)?("([^"]*)"|\S+)/g;
  const KEYS = new Set(['sub', 'subreddit', 'tag', 'type', 'author', 'domain', 'folder', 'nsfw']);
  let m;
  while ((m = re.exec(String(input ?? '')))) {
    const neg = m[1] === '-';
    let key = m[2]?.toLowerCase();
    let raw = m[3];
    const quoted = m[4] !== undefined;
    let value = quoted ? m[4] : raw;
    if (key && !KEYS.has(key)) {
      // not a filter ("foo:bar" as plain text) -> treat the whole token as words
      key = undefined;
      value = (quoted ? m[4] : `${m[2]}:${raw}`);
    }
    if (!key && !quoted) {
      const r = /^r\/([A-Za-z0-9_]+)$/.exec(value);
      if (r) {
        key = 'sub';
        value = r[1];
      }
    }
    if (key) {
      if (key === 'subreddit') key = 'sub';
      value = value.replace(/^r\//i, (x) => (key === 'sub' ? '' : x));
      if (!value) continue;
      (q.filters[key] ??= []).push({ value: fold(value), neg });
    } else if (quoted) {
      const p = fold(value).trim();
      if (p) (neg ? q.exclude : q.phrases).push(neg ? { phrase: p } : p);
    } else {
      for (const tok of tokenize(value)) (neg ? q.exclude : q.terms).push(neg ? { token: tok } : tok);
    }
  }
  return q;
}

/**
 * Build a search index.
 * @param {object[]} items
 * @param {{folderNames?: Map<string,string>}} [opts] folderId -> folder name (for the folder: filter)
 */
export function buildIndex(items, { folderNames = new Map() } = {}) {
  const docs = [];
  const postings = new Map(); // token -> Map(docIdx -> weighted tf)
  items.forEach((item, idx) => {
    const fields = {
      title: item.title,
      tags: (item.tags ?? []).join(' '),
      subreddit: item.subreddit,
      flair: item.flair,
      body: item.body,
      author: item.author,
      domain: item.domain,
      note: item.note,
    };
    for (const [field, text] of Object.entries(fields)) {
      const w = FIELD_WEIGHTS[field];
      for (const tok of tokenize(text)) {
        let docMap = postings.get(tok);
        if (!docMap) postings.set(tok, (docMap = new Map()));
        docMap.set(idx, (docMap.get(idx) ?? 0) + w);
      }
    }
    docs.push({
      item,
      haystack: fold([item.title, item.body, (item.tags ?? []).join(' '), item.subreddit, item.author, item.domain].join(' \n ')),
      sub: fold(item.subreddit),
      author: fold(item.author),
      domain: fold(item.domain),
      tags: (item.tags ?? []).map(fold),
      folder: fold(folderNames.get(item.folderId) ?? ''),
    });
  });
  const sortedTokens = [...postings.keys()].sort();
  return { docs, postings, sortedTokens, size: docs.length };
}

function prefixRange(sorted, prefix, limit = 200) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix) && out.length < limit; i++) out.push(sorted[i]);
  return out;
}

function matchesFilters(doc, filters) {
  const test = (list, pred) =>
    (list ?? []).every(({ value, neg }) => (neg ? !pred(value) : pred(value)));
  if (!test(filters.sub, (v) => doc.sub === v)) return false;
  if (!test(filters.author, (v) => doc.author === v)) return false;
  if (!test(filters.domain, (v) => doc.domain === v || doc.domain.endsWith(`.${v}`))) return false;
  if (!test(filters.tag, (v) => doc.tags.includes(v))) return false;
  if (!test(filters.folder, (v) => doc.folder === v)) return false;
  if (!test(filters.type, (v) => doc.item.kind === (v.startsWith('comment') ? 'comment' : 'post'))) return false;
  if (!test(filters.nsfw, (v) => doc.item.nsfw === ['yes', 'true', '1'].includes(v))) return false;
  return true;
}

/**
 * Run a query. Returns matching items ranked by relevance (ties: most recently saved first).
 * With no text terms (filters only / empty query) everything matching the filters is returned in
 * saved order, newest first.
 * @returns {{items: object[], scores: Map<string, number>, query: object}}
 */
export function searchIndex(index, input) {
  const query = typeof input === 'string' ? parseQuery(input) : input;
  const scores = new Map();
  let candidates = null; // Map(docIdx -> score) or null = all

  for (const term of query.terms) {
    const tokens = prefixRange(index.sortedTokens, term);
    const hit = new Map();
    for (const tok of tokens) {
      const bonus = tok === term ? 2 : 1;
      for (const [idx, w] of index.postings.get(tok)) {
        hit.set(idx, (hit.get(idx) ?? 0) + w * bonus);
      }
    }
    if (candidates === null) candidates = hit;
    else {
      const next = new Map();
      for (const [idx, s] of candidates) if (hit.has(idx)) next.set(idx, s + hit.get(idx));
      candidates = next;
    }
    if (candidates.size === 0) break;
  }

  const idxs = candidates ? [...candidates.keys()] : index.docs.map((_, i) => i);
  const results = [];
  for (const idx of idxs) {
    const doc = index.docs[idx];
    if (!matchesFilters(doc, query.filters)) continue;
    if (query.phrases.some((p) => !doc.haystack.includes(p))) continue;
    if (query.exclude.some((e) => (e.phrase ? doc.haystack.includes(e.phrase) : hasToken(index, e.token, idx)))) continue;
    const base = candidates ? candidates.get(idx) : 0;
    const phraseBonus = query.phrases.length * 5;
    scores.set(doc.item.id, base + phraseBonus);
    results.push(doc.item);
  }
  results.sort((a, b) => (scores.get(b.id) - scores.get(a.id)) || ((b.seq ?? 0) - (a.seq ?? 0)));
  return { items: results, scores, query };
}

function hasToken(index, token, idx) {
  // exclusion matches whole tokens only (so "-java" does not drop "javascript")
  return index.postings.get(token)?.has(idx) ?? false;
}

/** Sort helper used by api.js for non-relevance sorts. */
export const SORTERS = {
  saved: (a, b) => (b.seq ?? 0) - (a.seq ?? 0),
  'saved-asc': (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
  created: (a, b) => b.createdAt - a.createdAt,
  'created-asc': (a, b) => a.createdAt - b.createdAt,
  score: (a, b) => b.score - a.score,
  title: (a, b) => (a.title || '').localeCompare(b.title || ''),
};

// Deterministic fixture data in Reddit's real listing format
// (https://www.reddit.com/user/<name>/saved.json). Newest-saved first, like the real endpoint.

const SUBS = ['rust', 'javascript', 'programming', 'cooking', 'MachineLearning', 'personalfinance', 'woodworking'];
const DOMAINS = ['github.com', 'youtube.com', 'arxiv.org', 'blog.example.org', 'i.redd.it'];
const TOPICS = [
  'Understanding borrow checking in Rust', 'Why JavaScript promises resolve in microtasks',
  'Sourdough hydration cheat sheet', 'Index funds versus individual stocks', 'Dovetail joints by hand',
  'Transformer attention explained simply', 'A tour of the Linux scheduler', 'Résumé tips for senior engineers',
  'Café-style cold brew at home', 'SQLite is a great application file format',
];

export const base36 = (n) => n.toString(36).padStart(6, '0');

/** One saved child. `i` = position (0 = most recently saved). */
export function makeChild(i) {
  const id = base36(100000 + i);
  const sub = SUBS[i % SUBS.length];
  const topic = TOPICS[i % TOPICS.length];
  const created = 1_700_000_000 - i * 3600;
  if (i % 5 === 4) {
    return {
      kind: 't1',
      data: {
        name: `t1_${id}`, id, subreddit: sub, author: `commenter${i % 9}`,
        body: `Comment ${i}: ${topic} - the key insight is zeta${i}.`,
        link_title: topic, link_permalink: `https://www.reddit.com/r/${sub}/comments/p${id}/slug/`,
        permalink: `/r/${sub}/comments/p${id}/slug/c${id}/`, score: 10 + i, created_utc: created,
        over_18: false, saved: true,
      },
    };
  }
  const isSelf = i % 3 === 0;
  const removed = i === 13;
  return {
    kind: 't3',
    data: {
      name: `t3_${id}`, id, subreddit: sub, author: removed ? '[deleted]' : `poster${i % 7}`,
      title: `${topic} #${i}`,
      selftext: removed ? '[removed]' : isSelf ? `Self post body ${i} about ${topic}. keyword-${sub}` : '',
      is_self: isSelf,
      url: isSelf ? `https://www.reddit.com/r/${sub}/comments/${id}/slug/` : `https://${DOMAINS[i % DOMAINS.length]}/item/${i}`,
      url_overridden_by_dest: isSelf ? undefined : `https://${DOMAINS[i % DOMAINS.length]}/item/${i}`,
      domain: isSelf ? `self.${sub}` : DOMAINS[i % DOMAINS.length],
      permalink: `/r/${sub}/comments/${id}/slug/`, score: 100 + i, num_comments: i % 40,
      created_utc: created, over_18: i % 7 === 6, link_flair_text: i % 4 === 0 ? 'Discussion' : null,
      removed_by_category: removed ? 'moderator' : null, saved: true,
    },
  };
}

/** n children, newest first. `offset` shifts ids so newer items can be prepended later. */
export function makeChildren(n, from = 0) {
  return Array.from({ length: n }, (_, k) => makeChild(from + k));
}

export function listing(children, after = null) {
  return { kind: 'Listing', data: { after, dist: children.length, modhash: '', geo_filter: '', before: null, children } };
}

/**
 * A fake reddit.com for sync tests. `children` is mutable (unshift to simulate new saves).
 * `plan` is an optional list of one-shot overrides: { match: RegExp, status, headers, body }.
 */
export function createFakeReddit({ children = [], user = 'alice', loggedIn = true, plan = [], maxItems = 1000 } = {}) {
  const state = { children, user, loggedIn, plan, calls: [] };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    state.calls.push({ url: String(url), path: u.pathname, search: u.search, init });
    const override = state.plan.findIndex((p) => p.match.test(u.pathname + u.search));
    if (override >= 0) {
      const p = state.plan[override];
      if (!p.repeat) state.plan.splice(override, 1);
      if (p.throw) throw new TypeError('Failed to fetch');
      return new Response(p.body ?? '{}', { status: p.status ?? 200, headers: p.headers ?? {} });
    }
    if (u.pathname === '/api/me.json') {
      const body = state.loggedIn ? { kind: 't2', data: { name: state.user } } : {};
      return Response.json(body);
    }
    const m = /^\/user\/([^/]+)\/saved\.json$/.exec(u.pathname);
    if (m) {
      if (!state.loggedIn) return new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 25), 100);
      const after = u.searchParams.get('after');
      const visible = state.children.slice(0, maxItems);
      const start = after ? visible.findIndex((c) => c.data.name === after) + 1 : 0;
      const page = visible.slice(start, start + limit);
      const more = start + limit < visible.length;
      return Response.json(listing(page, more ? page.at(-1).data.name : null));
    }
    return new Response('not found', { status: 404 });
  };
  state.fetch = fetch;
  return state;
}

export const FAST_SYNC_CONFIG = (over = {}) => ({
  FREE_CAP: 300, STUB_LICENSE: true, REDDIT_ORIGIN: 'https://www.reddit.com', OFFLINE_GRACE_DAYS: 30,
  SYNC: { PAGE_SIZE: 100, DELAY_MS: 1500, JITTER_MS: 500, MAX_PAGES: 12, MAX_RETRIES: 3, BACKOFF_BASE_MS: 2000, MAX_WAIT_MS: 60000, LOCK_STALE_MS: 600000, ...over },
});

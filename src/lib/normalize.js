// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Convert Reddit "Listing" children (t3 = link/post, t1 = comment) into our flat item shape.
// Only fields we need are kept; nothing about other users beyond the public author name shown
// on the user's own saved item.

const MAX_BODY = 20000;
const REMOVED_BODIES = new Set(['[removed]', '[deleted]']);

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

export function absoluteUrl(path, origin = 'https://www.reddit.com') {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return origin + (path.startsWith('/') ? path : `/${path}`);
}

/** @returns {object|null} item or null if the child is not a saved post/comment. */
export function normalizeChild(child, { origin = 'https://www.reddit.com' } = {}) {
  if (!child || typeof child !== 'object') return null;
  const d = child.data;
  if (!d || typeof d !== 'object') return null;
  const kind = child.kind;
  if (kind !== 't3' && kind !== 't1') return null;
  const id = str(d.name) || (d.id ? `${kind}_${d.id}` : '');
  if (!id) return null;

  const base = {
    id,
    kind: kind === 't3' ? 'post' : 'comment',
    subreddit: str(d.subreddit),
    author: str(d.author) || '[deleted]',
    score: num(d.score),
    createdAt: Math.round(num(d.created_utc) * 1000),
    permalink: absoluteUrl(str(d.permalink), origin),
    nsfw: Boolean(d.over_18),
  };

  if (kind === 't3') {
    const selftext = str(d.selftext).slice(0, MAX_BODY);
    const isSelf = Boolean(d.is_self);
    const external = str(d.url_overridden_by_dest) || (isSelf ? '' : str(d.url));
    return {
      ...base,
      title: str(d.title),
      body: selftext,
      url: external,
      domain: isSelf ? '' : str(d.domain),
      numComments: num(d.num_comments),
      flair: str(d.link_flair_text),
      removedOnReddit:
        REMOVED_BODIES.has(selftext.trim()) || Boolean(d.removed_by_category),
    };
  }

  const body = str(d.body).slice(0, MAX_BODY);
  return {
    ...base,
    title: str(d.link_title),
    body,
    url: absoluteUrl(str(d.link_permalink), origin),
    domain: '',
    numComments: 0,
    flair: '',
    removedOnReddit: REMOVED_BODIES.has(body.trim()),
  };
}

export function isRemovedBody(text) {
  return REMOVED_BODIES.has(String(text ?? '').trim());
}

/** Normalise a whole listing page. Returns { items, after, skipped }. */
export function normalizeListing(json, opts) {
  const data = json?.data;
  const children = Array.isArray(data?.children) ? data.children : [];
  const items = [];
  let skipped = 0;
  for (const child of children) {
    const item = normalizeChild(child, opts);
    if (item) items.push(item);
    else skipped += 1;
  }
  return { items, after: data?.after ?? null, skipped };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeChild, normalizeListing } from '../src/lib/normalize.js';
import { makeChildren, listing } from './helpers/fixtures.js';

describe('normalize', () => {
  it('maps a real-shaped listing fixture (posts and comments)', () => {
    const json = JSON.parse(readFileSync(new URL('./fixtures/saved-sample.json', import.meta.url), 'utf8'));
    const { items, after, skipped } = normalizeListing(json);
    expect(after).toBe('t1_cmt001');
    expect(skipped).toBe(1); // the t5 (subreddit) child is not a saved post/comment
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ['t3_abc123', 'post'], ['t3_def456', 'post'], ['t1_cmt001', 'comment'],
    ]);
    const link = items[0];
    expect(link).toMatchObject({
      subreddit: 'rust', author: 'ferris', title: 'Borrow checker deep dive', domain: 'github.com',
      url: 'https://github.com/example/borrow', permalink: 'https://www.reddit.com/r/rust/comments/abc123/borrow_checker_deep_dive/',
      score: 1234, numComments: 56, createdAt: 1700000000000, nsfw: false, removedOnReddit: false,
    });
    const self = items[1];
    expect(self.body).toContain('hydration');
    expect(self.url).toBe(''); // self posts have no external URL
    expect(self.nsfw).toBe(true);
    const comment = items[2];
    expect(comment).toMatchObject({ title: 'Best sourdough starter', body: expect.stringContaining('feed it twice'), kind: 'comment' });
    expect(comment.url).toBe('https://www.reddit.com/r/Cooking/comments/zzz999/best_sourdough_starter/');
  });

  it('flags removed/deleted content and tolerates junk', () => {
    const removed = normalizeChild(makeChildren(14)[13]);
    expect(removed.removedOnReddit).toBe(true);
    expect(removed.author).toBe('[deleted]');
    expect(normalizeChild(null)).toBeNull();
    expect(normalizeChild({ kind: 't3' })).toBeNull();
    expect(normalizeChild({ kind: 't2', data: { name: 't2_x' } })).toBeNull();
    expect(normalizeListing({}).items).toEqual([]);
    expect(normalizeListing(listing([])).after).toBeNull();
  });
});

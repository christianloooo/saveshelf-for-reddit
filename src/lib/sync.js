// Sync the logged-in user's OWN saved posts/comments from reddit.com into the local library.
//
// Uses only the user's own session: GET /api/me.json (who am I) then
// GET /user/<me>/saved.json?limit=100&after=<cursor> (newest-saved first). No other users' data is
// requested. Polite by design: sequential requests only, a pause between pages, Retry-After /
// rate-limit headers honoured, bounded retries, and an early stop once the listing reaches items we
// already have (incremental sync).

import { CONFIG } from '../config.js';
import { normalizeListing } from './normalize.js';
import { LibraryError } from './errors.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SYNC_STATUS = Object.freeze({
  OK: 'ok', // finished normally
  CAPPED: 'capped', // free cap reached; some saves were not imported
  NOT_LOGGED_IN: 'not_logged_in',
  RATE_LIMITED: 'rate_limited',
  BUSY: 'busy',
  ABORTED: 'aborted',
  ERROR: 'error',
});

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetchImpl
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {() => Promise<number>} deps.getCap  max library size (Infinity for Pro)
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.random]
 * @param {(p:object)=>void} [deps.onProgress]
 */
export function createSyncer({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  store,
  getCap,
  sleep = defaultSleep,
  now = () => Date.now(),
  random = Math.random,
  onProgress = () => {},
  config = CONFIG,
}) {
  const cfg = config.SYNC;
  const origin = config.REDDIT_ORIGIN;
  let running = false;

  const progress = (p) => {
    try {
      onProgress(p);
    } catch {
      /* listeners must never break a sync */
    }
  };

  async function waitFor(ms, signal) {
    if (ms <= 0) return;
    await sleep(Math.min(ms, cfg.MAX_WAIT_MS));
    if (signal?.aborted) throw new LibraryError('ABORTED', 'Sync cancelled');
  }

  /** GET JSON with bounded retries, Retry-After and rate-limit header handling. */
  async function getJson(url, signal) {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw new LibraryError('ABORTED', 'Sync cancelled');
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new LibraryError('ABORTED', 'Sync cancelled');
        if (attempt++ < cfg.MAX_RETRIES) {
          await waitFor(cfg.BACKOFF_BASE_MS * 2 ** (attempt - 1), signal);
          continue;
        }
        throw new LibraryError('NETWORK', `Network error: ${err?.message ?? err}`);
      }

      if (res.status === 401 || res.status === 403) {
        throw new LibraryError('NOT_LOGGED_IN', 'Reddit refused the request. Are you logged in to reddit.com?');
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= cfg.MAX_RETRIES) {
          throw new LibraryError(res.status === 429 ? 'RATE_LIMITED' : 'HTTP', `Reddit responded ${res.status}`);
        }
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : cfg.BACKOFF_BASE_MS * 2 ** (attempt - 1);
        progress({ phase: 'waiting', reason: res.status === 429 ? 'rate-limited' : 'server-error', waitMs: wait });
        await waitFor(wait, signal);
        continue;
      }
      if (!res.ok) throw new LibraryError('HTTP', `Reddit responded ${res.status}`);

      let json;
      try {
        json = await res.json();
      } catch {
        // Logged-out / interstitial pages come back as HTML.
        throw new LibraryError('NOT_LOGGED_IN', 'Reddit returned a non-JSON page. Log in to reddit.com and retry.');
      }

      // Respect Reddit's advertised budget: if nearly exhausted, wait until the window resets.
      const remaining = Number(res.headers?.get?.('x-ratelimit-remaining'));
      const reset = Number(res.headers?.get?.('x-ratelimit-reset'));
      if (Number.isFinite(remaining) && remaining < 2 && Number.isFinite(reset) && reset > 0) {
        progress({ phase: 'waiting', reason: 'rate-limit-budget', waitMs: reset * 1000 });
        await waitFor(reset * 1000, signal);
      }
      return json;
    }
  }

  async function whoAmI(signal) {
    const json = await getJson(`${origin}/api/me.json?raw_json=1`, signal);
    const name = json?.data?.name ?? json?.name;
    if (typeof name !== 'string' || !name) {
      throw new LibraryError('NOT_LOGGED_IN', 'No logged-in Reddit user found. Log in to reddit.com first.');
    }
    return name;
  }

  async function acquireLock() {
    if (running) return false;
    running = true; // claim synchronously so two callers in the same tick cannot both pass
    const lock = await store.getMeta('syncLock');
    if (lock && now() - lock.at < cfg.LOCK_STALE_MS) {
      running = false;
      return false;
    }
    await store.setMeta('syncLock', { at: now() });
    return true;
  }
  async function releaseLock() {
    running = false;
    await store.setMeta('syncLock', null);
  }

  /**
   * Run one sync.
   * @param {{full?: boolean, signal?: AbortSignal}} [opts] full = ignore the incremental early stop.
   */
  async function run({ full = false, signal } = {}) {
    const result = {
      status: SYNC_STATUS.OK, user: null, pages: 0, fetched: 0, added: 0, updated: 0,
      skipped: 0, ignored: 0, incremental: false, error: null, startedAt: now(),
    };
    if (!(await acquireLock())) return { ...result, status: SYNC_STATUS.BUSY };

    try {
      const cap = await getCap();
      const startCount = await store.count();
      progress({ phase: 'identify' });
      result.user = await whoAmI(signal);
      await store.setMeta('redditUser', result.user);

      const initialDone = Boolean(await store.getMeta('initialSyncDone', false));
      // "Pending" = saves that exist on Reddit but were not stored because of the free cap.
      const startPending = new Set((await store.getMeta('pendingIds', [])) ?? []);
      const hasRoom = !Number.isFinite(cap) || startCount < cap;
      const needBackfill = startPending.size > 0 && hasRoom; // cap lifted / slots freed: walk everything
      // Incremental = stop at the first page that reaches something we already know (stored or pending).
      result.incremental = !full && !needBackfill && (initialDone || startPending.size > 0);
      const pendingNow = full || needBackfill ? new Set() : new Set(startPending);
      // Seq base: higher = saved more recently. 1000 slots per ms leaves room for a full listing.
      const seqBase = now() * 1000;

      let after = null;
      let reachedEnd = false;
      let cappedOut = false;
      let position = 0;

      for (let page = 1; page <= cfg.MAX_PAGES; page++) {
        const params = new URLSearchParams({ limit: String(cfg.PAGE_SIZE), raw_json: '1' });
        if (after) params.set('after', after);
        progress({ phase: 'fetching', page, ...pick(result) });
        const json = await getJson(
          `${origin}/user/${encodeURIComponent(result.user)}/saved.json?${params}`, signal);
        if (json?.kind !== 'Listing' || !Array.isArray(json?.data?.children)) {
          throw new LibraryError('BAD_RESPONSE', 'Unexpected response shape from Reddit');
        }
        const { items, after: next } = normalizeListing(json, { origin });
        result.pages = page;
        result.fetched += items.length;

        // newest-first within a page; positions keep order across pages and runs
        const seqd = items.map((it) => ({ ...it, seq: seqBase - position++ }));
        const w = await store.upsertItems(seqd, { cap });
        result.added += w.added;
        result.updated += w.updated;
        result.skipped += w.skipped;
        result.ignored += w.ignored;
        progress({ phase: 'saved', page, ...pick(result) });

        // Free cap hit: keep paging (politely) so we can report how many saves are waiting
        // ("pending") for an upgrade, but nothing more is stored (upsertItems refuses it).
        if (w.skipped > 0) cappedOut = true;
        for (const id of w.skippedIds) pendingNow.add(id);
        const reachedKnown = w.known > 0 || items.some((i) => startPending.has(i.id));
        if (result.incremental && reachedKnown) break; // reached what we already had
        if (!next || items.length === 0) {
          reachedEnd = true;
          break;
        }
        if (page === cfg.MAX_PAGES) {
          reachedEnd = true; // Reddit exposes ~1000 items; nothing further is retrievable
          break;
        }
        after = next;
        await waitFor(cfg.DELAY_MS + Math.floor(random() * cfg.JITTER_MS), signal);
      }

      const storedNow = pendingNow.size ? await store.existingIds([...pendingNow]) : new Set();
      // anything stored since (freed slots, Pro) is no longer pending
      const stillPending = pendingNow.size ? [...pendingNow].filter((id) => !storedNow.has(id)) : [];
      await store.setMeta('pendingIds', stillPending);
      await store.setMeta('pending', stillPending.length);
      if (stillPending.length > 0 && Number.isFinite(cap)) result.status = SYNC_STATUS.CAPPED;
      await finish(result, {
        markComplete: reachedEnd && stillPending.length === 0,
        markIncomplete: stillPending.length > 0,
      });
      return result;
    } catch (err) {
      const code = err instanceof LibraryError ? err.code : 'ERROR';
      result.status = {
        NOT_LOGGED_IN: SYNC_STATUS.NOT_LOGGED_IN,
        RATE_LIMITED: SYNC_STATUS.RATE_LIMITED,
        ABORTED: SYNC_STATUS.ABORTED,
      }[code] ?? SYNC_STATUS.ERROR;
      result.error = { code, message: err?.message ?? String(err) };
      await finish(result, {});
      return result;
    } finally {
      await releaseLock();
    }
  }

  async function finish(result, { markComplete = false, markIncomplete = false }) {
    if (markComplete) await store.setMeta('initialSyncDone', true);
    if (markIncomplete) await store.setMeta('initialSyncDone', false);
    result.finishedAt = now();
    if (result.status === SYNC_STATUS.OK || result.status === SYNC_STATUS.CAPPED) await store.setMeta('lastOkAt', result.finishedAt);
    await store.setMeta('lastSync', { ...result });
    progress({ phase: 'done', ...result });
  }

  const pick = (r) => ({ fetched: r.fetched, added: r.added, updated: r.updated, pages: r.pages });

  return { run, isRunning: () => running };
}

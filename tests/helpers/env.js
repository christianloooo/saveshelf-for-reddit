import { IDBFactory } from 'fake-indexeddb';
import { openDb } from '../../src/lib/db.js';
import { createStore } from '../../src/lib/store.js';
import { createSyncer } from '../../src/lib/sync.js';
import { createLicense } from '../../src/lib/license.js';
import { createAnalytics } from '../../src/lib/analytics.js';
import { createMemoryKv } from '../../src/lib/kv.js';
import { createApi } from '../../src/lib/api.js';
import { createFakeReddit, FAST_SYNC_CONFIG } from './fixtures.js';

/** A fully wired, isolated environment (fresh in-memory IndexedDB per call). */
export async function makeEnv({ children = [], pro = false, user = 'alice', syncOver = {}, loggedIn = true, plan = [], maxItems } = {}) {
  const idb = new IDBFactory();
  const db = await openDb({ indexedDB: idb, name: 'test' });
  let clock = 1_800_000_000_000;
  const now = () => (clock += 1000);
  const store = createStore(db, { now });
  const config = FAST_SYNC_CONFIG(syncOver);
  const kv = createMemoryKv();
  const stateKv = createMemoryKv();
  const conversions = [];
  const license = createLicense({ kv, now, config, onConversion: (s) => conversions.push(s) });
  if (pro) await license.setStubPro(true);
  const reddit = createFakeReddit({ children, user, loggedIn, plan, ...(maxItems ? { maxItems } : {}) });
  const sleeps = [];
  const syncer = createSyncer({
    fetchImpl: reddit.fetch, store, getCap: () => license.getCap(), now, config,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5,
  });
  const analyticsFetch = [];
  const analytics = createAnalytics({
    kv, version: '0.1.0', now, getTier: async () => ((await license.isPro()) ? 'pro' : 'free'),
    fetchImpl: async (url, init) => { analyticsFetch.push({ url, init }); return new Response('ok'); },
    config: { ANALYTICS_ENDPOINT: 'https://stats.example.com/e' }, uuid: () => 'anon-uuid-1',
  });
  const deps = { store, license, analytics, syncer, kv, stateKv, version: '0.1.0', now };
  const api = createApi(async () => deps);
  return { idb, db, store, kv, stateKv, license, reddit, sleeps, syncer, analytics, analyticsFetch, api, conversions, config, now, deps };
}

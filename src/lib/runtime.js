// Production wiring: real IndexedDB, chrome.storage, chrome.runtime messaging, BroadcastChannel.
// Two flavours share one database (same extension origin):
//   buildPageDeps()   - popup / library pages. Sync is delegated to the service worker.
//   buildWorkerDeps() - the service worker. Runs sync itself.

import { CONFIG } from '../config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createSyncer } from './sync.js';
import { createLicense } from './license.js';
import { createAnalytics } from './analytics.js';
import { getExtPayService } from './extpay.js';
import { createChromeKv } from './kv.js';

const version = () => globalThis.chrome?.runtime?.getManifest?.().version ?? '0.0.0';

async function buildCommon() {
  // null in stub mode (nothing is constructed); in real mode the ExtPay SDK instance. (Static import on purpose:
  // import() is not allowed in a service worker.)
  const extPay = getExtPayService();
  const db = await openDb();
  const store = createStore(db);
  const kv = createChromeKv('local');
  const stateKv = createChromeKv('session');
  const progressChannel = new BroadcastChannel('rsl-progress');
  const channel = new BroadcastChannel('rsl-data');

  let analytics;
  const license = createLicense({
    kv,
    provider: extPay?.provider ?? null, // null = stub mode (CONFIG.STUB_LICENSE)
    onConversion: () => analytics?.trackConversion(),
  });
  analytics = createAnalytics({
    kv,
    version: version(),
    getTier: async () => ((await license.isPro()) ? 'pro' : 'free'),
  });
  return { db, store, kv, stateKv, license, analytics, channel, progressChannel, version: version() };
}

export async function buildPageDeps() {
  const d = await buildCommon();
  return {
    ...d,
    syncer: null,
    remoteSync: async (opts) => {
      const res = await chrome.runtime.sendMessage({ type: 'sync:start', ...opts });
      if (!res) throw new Error('Background worker did not respond');
      return res;
    },
    onSettingsChanged: async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'settings:changed' });
      } catch {
        /* worker will pick the settings up on next wake */
      }
    },
  };
}

export async function buildWorkerDeps({ onSettingsChanged } = {}) {
  const d = await buildCommon();
  const syncer = createSyncer({
    store: d.store,
    getCap: () => d.license.getCap(),
    onProgress: (p) => {
      const running = p.phase !== 'done';
      // Writing to storage.session also counts as extension activity, keeping the worker alive.
      d.stateKv.set('syncProgress', { ...p, running, at: Date.now() }).catch(() => {});
      d.progressChannel.postMessage(p);
      // let open UI pages refresh as pages of saves land (rejects harmlessly when none is open)
      if (p.phase === 'saved' || p.phase === 'done') {
        chrome.runtime.sendMessage({ ns: 'saveshelf', event: 'changed', reason: 'sync-progress' }).catch(() => {});
      }
    },
    config: CONFIG,
  });
  return { ...d, syncer, remoteSync: null, onSettingsChanged };
}

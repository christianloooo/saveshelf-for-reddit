// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// MV3 service worker (ES module). Holds NO state in globals that matters: everything is in
// IndexedDB / chrome.storage, because the worker can be stopped at any time.
//
// Responsibilities: answer the UI's RPC (ui/sw-bridge.js contract), run syncs, optional periodic
// auto-sync (chrome.alarms), opt-in daily "active" analytics ping, license refresh.

import { registerUiRpc, notifyChanged } from '../ui/sw-bridge.js';
import { createApi } from './lib/api.js';
import { createUiHandlers } from './lib/ui-rpc.js';
import { buildWorkerDeps } from './lib/runtime.js';
import { getExtPayService, createPaidHandler } from './lib/extpay.js';

const ALARM_SYNC = 'auto-sync';
const ALARM_DAILY = 'daily';

let depsPromise;
const getDeps = () => (depsPromise ??= buildWorkerDeps({ onSettingsChanged: scheduleAlarms }));
const api = createApi(getDeps); // richer API (folders, import, settings); used by the options page too

// Listeners must be registered synchronously at top level so a cold-started worker receives events.
registerUiRpc(createUiHandlers(getDeps, { notifyChanged }));

// Real license mode only (EXTPAY_ID set; null in the default stub mode): ExtPay's message listener and
// onPaid callback must also be registered synchronously, because the payment-success page wakes the worker.
try {
  getExtPayService()?.startBackground(createPaidHandler(getDeps, { notifyChanged }));
} catch (e) {
  console.error('ExtensionPay setup failed (check manifest content_scripts and EXTPAY_ID)', e); // never block the other listeners
}

async function scheduleAlarms() {
  const s = await api.settings.get();
  if (s.autoSync) {
    await chrome.alarms.create(ALARM_SYNC, { delayInMinutes: 5, periodInMinutes: s.autoSyncHours * 60 });
  } else {
    await chrome.alarms.clear(ALARM_SYNC);
  }
  await chrome.alarms.create(ALARM_DAILY, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
}

async function runSync(opts) {
  const result = await api.sync.start(opts);
  notifyChanged('sync');
  return result;
}

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    await scheduleAlarms();
    if (details.reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('ui/library.html') });
  })().catch((e) => console.error('onInstalled failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms().catch((e) => console.error('onStartup failed', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  (async () => {
    if (alarm.name === ALARM_SYNC) {
      const s = await api.settings.get();
      if (s.autoSync) await runSync({ full: false });
    } else if (alarm.name === ALARM_DAILY) {
      const d = await getDeps();
      await d.license.refresh();
      await d.analytics.pingActive();
    }
  })().catch((e) => console.error('alarm handler failed', e));
});

// Internal messages from the options page (full sync, settings). The UI contract is handled above.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message?.type) return false;
  (async () => {
    switch (message.type) {
      case 'sync:start':
        return runSync({ full: Boolean(message.full) });
      case 'settings:changed':
        await scheduleAlarms();
        return { ok: true };
      default:
        return { error: 'unknown message' };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ status: 'error', error: { code: 'ERROR', message: String(e?.message ?? e) } }));
  return true; // async response
});

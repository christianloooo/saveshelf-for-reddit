// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
/**
 * Service-worker side of the UI contract. lecoder: import this in the service worker and pass your handlers.
 *
 *   import { registerUiRpc } from './ui/sw-bridge.js';
 *   registerUiRpc({ getItems, getFacets, addTag, removeTag, exportItems, getPlan, upgrade, getSyncStatus, syncNow });
 *
 * Then, whenever data changes (sync finished, plan changed...), call notifyChanged() so open UI pages refresh.
 * (Use `export-format.js` -> buildExport(items, format) inside exportItems if you like.)
 */
export function registerUiRpc(handlers) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.ns !== 'saveshelf' || !msg.method) return false;
    const fn = handlers[msg.method];
    if (!fn) { sendResponse({ ok: false, error: `Unknown method ${msg.method}` }); return false; }
    (async () => {
      try { sendResponse({ ok: true, result: await fn(...(msg.args ?? [])) }); }
      catch (err) { sendResponse({ ok: false, error: String(err?.message ?? err) }); }
    })();
    return true; // async response
  });
}

export function notifyChanged(reason = '') {
  // Rejects when no UI page is open - that is fine.
  chrome.runtime.sendMessage({ ns: 'saveshelf', event: 'changed', reason }).catch(() => {});
}

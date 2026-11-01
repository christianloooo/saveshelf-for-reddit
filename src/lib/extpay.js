// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// ExtensionPay (real license mode). Only used when CONFIG.STUB_LICENSE is false, i.e. EXTPAY_ID is set.
// The SDK is the official ExtPay 3.1.2, vendored unmodified in src/vendor/ (see README / tools/vendor-extpay.mjs).
//
//   service = getExtPayService()          null in stub mode, otherwise { extpay, provider, startBackground }
//   service.provider                      the license.js provider ({ getUser, openPaymentPage })
//   service.startBackground(onPaid)       SERVICE WORKER ONLY, once, synchronously at top level
//
// Nothing here touches the network at import or construction time; the SDK only talks to
// https://extensionpay.com when the user opens the payment page or the license is re-checked.

import ExtPay from '../vendor/ExtPay.esm.js';
import { CONFIG } from '../config.js';
import { extPayProvider } from './license.js';

/**
 * @param {{config?: object, ExtPayImpl?: Function}} [opts]  injectable for tests
 * @returns {null | {extpay: object, provider: object, startBackground: (onPaid?: Function) => void}}
 */
export function createExtPayService({ config = CONFIG, ExtPayImpl = ExtPay } = {}) {
  if (config.STUB_LICENSE) return null;
  if (!config.EXTPAY_ID) throw new Error('EXTPAY_ID is empty: set it in src/config.js (or stay in stub mode)');
  const extpay = ExtPayImpl(config.EXTPAY_ID);
  let started = false;
  return {
    extpay,
    provider: extPayProvider(extpay),
    startBackground(onPaid) {
      if (started) return; // the SDK must start exactly once per worker run
      started = true;
      extpay.startBackground();
      if (onPaid) extpay.onPaid.addListener(onPaid);
    },
  };
}

let shared;
/** Process-wide instance (one per service worker run / page). null in stub mode. */
export function getExtPayService() {
  if (shared === undefined) shared = createExtPayService();
  return shared;
}

/**
 * What to do when ExtensionPay reports a completed payment (service worker):
 * re-verify the license (this records the conversion for opt-in analytics), tell open UI pages, and
 * backfill the saves the free cap had held back. The SDK can call this again while we are still
 * re-verifying (getUser() itself triggers onPaid), so overlapping calls are dropped.
 */
export function createPaidHandler(getDeps, { notifyChanged = () => {} } = {}) {
  let busy = false;
  return async function onPaid() {
    if (busy) return false;
    busy = true;
    try {
      const d = await getDeps();
      const was = await d.license.isPro();
      await d.license.refresh();
      const now = await d.license.isPro();
      if (now !== was) notifyChanged('plan');
      if (now && !was && d.syncer) {
        d.syncer.run().then(() => notifyChanged('sync'), () => {}); // fire and forget; progress is persisted
      }
      return now;
    } finally {
      busy = false;
    }
  };
}

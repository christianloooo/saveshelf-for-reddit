// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Central, build-time configuration. Everything that is "stubbed" lives here so it is
// obvious what to change before publishing. See README.md ("Before you publish").

/** The ExtensionPay extension id (registered at extensionpay.com). Empty = stub mode.
 *  The plan itself ($1.50 one-time, nickname 'pro') lives in the ExtensionPay dashboard, NOT in this code: the extension
 *  never names a plan or sets a price on the payment page (PRO_PRICE_USD below is display text only). Stripe must be
 *  connected on the ExtensionPay account before live payments work. */
const EXTPAY_ID = 'saveshelf-for-reddit';
/** Dev override: stay in stub mode even when EXTPAY_ID is set. */
const FORCE_STUB_LICENSE = false;

export const CONFIG = Object.freeze({
  /** Max items a free user can keep in the library. Pro = unlimited. */
  FREE_CAP: 300,
  PRO_PRICE_USD: 1.5,

  /**
   * License / payments (ExtensionPay).
   * EXTPAY_ID = ''        -> STUB mode (tests, local dev): no network, no account, Pro is a local flag (license.js).
   * EXTPAY_ID = '<id>'    -> REAL mode: the vendored ExtPay SDK (src/vendor/, see README) checks/sells Pro.
   * STUB_LICENSE is derived from those two; FORCE_STUB_LICENSE = true keeps stub mode even with an id set.
   * Shipped release config: EXTPAY_ID is set, so builds are real mode. Unit tests blank it (vitest.config.js) to test stub mode.
   */
  STUB_LICENSE: FORCE_STUB_LICENSE || !EXTPAY_ID,
  EXTPAY_ID,
  /** If ExtensionPay cannot be reached, keep honouring a previously verified purchase this long. */
  OFFLINE_GRACE_DAYS: 30,

  /**
   * Analytics (opt-in, anonymous). Empty string = analytics are fully disabled (nothing is sent
   * even if the user opts in). Must be an https:// URL that accepts a CORS POST of text/plain JSON.
   */
  ANALYTICS_ENDPOINT: '',

  REDDIT_ORIGIN: 'https://www.reddit.com',

  SYNC: Object.freeze({
    PAGE_SIZE: 100, // Reddit's maximum for listings
    DELAY_MS: 1500, // polite pause between page requests
    JITTER_MS: 500,
    MAX_PAGES: 12, // Reddit only serves ~1000 saved items (10 pages of 100); small safety margin
    MAX_RETRIES: 3,
    BACKOFF_BASE_MS: 2000,
    MAX_WAIT_MS: 60000, // never wait longer than this for a single Retry-After
    LOCK_STALE_MS: 10 * 60 * 1000,
  }),

  AUTO_SYNC_DEFAULT_HOURS: 6,
});

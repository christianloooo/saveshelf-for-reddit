// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { createLicense, extPayProvider } from '../src/lib/license.js';
import { createMemoryKv } from '../src/lib/kv.js';
import { CONFIG } from '../src/config.js';
import { makeEnv } from './helpers/env.js';
import { makeChildren } from './helpers/fixtures.js';

const DAY = 86400000;
const realCfg = { ...CONFIG, STUB_LICENSE: false };

describe('license (stub mode)', () => {
  it('ships in stub mode with a 300 cap and $1.50 price', () => {
    expect(CONFIG.STUB_LICENSE).toBe(true);
    expect(CONFIG.FREE_CAP).toBe(300);
    expect(CONFIG.PRO_PRICE_USD).toBe(1.5);
    expect(CONFIG.EXTPAY_ID).toBe('');
  });

  it('free by default, Pro after the local test flag, cap follows tier, no network', async () => {
    const lic = createLicense({ kv: createMemoryKv() });
    expect(await lic.status()).toMatchObject({ tier: 'free', paid: false, stub: true, source: 'stub' });
    expect(await lic.getCap()).toBe(300);
    expect((await lic.startUpgrade()).stub).toBe(true);
    await lic.setStubPro(true);
    expect(await lic.isPro()).toBe(true);
    expect(await lic.getCap()).toBe(Infinity);
    await lic.setStubPro(false);
    expect(await lic.getCap()).toBe(300);
  });

  it('fires onConversion once on free -> pro', async () => {
    const calls = [];
    const lic = createLicense({ kv: createMemoryKv(), onConversion: (s) => calls.push(s) });
    await lic.setStubPro(true);
    await lic.refresh();
    await lic.refresh();
    expect(calls).toEqual(['stub']);
  });

  it('setStubPro is unavailable outside stub mode', async () => {
    const lic = createLicense({ kv: createMemoryKv(), config: realCfg });
    await expect(lic.setStubPro(true)).rejects.toThrow();
  });
});

describe('license (provider mode, ExtensionPay shape)', () => {
  const mk = (getUser, clock) => createLicense({
    kv: createMemoryKv(), config: realCfg, now: () => clock.t,
    provider: { getUser, openPaymentPage: async () => { clock.opened = true; } },
  });

  it('treats a paid user as Pro and an unpaid user as Free', async () => {
    const clock = { t: 1e12 };
    let paid = false;
    const lic = mk(async () => ({ paid }), clock);
    expect(await lic.getCap()).toBe(300);
    await lic.refresh();
    expect((await lic.status()).tier).toBe('free');
    paid = true;
    await lic.refresh();
    expect(await lic.status()).toMatchObject({ tier: 'pro', source: 'extpay' });
    expect(await lic.getCap()).toBe(Infinity);
    paid = false; // refund / revoked
    await lic.refresh();
    expect((await lic.status()).tier).toBe('free');
  });

  it('keeps honouring a verified purchase while offline, for 30 days only', async () => {
    const clock = { t: 1e12 };
    let fail = false;
    const lic = mk(async () => { if (fail) throw new Error('offline'); return { paid: true }; }, clock);
    await lic.refresh();
    fail = true;
    clock.t += 10 * DAY;
    await lic.refresh();
    expect(await lic.status()).toMatchObject({ tier: 'pro', source: 'extpay-grace' });
    clock.t += 21 * DAY; // 31 days since last successful verification
    await lic.refresh();
    expect((await lic.status()).tier).toBe('free');
  });

  it('opens the payment page via the provider', async () => {
    const clock = { t: 1 };
    const lic = mk(async () => ({ paid: false }), clock);
    expect(await lic.startUpgrade()).toEqual({ stub: false, opened: true });
    expect(clock.opened).toBe(true);
  });

  it('adapts the ExtensionPay SDK shape', async () => {
    const sdk = { getUser: async () => ({ paid: true, email: 'x@y' }), openPaymentPage: async () => {} };
    const p = extPayProvider(sdk);
    expect(await p.getUser()).toEqual({ paid: true }); // email etc. are not passed on
  });

  it('without a provider (misconfigured real mode) stays free', async () => {
    const lic = createLicense({ kv: createMemoryKv(), config: realCfg });
    await lic.refresh();
    expect(await lic.getCap()).toBe(300);
  });
});

describe('Pro check end-to-end', () => {
  it('free user is capped; flipping Pro lifts the cap on import/sync paths', async () => {
    const env = await makeEnv({ children: makeChildren(320) });
    expect((await env.api.license.status()).cap).toBe(300);
    await env.api.sync.start();
    expect((await env.api.library.stats())).toMatchObject({ total: 300, atCap: true, cap: 300, remaining: 0, tier: 'free' });
    await env.api.license.setStubPro(true);
    expect(env.conversions).toEqual(['stub']);
    expect((await env.api.library.stats())).toMatchObject({ cap: null, atCap: false, tier: 'pro' });
    await env.api.sync.start({ full: true });
    expect((await env.api.library.stats()).total).toBe(320);
  });
});

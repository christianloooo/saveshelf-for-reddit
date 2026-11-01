// License / Pro check.
//
// STUBBED: with CONFIG.STUB_LICENSE = true (the default) there is no network, no ExtensionPay
// account and no payment. "Pro" is a local flag toggled from Settings (test mode) so the whole Pro
// path (cap lifted) is exercisable. The real implementation plugs in via the `provider` interface:
//   provider.getUser()        -> Promise<{ paid: boolean }>
//   provider.openPaymentPage() -> Promise<void>
// `extPayProvider(extpay)` adapts the ExtensionPay SDK object to that interface.

import { CONFIG } from '../config.js';

const KEY = 'license';
const DAY = 24 * 60 * 60 * 1000;

/** Adapt an ExtensionPay SDK instance (ExtPay('<id>')) to our provider interface. */
export function extPayProvider(extpay) {
  return {
    async getUser() {
      const user = await extpay.getUser();
      return { paid: Boolean(user?.paid) };
    },
    async openPaymentPage() {
      await extpay.openPaymentPage();
    },
  };
}

/**
 * @param {object} deps
 * @param {{get:Function,set:Function,remove:Function}} deps.kv
 * @param {{getUser:Function,openPaymentPage:Function}|null} [deps.provider]  required when STUB_LICENSE is false
 * @param {() => number} [deps.now]
 * @param {(event:string)=>void} [deps.onConversion] called when a free->paid transition is detected
 */
export function createLicense({ kv, provider = null, now = () => Date.now(), onConversion = () => {}, config = CONFIG }) {
  const stub = Boolean(config.STUB_LICENSE);

  async function readCache() {
    return (await kv.get(KEY, {})) ?? {};
  }

  /** Re-check entitlement (network in real mode) and cache the answer. */
  async function refresh() {
    const cache = await readCache();
    const wasPaid = Boolean(cache.paid);

    if (stub) {
      const paid = cache.stubPro === true;
      await kv.set(KEY, { ...cache, paid, checkedAt: now() });
      if (paid && !wasPaid) onConversion('stub');
      return status();
    }

    if (!provider) {
      return { tier: 'free', paid: false, source: 'unconfigured', stub: false, checkedAt: now() };
    }

    try {
      const user = await provider.getUser();
      const paid = Boolean(user?.paid);
      await kv.set(KEY, {
        ...cache,
        paid,
        checkedAt: now(),
        lastPaidAt: paid ? now() : undefined,
        lastFailedAt: undefined,
      });
      if (paid && !wasPaid) onConversion('extpay');
    } catch {
      // offline / ExtensionPay down: keep the cached entitlement; status() applies the grace period
      await kv.set(KEY, { ...cache, lastFailedAt: now() });
    }
    return status();
  }

  /** Current entitlement from cache (call refresh() first for a live check). */
  async function status() {
    const c = await readCache();
    if (stub) {
      const paid = c.stubPro === true;
      return { tier: paid ? 'pro' : 'free', paid, source: 'stub', stub: true, checkedAt: c.checkedAt ?? null };
    }
    if (c.paid) {
      // Verified paid at lastPaidAt. If later live checks failed (offline / ExtensionPay down) we keep
      // honouring the purchase until the grace period after the last successful paid check expires.
      const verified = c.lastPaidAt ?? 0;
      const age = now() - verified;
      if (age < config.OFFLINE_GRACE_DAYS * DAY) {
        return {
          tier: 'pro', paid: true, stub: false, checkedAt: c.checkedAt ?? null,
          source: (c.lastFailedAt ?? 0) > verified ? 'extpay-grace' : 'extpay',
        };
      }
    }
    return { tier: 'free', paid: false, source: provider ? 'extpay' : 'unconfigured', stub: false, checkedAt: c.checkedAt ?? null };
  }

  async function isPro() {
    return (await status()).paid;
  }

  /** Library size limit for the current tier. */
  async function getCap() {
    return (await isPro()) ? Infinity : config.FREE_CAP;
  }

  async function startUpgrade() {
    if (stub) return { stub: true, opened: false, message: 'Payments are stubbed in this build.' };
    if (!provider) throw new Error('License provider not configured');
    await provider.openPaymentPage();
    return { stub: false, opened: true };
  }

  /** TEST MODE ONLY (STUB_LICENSE): flip the local Pro flag. */
  async function setStubPro(enabled) {
    if (!stub) throw new Error('setStubPro is only available when STUB_LICENSE is true');
    const cache = await readCache();
    await kv.set(KEY, { ...cache, stubPro: Boolean(enabled) });
    return refresh();
  }

  return { refresh, status, isPro, getCap, startUpgrade, setStubPro };
}

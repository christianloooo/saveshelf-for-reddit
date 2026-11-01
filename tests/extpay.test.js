// Real license mode (EXTPAY_ID set), with ExtPay mocked: no account, no network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createExtPayService, getExtPayService, createPaidHandler } from '../src/lib/extpay.js';
import { createSyncer } from '../src/lib/sync.js';
import { createLicense } from '../src/lib/license.js';
import { createUiHandlers } from '../src/lib/ui-rpc.js';
import { createMemoryKv } from '../src/lib/kv.js';
import { CONFIG } from '../src/config.js';
import { makeEnv } from './helpers/env.js';
import { makeChildren } from './helpers/fixtures.js';

// The vendored SDK (webextension-polyfill inside) refuses to load outside an extension, so give it a tiny
// in-memory chrome.* (callback style, like the real thing) BEFORE anything imports it.
const fake = vi.hoisted(() => {
  const manifest = JSON.parse(JSON.stringify({ content_scripts: [{ matches: ['https://extensionpay.com/*'], js: ['src/vendor/ExtPay.js'], run_at: 'document_start' }] }));
  const sync = {};
  const listeners = [];
  const area = (data) => ({
    get: (keys, cb) => { const out = {}; for (const k of [].concat(keys)) if (k in data) out[k] = data[k]; cb(out); },
    set: (obj, cb) => { Object.assign(data, obj); cb?.(); },
  });
  const created = [];
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id', lastError: undefined, getManifest: () => manifest,
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {}, hasListener: () => false },
    },
    storage: { sync: area(sync), local: area({}) },
    management: { getSelf: (cb) => cb({ installType: 'development', permissions: ['storage'], hostPermissions: [] }) },
    tabs: { create: (o, cb) => { created.push(o); cb?.({ id: 1 }); } },
  };
  return { manifest, sync, listeners, created };
});

const realCfg = { ...CONFIG, EXTPAY_ID: 'saveshelf-test', STUB_LICENSE: false };

/**
 * A stand-in for ExtPay('<id>') that behaves like the SDK in the ways that matter here: getUser() is a
 * network call, and it fires the onPaid callbacks the first time it sees a paid user (even when the
 * caller is us, re-checking from inside the callback).
 */
function makeMockExtPay({ paid = false } = {}) {
  const calls = { ctor: [], startBackground: 0, getUser: 0, openPaymentPage: 0 };
  const paidCbs = [];
  const state = { paid, announced: false, failing: false };
  const instance = {
    getUser: async () => {
      calls.getUser += 1;
      if (state.failing) throw new Error('offline');
      if (state.paid && !state.announced) { state.announced = true; paidCbs.forEach((cb) => cb({ paid: true })); }
      return { paid: state.paid, email: 'a@b.c' };
    },
    openPaymentPage: async () => { calls.openPaymentPage += 1; },
    startBackground: () => { calls.startBackground += 1; },
    onPaid: { addListener: (cb) => paidCbs.push(cb) },
  };
  const ExtPayImpl = (id) => { calls.ctor.push(id); return instance; };
  return { ExtPayImpl, instance, calls, state, firePaid: () => paidCbs.forEach((cb) => cb({ paid: true })) };
}

/** Handlers/deps for a free user wired to a REAL-mode license whose provider is the mocked ExtPay. */
async function realModeEnv({ children = [], paid = false } = {}) {
  const env = await makeEnv({ children });
  const mock = makeMockExtPay({ paid });
  const svc = createExtPayService({ config: realCfg, ExtPayImpl: mock.ExtPayImpl });
  const conversions = [];
  let clock = 1_800_000_000_000;
  const now = () => (clock += 1000);
  const license = createLicense({ kv: createMemoryKv(), provider: svc.provider, config: realCfg, now, onConversion: (s) => conversions.push(s) });
  const events = [];
  // the syncer must see THIS license's cap (makeEnv wires its own stub license)
  const syncer = createSyncer({ fetchImpl: env.reddit.fetch, store: env.store, getCap: () => license.getCap(), now, config: env.config, sleep: async () => {}, random: () => 0.5 });
  const deps = { ...env.deps, license, syncer, now, conversions };
  const getDeps = async () => deps;
  const notifyChanged = (r) => events.push(r);
  const handlers = createUiHandlers(getDeps, { notifyChanged });
  return { env, mock, svc, license, deps, getDeps, handlers, events, conversions, advance: (ms) => { clock += ms; } };
}

describe('mode selection', () => {
  it('stub is the default: no EXTPAY_ID, no ExtPay instance, nothing constructed', () => {
    expect(CONFIG.EXTPAY_ID).toBe('');
    expect(CONFIG.STUB_LICENSE).toBe(true);
    expect(createExtPayService()).toBeNull();
    expect(getExtPayService()).toBeNull();
    const mock = makeMockExtPay();
    expect(createExtPayService({ config: CONFIG, ExtPayImpl: mock.ExtPayImpl })).toBeNull();
    expect(mock.calls.ctor).toEqual([]);
  });

  it('setting EXTPAY_ID alone leaves stub mode (the derived flag in src/config.js)', () => {
    const src = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
    const derive = (id, force) => {
      const body = src.replace(/const EXTPAY_ID = '[^']*';/, `const EXTPAY_ID = '${id}';`).replace(/const FORCE_STUB_LICENSE = \w+;/, `const FORCE_STUB_LICENSE = ${force};`)
        .replace('export const CONFIG = ', 'return ');
      return new Function(body)().STUB_LICENSE;
    };
    expect(derive('', false)).toBe(true);
    expect(derive('my-ext', false)).toBe(false);
    expect(derive('my-ext', true)).toBe(true);
  });

  it('real mode constructs ExtPay with the configured id; an empty id with the stub flag off is a loud error', () => {
    const mock = makeMockExtPay();
    const svc = createExtPayService({ config: realCfg, ExtPayImpl: mock.ExtPayImpl });
    expect(mock.calls.ctor).toEqual(['saveshelf-test']);
    expect(svc.extpay).toBe(mock.instance);
    expect(() => createExtPayService({ config: { ...realCfg, EXTPAY_ID: '' }, ExtPayImpl: mock.ExtPayImpl })).toThrow(/EXTPAY_ID/);
  });

  it('startBackground runs the SDK once and registers the onPaid listener', () => {
    const mock = makeMockExtPay();
    const svc = createExtPayService({ config: realCfg, ExtPayImpl: mock.ExtPayImpl });
    const cb = vi.fn();
    svc.startBackground(cb);
    svc.startBackground(cb);
    expect(mock.calls.startBackground).toBe(1);
    mock.firePaid();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('real mode: upgrade', () => {
  it('opens the ExtensionPay payment page and does NOT flip the plan locally', async () => {
    const t = await realModeEnv();
    const r = await t.handlers.upgrade();
    expect(r).toEqual({ opened: true, stub: false });
    expect(t.mock.calls.openPaymentPage).toBe(1);
    expect(await t.handlers.getPlan()).toMatchObject({ plan: 'free', cap: 300 });
    expect(t.conversions).toEqual([]);
  });

  it('the stub-only test toggle is unavailable in real mode', async () => {
    const t = await realModeEnv();
    await expect(t.license.setStubPro(true)).rejects.toThrow();
  });
});

describe('real mode: getPlan', () => {
  it('free until ExtensionPay says paid, then pro, and the pending saves are backfilled', async () => {
    const t = await realModeEnv({ children: makeChildren(320) });
    await t.deps.syncer.run();
    const free = await t.handlers.getPlan();
    expect(free).toMatchObject({ plan: 'free', count: 300, cap: 300, limitReached: true });
    expect(free.pending).toBeGreaterThan(0);
    // the user pays on extensionpay.com, closes the tab, the UI re-reads the plan
    t.mock.state.paid = true;
    t.advance(31_000); // the free-tier re-check is rate limited to once per 30 s
    const pro = await t.handlers.getPlan();
    expect(pro).toMatchObject({ plan: 'pro', cap: null, pending: 0, limitReached: false });
    expect(t.events).toContain('plan');
    await vi.waitFor(async () => expect((await t.handlers.getPlan()).count).toBe(320));
    expect(t.conversions).toEqual(['extpay']);
  });

  it('re-checks a free user at most every 30 s (no hammering of extensionpay.com)', async () => {
    const t = await realModeEnv();
    await t.handlers.getPlan();
    await t.handlers.getPlan();
    expect(t.mock.calls.getUser).toBe(1);
    t.advance(31_000);
    await t.handlers.getPlan();
    expect(t.mock.calls.getUser).toBe(2);
  });

  it('a paid user is pro; an unreachable ExtensionPay keeps a verified purchase (offline grace) and a free user free', async () => {
    const t = await realModeEnv({ paid: true });
    await t.license.refresh();
    expect(await t.handlers.getPlan()).toMatchObject({ plan: 'pro', cap: null });
    t.mock.state.failing = true;
    t.advance(10 * 86400000);
    await t.license.refresh();
    expect(await t.license.status()).toMatchObject({ tier: 'pro', source: 'extpay-grace' });

    const free = await realModeEnv();
    free.mock.state.failing = true;
    expect(await free.handlers.getPlan()).toMatchObject({ plan: 'free' }); // getPlan swallows the failure
  });
});

describe('real mode: onPaid', () => {
  it('re-verifies, records one conversion, notifies the UI and backfills what the cap held back', async () => {
    const t = await realModeEnv({ children: makeChildren(320) });
    await t.deps.syncer.run();
    expect((await t.handlers.getPlan()).plan).toBe('free');
    const synced = new Promise((res) => { const real = t.deps.syncer; t.deps.syncer = { run: async () => { await real.run(); res(); } }; });
    const events = [];
    const onPaid = createPaidHandler(t.getDeps, { notifyChanged: (r) => events.push(r) });
    t.svc.startBackground(onPaid);

    t.mock.state.paid = true;
    expect(await onPaid()).toBe(true);
    await synced;
    expect(await t.license.isPro()).toBe(true);
    expect(events).toContain('plan');
    await vi.waitFor(() => expect(events).toContain('sync'));
    expect(t.conversions).toEqual(['extpay']);
    expect((await t.handlers.getPlan()).count).toBe(320);
  });

  it('the SDK firing onPaid from inside our own getUser() does not recurse or double-count', async () => {
    const t = await realModeEnv();
    const events = [];
    const onPaid = createPaidHandler(t.getDeps, { notifyChanged: (r) => events.push(r) });
    t.svc.startBackground(onPaid); // SDK callback -> our handler
    t.mock.state.paid = true;
    await onPaid();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.mock.calls.getUser).toBe(1);
    expect(t.conversions).toEqual(['extpay']);
    expect(events.filter((e) => e === 'plan')).toHaveLength(1);
  });

  it('is a no-op when the user is not (yet) paid, and survives an offline ExtensionPay', async () => {
    const t = await realModeEnv();
    const events = [];
    const onPaid = createPaidHandler(t.getDeps, { notifyChanged: (r) => events.push(r) });
    expect(await onPaid()).toBe(false);
    t.mock.state.failing = true;
    expect(await onPaid()).toBe(false);
    expect(events).toEqual([]);
    expect(t.conversions).toEqual([]);
  });
});

describe('the vendored official SDK (offline, chrome.* faked, fetch mocked)', () => {
  afterEach(() => { vi.unstubAllGlobals(); for (const k of Object.keys(fake.sync)) delete fake.sync[k]; fake.listeners.length = 0; fake.created.length = 0; fake.manifest.content_scripts[0].run_at = 'document_start'; });
  const sdk = async () => (await import('../src/vendor/ExtPay.esm.js')).default;

  it('imports as an ES module and getUser() without an api key reports unpaid without any network call', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network must not be touched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const svc = createExtPayService({ config: realCfg, ExtPayImpl: await sdk() });
    expect(await svc.provider.getUser()).toEqual({ paid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('onPaid needs the manifest content script (the SDK enforces it) and startBackground adds one message listener', async () => {
    const svc = createExtPayService({ config: realCfg, ExtPayImpl: await sdk() });
    svc.startBackground(() => {});
    expect(fake.listeners).toHaveLength(1);
    fake.manifest.content_scripts[0].run_at = 'document_idle';
    const again = createExtPayService({ config: realCfg, ExtPayImpl: await sdk() });
    expect(() => again.startBackground(() => {})).toThrow(/document start/);
  });

  it('end to end with the real SDK: payment page URL, then a paid user fires onPaid once and the license becomes Pro', async () => {
    const urls = [];
    let paidAt = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      urls.push(`${init?.method ?? 'GET'} ${url.replace(/api_key=[^&]+/, 'api_key=KEY')}`);
      if (url.endsWith('/api/new-key')) return Response.json('KEY123');
      return Response.json({ paid: Boolean(paidAt), paidAt, trialStartedAt: null, email: null });
    }));
    const events = [];
    const kv = createMemoryKv();
    const conversions = [];
    const svc = createExtPayService({ config: realCfg, ExtPayImpl: await sdk() });
    const license = createLicense({ kv, provider: svc.provider, config: realCfg, onConversion: (s) => conversions.push(s) });
    const onPaid = createPaidHandler(async () => ({ license, syncer: null }), { notifyChanged: (r) => events.push(r) });
    svc.startBackground(onPaid);

    expect(await license.startUpgrade()).toEqual({ stub: false, opened: true });
    expect(fake.created).toEqual([{ url: 'https://extensionpay.com/extension/saveshelf-test/choose-plan?api_key=KEY123', active: true }]);
    expect(urls).toEqual(['POST https://extensionpay.com/extension/saveshelf-test/api/new-key']);

    // extensionpay.com's success page -> content script -> background message -> the SDK polls the user
    paidAt = '2026-11-01T09:00:00.000Z';
    fake.listeners[0]('extpay-fetch-user', {}, () => {});
    await vi.waitFor(async () => expect(await license.isPro()).toBe(true), { timeout: 2000 });
    expect(conversions).toEqual(['extpay']);
    expect(events).toEqual(['plan']);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('plan and price live in the ExtensionPay dashboard, not in code', () => {
  it('never names a plan nickname or passes one to the payment page', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = new URL('../src/lib/', import.meta.url);
    const files = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => new URL(f, dir)), new URL('../src/background.js', import.meta.url)];
    for (const f of files) {
      const text = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(text, f.pathname).not.toMatch(/nickname|getPlans|planNickname/i);
      expect(text, f.pathname).not.toMatch(/openPaymentPage\(\s*[^)\s]/); // always the default plan
    }
  });
});

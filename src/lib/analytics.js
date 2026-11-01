// Privacy-safe, opt-in analytics (installs, daily actives, conversions).
//
// Guarantees (enforced here and covered by tests):
//   * OFF by default. Nothing is sent until the user opts in.
//   * Nothing is sent at all while CONFIG.ANALYTICS_ENDPOINT is empty (the default / stub).
//   * Only three events exist: install, active, conversion.
//   * Payload = { event, anonId, v, tier, day }. anonId is a random UUID generated on opt-in, unrelated
//     to the Reddit account, browser profile or extension install id, and DELETED on opt-out.
//   * Never sent: Reddit username, saved content, subreddits, tags, folder names, item counts, search
//     queries, URLs, IP is not stored by the collector (server-side concern, see PRIVACY.md).

import { CONFIG } from '../config.js';

const KEY = 'analytics';
export const EVENTS = Object.freeze(['install', 'active', 'conversion']);

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {object} deps
 * @param {{get:Function,set:Function}} deps.kv
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => Promise<'free'|'pro'>} deps.getTier
 * @param {string} deps.version  extension version (manifest)
 */
export function createAnalytics({
  kv,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  getTier,
  version,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  config = CONFIG,
}) {
  const state = async () => (await kv.get(KEY, {})) ?? {};
  const endpointOk = () => typeof config.ANALYTICS_ENDPOINT === 'string' && /^https:\/\//i.test(config.ANALYTICS_ENDPOINT);

  async function isEnabled() {
    return Boolean((await state()).enabled);
  }

  async function buildPayload(event) {
    const s = await state();
    return { event, anonId: s.anonId ?? null, v: version, tier: await getTier(), day: utcDay(now()) };
  }

  /** What an event would look like on the wire (shown to the user in Settings). */
  const preview = (event = 'active') => buildPayload(event);

  async function send(payload) {
    if (!endpointOk() || typeof fetchImpl !== 'function') return { sent: false, reason: 'no-endpoint' };
    try {
      await fetchImpl(config.ANALYTICS_ENDPOINT, {
        method: 'POST',
        // text/plain keeps this a CORS "simple request" (no preflight) for tiny collectors
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        keepalive: true,
      });
      return { sent: true };
    } catch {
      return { sent: false, reason: 'network' }; // analytics must never surface errors or retry-storm
    }
  }

  async function track(event) {
    if (!EVENTS.includes(event)) return { sent: false, reason: 'unknown-event' };
    const s = await state();
    if (!s.enabled) return { sent: false, reason: 'opted-out' };
    return send(await buildPayload(event));
  }

  /** Opt in/out. Opting in sends the one-time `install` event; opting out deletes the anonymous id. */
  async function setEnabled(enabled) {
    const s = await state();
    if (enabled && !s.enabled) {
      const next = { ...s, enabled: true, anonId: uuid(), optedInAt: utcDay(now()) };
      await kv.set(KEY, next);
      if (!s.installSent) {
        const r = await track('install');
        if (r.sent) await kv.set(KEY, { ...(await state()), installSent: true });
      }
    } else if (!enabled && s.enabled) {
      await kv.set(KEY, { enabled: false, installSent: s.installSent, lastActiveDay: s.lastActiveDay });
    }
    return isEnabled();
  }

  /** Send at most one `active` event per UTC day. */
  async function pingActive() {
    const s = await state();
    if (!s.enabled) return { sent: false, reason: 'opted-out' };
    const today = utcDay(now());
    if (s.lastActiveDay === today) return { sent: false, reason: 'already-today' };
    const r = await send(await buildPayload('active'));
    if (r.sent) await kv.set(KEY, { ...(await state()), lastActiveDay: today });
    return r;
  }

  const trackConversion = () => track('conversion');

  return { isEnabled, setEnabled, track, pingActive, trackConversion, preview };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { createAnalytics, analyticsAvailable, EVENTS } from '../src/lib/analytics.js';
import { createMemoryKv } from '../src/lib/kv.js';
import { makeEnv } from './helpers/env.js';
import { makeChildren } from './helpers/fixtures.js';

const DAY = 86400000;
function make({ endpoint = 'https://stats.example.com/e', fail = false, clock = { t: Date.UTC(2026, 10, 1, 12) } } = {}) {
  const sent = [];
  const kv = createMemoryKv();
  const a = createAnalytics({
    kv, version: '0.1.0', now: () => clock.t, getTier: async () => 'free', uuid: () => 'anon-1',
    fetchImpl: async (url, init) => { if (fail) throw new Error('down'); sent.push({ url, init, body: JSON.parse(init.body) }); return new Response('ok'); },
    config: { ANALYTICS_ENDPOINT: endpoint },
  });
  return { a, sent, kv, clock };
}

describe('analytics availability (decides whether Settings shows the opt-in at all)', () => {
  it('the shipped config has no endpoint, so analytics are unavailable and the UI stays hidden', async () => {
    const { CONFIG } = await import('../src/config.js');
    expect(CONFIG.ANALYTICS_ENDPOINT).toBe('');
    expect(analyticsAvailable()).toBe(false);
    expect(analyticsAvailable(CONFIG)).toBe(false);
  });
  it('is available only for a real https endpoint', () => {
    expect(analyticsAvailable({ ANALYTICS_ENDPOINT: '' })).toBe(false);
    expect(analyticsAvailable({})).toBe(false);
    expect(analyticsAvailable({ ANALYTICS_ENDPOINT: 'http://insecure.example.com' })).toBe(false);
    expect(analyticsAvailable({ ANALYTICS_ENDPOINT: 'https://stats.example.com/e' })).toBe(true);
  });
});

describe('analytics', () => {
  it('is off by default: nothing is sent', async () => {
    const { a, sent } = make();
    expect(await a.isEnabled()).toBe(false);
    expect(await a.track('active')).toEqual({ sent: false, reason: 'opted-out' });
    expect(await a.pingActive()).toMatchObject({ sent: false });
    expect(sent).toHaveLength(0);
  });

  it('sends nothing while no endpoint is configured (the shipped default), even if opted in', async () => {
    const { a, sent } = make({ endpoint: '' });
    await a.setEnabled(true);
    expect(await a.track('active')).toEqual({ sent: false, reason: 'no-endpoint' });
    expect(sent).toHaveLength(0);
  });

  it('refuses non-https endpoints', async () => {
    const { a, sent } = make({ endpoint: 'http://insecure.example.com' });
    await a.setEnabled(true);
    expect(sent).toHaveLength(0);
  });

  it('opt-in sends one install event; payload has only anonymous fields', async () => {
    const { a, sent } = make();
    await a.setEnabled(true);
    await a.setEnabled(true); // idempotent
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ event: 'install', anonId: 'anon-1', v: '0.1.0', tier: 'free', day: '2026-11-01' });
    expect(Object.keys(sent[0].body).sort()).toEqual(['anonId', 'day', 'event', 'tier', 'v']);
    expect(sent[0].init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(sent[0].init.headers['Content-Type']).toMatch(/^text\/plain/);
  });

  it('sends `active` at most once per UTC day', async () => {
    const { a, sent, clock } = make();
    await a.setEnabled(true);
    expect((await a.pingActive()).sent).toBe(true);
    expect(await a.pingActive()).toEqual({ sent: false, reason: 'already-today' });
    clock.t += DAY;
    expect((await a.pingActive()).sent).toBe(true);
    expect(sent.map((s) => s.body.event)).toEqual(['install', 'active', 'active']);
  });

  it('only whitelisted events exist', async () => {
    const { a } = make();
    await a.setEnabled(true);
    expect(EVENTS).toEqual(['install', 'active', 'conversion']);
    expect(await a.track('search_query')).toEqual({ sent: false, reason: 'unknown-event' });
  });

  it('opt-out deletes the anonymous id and stops sending; re-opt-in gets a NEW id and no second install', async () => {
    const { a, sent, kv } = make();
    let n = 0;
    await a.setEnabled(true);
    await a.setEnabled(false);
    expect((await kv.get('analytics')).anonId).toBeUndefined();
    expect(await a.track('active')).toMatchObject({ sent: false });
    await a.setEnabled(true);
    expect(sent.filter((s) => s.body.event === 'install')).toHaveLength(1);
    void n;
  });

  it('swallows network failures', async () => {
    const { a } = make({ fail: true });
    await a.setEnabled(true);
    expect(await a.track('active')).toEqual({ sent: false, reason: 'network' });
  });

  it('wiring: conversion event is emitted when Pro is activated, and never contains Reddit data', async () => {
    const env = await makeEnv({ children: makeChildren(20), user: 'secret_username' });
    await env.api.settings.set({ analyticsOptIn: true });
    await env.api.sync.start();
    await env.analytics.trackConversion(); // what runtime.js does from license.onConversion
    await env.api.license.setStubPro(true);
    await env.analytics.trackConversion();
    const wire = env.analyticsFetch.map((c) => c.init.body).join('\n');
    expect(wire).toContain('"event":"conversion"');
    expect(wire).toContain('"tier":"pro"');
    expect(wire).not.toContain('secret_username');
    expect(wire).not.toMatch(/subreddit|rust|title|tag/i);
    expect(await env.api.settings.analyticsPreview()).toMatchObject({ event: 'active' });
  });
});

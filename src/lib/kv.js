// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Tiny async key/value abstraction so logic can be unit-tested without chrome.* APIs.

/** In-memory implementation (tests, and fallback when chrome.storage is missing). */
export function createMemoryKv(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    async get(key, fallback = undefined) {
      return data.has(key) ? structuredClone(data.get(key)) : fallback;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

/** chrome.storage-backed implementation. area: 'local' | 'session'. */
export function createChromeKv(area = 'local', chromeApi = globalThis.chrome) {
  const store = chromeApi?.storage?.[area] ?? chromeApi?.storage?.local;
  if (!store) return createMemoryKv();
  return {
    async get(key, fallback = undefined) {
      const out = await store.get(key);
      return key in out ? out[key] : fallback;
    },
    async set(key, value) {
      await store.set({ [key]: value });
    },
    async remove(key) {
      await store.remove(key);
    },
  };
}

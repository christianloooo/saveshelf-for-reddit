// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { expected, ESM_SUFFIX } from '../tools/vendor-extpay.mjs';

const vendored = (f) => readFileSync(new URL(`../src/vendor/${f}`, import.meta.url));

describe('vendored ExtPay SDK', () => {
  it('is the official extpay@3.1.2 dist build, unmodified (run `npm run vendor:extpay` after bumping)', () => {
    const e = expected();
    expect(e.version).toBe('3.1.2');
    expect(vendored('ExtPay.js').equals(e.js)).toBe(true);
    expect(vendored('ExtPay.esm.js').equals(e.esm)).toBe(true);
  });
  it('the ES-module copy differs from the official file by exactly one appended export line', () => {
    const js = vendored('ExtPay.js').toString('utf8');
    expect(vendored('ExtPay.esm.js').toString('utf8')).toBe(js + ESM_SUFFIX);
    expect(ESM_SUFFIX.trim()).toBe('export default ExtPay;');
  });
});

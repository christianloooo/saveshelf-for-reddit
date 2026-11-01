// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Review screenshots (NOT store screenshots): library with folders (light/dark) + the privacy page. Output: review-shots/
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { CHROME, ROOT, serve } from './lib.mjs';
const out = `${ROOT}review-shots/`;
fs.mkdirSync(out, { recursive: true });
const srv = await serve();
const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto(`${srv.base}/ui/library.html?count=120&folders=demo`);
  await p.waitForSelector('.card');
  await p.locator('.folder-btn', { hasText: 'Dev reading' }).click();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}library-folders-${scheme}.png` });
  // move menu open on the first card
  await p.locator('.card').first().locator('.folder-pill').click();
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${out}library-move-menu-${scheme}.png` });
  await p.keyboard.press('Escape');
  const pr = await ctx.newPage();
  await pr.goto(`${srv.base}/landing/privacy.html`);
  await pr.evaluate(() => document.fonts.ready);
  await pr.screenshot({ path: `${out}privacy-${scheme}.png`, fullPage: true });
  await ctx.close();
}
await b.close(); srv.close();

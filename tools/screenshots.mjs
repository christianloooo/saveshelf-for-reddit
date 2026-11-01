// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Regenerates store-assets/screenshots/*.png (1280x800) from the real UI running on the dev mock backend,
// and refreshes the copies the landing page uses. Run: npm run screenshots
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { ROOT, CHROME, serve } from './lib.mjs';
const srv = await serve();
const U = `${srv.base}/ui/library.html`;
const OUT = `${ROOT}store-assets/screenshots/`;
const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
async function page(scheme='light') {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('pageerror', e.message));
  return p;
}
const settle = (p) => p.waitForTimeout(500);

// 1. Search
let p = await page();
await p.goto(U + '?count=243&folders=demo&q=keyboard'); await p.waitForSelector('.card'); await settle(p);
await p.screenshot({ path: OUT + '1-search-your-saves.png' });

// 2. Filters + tags
p = await page();
await p.goto(U + '?count=243&folders=demo'); await p.waitForSelector('.card');
await p.locator('#tag-filters .tag-toggle', { hasText: 'read-later' }).click();
await p.selectOption('#date-preset', '365'); await settle(p);
await p.locator('#subs label', { hasText: 'r/programming' }).click().catch(()=>{});
await settle(p);
await p.screenshot({ path: OUT + '2-filter-and-tag.png' });

// 3. Popup
p = await page();
await p.goto(`${srv.base}/tools/scenes/popup-scene.html`); await p.waitForTimeout(1200);
await p.screenshot({ path: OUT + '3-toolbar-popup.png' });

// 4. Export menu (dark)
p = await page('dark');
await p.goto(U + '?count=243&folders=demo'); await p.waitForSelector('.card');
await p.locator('#tag-filters .tag-toggle', { hasText: 'hardware' }).click(); await settle(p);
await p.locator('#export-btn').click(); await settle(p);
await p.screenshot({ path: OUT + '4-export-json-csv-dark.png' });

// 5. Upsell at free cap
p = await page();
await p.goto(U + '?count=300&pending=700'); await p.waitForSelector('.card');
await p.locator('#cap-banner button').click(); await settle(p);
await p.screenshot({ path: OUT + '5-free-cap-upgrade.png' });
await b.close();
srv.close();
for (const n of ['1-search-your-saves', '3-toolbar-popup', '5-free-cap-upgrade']) fs.copyFileSync(`${OUT}${n}.png`, `${ROOT}landing/assets/${n}.png`);
console.log('screenshots written to store-assets/screenshots/ (and landing/assets/)');

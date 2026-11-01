// Regenerates the Chrome Web Store images in this folder from the real UI on the dev mock backend (sample data only).
// Run from the repo root:  node store-listing/make-assets.mjs
// Does not modify anything outside store-listing/. Nothing is uploaded.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { ROOT, CHROME, serve } from '../tools/lib.mjs';

const OUT = `${ROOT}store-listing/`;
const srv = await serve();
const LIB = `${srv.base}/ui/library.html`;
const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
async function page(scheme = 'light', viewport = { width: 1280, height: 800 }) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  return p;
}
const settle = (p) => p.waitForTimeout(600);
const shot = (p, name) => p.screenshot({ path: `${OUT}screenshots/${name}.png` });

// 1. Library with folders in the sidebar
let p = await page();
await p.goto(`${LIB}?count=243&folders=demo`); await p.waitForSelector('.card'); await settle(p);
await shot(p, '1-library-and-folders');

// 2. Search
p = await page();
await p.goto(`${LIB}?count=243&folders=demo&q=keyboard`); await p.waitForSelector('.card'); await settle(p);
await shot(p, '2-search-your-saves');

// 3. Filtering by folder
p = await page();
await p.goto(`${LIB}?count=38&folders=demo`); await p.waitForSelector('.card'); // 38 = only the hand-written sample items
await p.locator('.folder-btn', { hasText: 'Dev reading' }).click(); await settle(p);
await shot(p, '3-filter-by-folder');

// 4. Toolbar popup (popup UI in a 380px frame on a plain backdrop)
p = await page();
await p.goto(`${srv.base}/tools/scenes/popup-scene.html`); await p.waitForTimeout(1400);
await shot(p, '4-toolbar-popup');

// 5. Export menu (dark)
p = await page('dark');
await p.goto(`${LIB}?count=243&folders=demo`); await p.waitForSelector('.card');
await p.locator('#tag-filters .tag-toggle', { hasText: 'hardware' }).click(); await settle(p);
await p.locator('#export-btn').click(); await settle(p);
await shot(p, '5-export-json-csv-dark');

// Promo tile 440x280: product name + the extension icon, same palette as the UI (accent #d9420b, Inter)
fs.copyFileSync(`${ROOT}icons/icon-128.png`, `${OUT}icon-128.png`);
const font = fs.readFileSync(`${ROOT}landing/fonts/Inter-Variable.woff2`).toString('base64');
const icon = fs.readFileSync(`${ROOT}icons/icon-128.png`).toString('base64');
p = await page('light', { width: 440, height: 280 });
await p.setContent(`<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
*{box-sizing:border-box}
body{margin:0;width:440px;height:280px;overflow:hidden;font-family:Inter,sans-serif;color:#1c1917;
  background:radial-gradient(340px 240px at 100% 0,#ffd9c6 0,transparent 70%),#fafaf9;display:flex;flex-direction:column;justify-content:center;padding:0 30px}
.row{display:flex;align-items:center;gap:16px}
img{width:76px;height:76px;border-radius:18px;box-shadow:0 10px 24px -8px rgba(217,66,11,.55)}
h1{margin:0;font-size:44px;line-height:1;letter-spacing:-.035em;font-weight:800}
.for{font-size:19px;font-weight:600;color:#d9420b;margin-top:6px;letter-spacing:-.01em}
.tag{margin-top:26px;font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-.02em;color:#44403c}
.tag b{color:#1c1917}
</style><div class="row"><img src="data:image/png;base64,${icon}"><div><h1>SaveShelf</h1><div class="for">for Reddit</div></div></div>
<div class="tag"><b>Search, tag and export</b> every post and comment you save.</div>`);
await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}promo-tile-440x280.png` });

await b.close(); srv.close();
console.log('written to store-listing/');

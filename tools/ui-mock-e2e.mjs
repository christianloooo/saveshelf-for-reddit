import { chromium } from 'playwright-core';
// UI-only test: drives the real ui/ pages in a browser against the dev mock backend (no extension, no service worker).
// The real-extension equivalent is scripts/e2e-chrome.mjs. Run: npm run test:ui-mock
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHROME, serve } from './lib.mjs';
const srv = await serve();
const base = `${srv.base}/ui/`;
const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => m.type()==='error' && !m.text().includes('404') && errs.push(m.text()));
const ok = (c, msg) => { console.log(c ? 'PASS' : 'FAIL', msg); if (!c) process.exitCode = 1; };
await p.goto(base + 'library.html?count=300&pending=700');
await p.waitForSelector('.card');
ok(await p.locator('.card').count() === 40, '40 cards on first page');
ok((await p.textContent('#summary')).includes('300'), 'summary count');
ok(await p.locator('#cap-banner[data-kind=full]').isVisible(), 'cap banner visible');
ok(!/\bnull\b|\bundefined\b/.test(await p.evaluate(() => document.querySelector('.cards').textContent)), 'no "null"/"undefined" text in cards');
ok(/more saves are waiting to be added/.test(await p.textContent('#cap-banner')), 'pending wording: ' + (await p.textContent('#cap-banner')).trim().slice(0, 80));
// search
await p.fill('#q', 'sqlite'); await p.waitForTimeout(400);
ok(await p.locator('.card').count() === 1 && await p.locator('mark').count() > 0, 'search narrows + highlights');
await p.fill('#q', ''); await p.waitForTimeout(400);
// type filter
await p.locator('#type-seg label', { hasText: 'Comments' }).click(); await p.waitForTimeout(300);
ok((await p.locator('.meta .type').allTextContents()).every(t => t.includes('Comment')), 'type=comment filter');
await p.locator('#type-seg label', { hasText: 'All' }).click(); await p.waitForTimeout(300);
// subreddit filter
await p.locator('#subs label').first().click(); await p.waitForTimeout(300);
const subs = await p.locator('.card .meta .sub').allTextContents();
ok(subs.length > 0 && new Set(subs).size === 1, 'subreddit filter ' + subs[0]);
await p.locator('#clear').click(); await p.waitForTimeout(300);
// date
await p.selectOption('#date-preset', '7'); await p.waitForTimeout(300);
const n7 = await p.locator('#summary').textContent();
ok(/of 300/.test(n7), 'date preset narrows: ' + n7);
await p.selectOption('#date-preset', 'any'); await p.waitForTimeout(300);
// tags
await p.locator('.card').first().locator('.tag-add').click();
await p.keyboard.type('Must Read'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
ok((await p.locator('.card').first().textContent()).includes('must-read'), 'tag added (normalised)');
await p.locator('.tag-toggle', { hasText: 'must-read' }).click(); await p.waitForTimeout(300);
ok(await p.locator('.card').count() === 1, 'tag filter');
await p.locator('.card').first().locator('.tag button', { hasText: '' }).last().click(); await p.waitForTimeout(400);
ok(await p.locator('.card').count() === 0 && await p.locator('#empty').isVisible(), 'remove tag under tag filter -> empty state');
await p.locator('#empty button').click(); await p.waitForTimeout(300);
// show more
await p.locator('#more').click(); await p.waitForTimeout(300);
ok(await p.locator('.card').count() === 80, 'show more appends');
// export
for (const fmt of ['json', 'csv']) {
  await p.locator('#export-btn').click();
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator(`[data-format=${fmt}]`).click()]);
  const f = path.join(os.tmpdir(), dl.suggestedFilename()); await dl.saveAs(f);
  const txt = fs.readFileSync(f, 'utf8');
  ok(fmt === 'json' ? JSON.parse(txt).count === 300 : txt.split('\r\n').length === 301, `export ${fmt} ${dl.suggestedFilename()}`);
}
// regression: items with a null / empty / blank snippet render no snippet element and no "null"/"undefined" text
for (const kind of ['null', 'empty', 'blank']) {
  const s = await ctx.newPage(); s.on('pageerror', e => errs.push(e.message));
  await s.goto(base + `library.html?count=30&snippet=${kind}`); await s.waitForSelector('.card');
  const cards = await s.locator('.card').evaluateAll(els => els.slice(0, 3).map(c => ({ snippet: !!c.querySelector('.snippet'), text: c.textContent })));
  ok(cards.length === 3 && cards.every(c => !c.snippet), `snippet=${kind}: first 3 cards have no .snippet element`);
  ok(cards.every(c => !/\bnull\b|\bundefined\b/.test(c.text)) && !/\bnull\b|\bundefined\b/.test(await s.locator('.cards').textContent()), `snippet=${kind}: no "null"/"undefined" text anywhere in the list`);
  ok(await s.locator('.card .snippet').count() === 27, `snippet=${kind}: other cards keep their snippet`);
  await s.fill('#q', 'null'); await s.waitForTimeout(400);
  ok(await s.locator('.card').count() === 0, `snippet=${kind}: searching "null" matches nothing`);
  await s.close();
  const sp = await ctx.newPage(); sp.on('pageerror', e => errs.push(e.message));
  await sp.setViewportSize({ width: 380, height: 600 });
  await sp.goto(base + `popup.html?snippet=${kind}`); await sp.waitForSelector('.item');
  ok(!/\bnull\b|\bundefined\b/.test(await sp.locator('#list').textContent()) && await sp.locator('#list .snippet').count() === 0, `snippet=${kind}: popup shows no null text or snippet`);
  await sp.close();
}
// folders (dev mock): create / filter / move / rename / delete
{
  const f = await ctx.newPage(); f.on('pageerror', e => errs.push(e.message));
  await f.goto(base + 'library.html?count=120&folders=demo'); await f.waitForSelector('.card');
  const names = await f.locator('.folder-btn .name').allTextContents();
  ok(['All saves', 'Unfiled', 'Dev reading', 'Homelab and Linux', 'Recipes', 'Trips'].every(n => names.includes(n)), 'folders listed: ' + names.join(', '));
  const cnt = async (n) => +(await f.locator('.folder-btn', { hasText: n }).first().locator('.count').textContent()).replace(/\D/g, '');
  const homelab = await cnt('Homelab');
  await f.locator('.folder-btn', { hasText: 'Homelab' }).click(); await f.waitForTimeout(300);
  ok(await f.locator('.folder-btn[aria-pressed=true] .name').textContent() === 'Homelab and Linux' && (await f.locator('#active-filters').textContent()).includes('Folder: Homelab and Linux'), 'folder filter active + chip');
  ok((await f.textContent('#summary')).includes(String(homelab)), `folder filter shows ${homelab} saves`);
  // move one card out, it should leave this view and counts update
  const first = f.locator('.card').first();
  await first.locator('.folder-pill').click();
  ok(await f.locator('#move-menu').evaluate(m => m.matches(':popover-open')), 'move menu opens');
  await f.keyboard.press('ArrowDown'); await f.keyboard.press('ArrowDown');
  await f.locator('#move-menu .menu-item', { hasText: 'Recipes' }).click(); await f.waitForTimeout(400);
  ok(await cnt('Homelab') === homelab - 1, 'move updates counts');
  ok((await f.textContent('#toast')).includes('Moved to'), 'toast announces move');
  // create (validation, then success), via the card menu so the card is filed in it
  await f.locator('.folder-btn', { hasText: 'All saves' }).click(); await f.waitForTimeout(300);
  await f.locator('.card').first().locator('.folder-pill').click();
  await f.locator('#move-menu .menu-item', { hasText: 'New folder' }).click();
  await f.keyboard.press('Enter');
  ok((await f.locator('.form-error').textContent()).includes('empty'), 'empty name rejected');
  await f.keyboard.type('Recipes'); await f.keyboard.press('Enter');
  ok((await f.locator('.form-error').textContent()).includes('already exists'), 'duplicate rejected, text kept: ' + await f.locator('.folder-form input').inputValue());
  await f.fill('.folder-form input', 'Read later'); await f.keyboard.press('Enter'); await f.waitForTimeout(400);
  ok(await cnt('Read later') === 1 && await f.locator('.card').first().locator('.folder-pill.is-filed').textContent() === 'Read later', 'create from card files the card');
  // rename
  await f.locator('.folder-row', { hasText: 'Read later' }).locator('.folder-btn').focus(); await f.keyboard.press('Tab');
  ok(await f.evaluate(() => document.activeElement?.dataset.rename !== undefined) && await f.locator('[data-rename]:focus').isVisible(), 'row actions reachable by keyboard');
  await f.keyboard.press('Enter');
  await f.fill('.folder-form input', 'Later'); await f.keyboard.press('Enter'); await f.waitForTimeout(300);
  ok((await f.locator('.folder-btn .name').allTextContents()).includes('Later'), 'rename');
  // delete with confirm: cancel keeps, confirm removes but keeps items
  const total = await cnt('All saves');
  await f.locator('.folder-row', { hasText: 'Later' }).locator('.folder-btn').focus(); await f.keyboard.press('Tab'); await f.keyboard.press('Tab'); await f.keyboard.press('Enter');
  ok(await f.locator('#folder-delete').evaluate(d => d.open) && (await f.textContent('#folder-delete-body')).includes('won’t be deleted'), 'delete asks to confirm');
  await f.keyboard.press('Escape'); await f.waitForTimeout(150);
  ok((await f.locator('.folder-btn .name').allTextContents()).includes('Later'), 'cancel keeps folder');
  await f.locator('.folder-row', { hasText: 'Later' }).hover(); await f.locator('[data-del]').last().click(); await f.locator('#folder-delete [value=delete]').click(); await f.waitForTimeout(400);
  ok(!(await f.locator('.folder-btn .name').allTextContents()).includes('Later') && await cnt('All saves') === total, 'delete removes folder, keeps saves');
  await f.close();
}
// upsell flow
await p.locator('#upgrade-btn').click();
ok(await p.locator('#upsell').evaluate(d => d.open), 'upsell opens');
await p.keyboard.press('Escape');
ok(!(await p.locator('#upsell').evaluate(d => d.open)), 'Esc closes upsell');
await p.locator('#upgrade-btn').click();
await p.locator('#upsell [value=upgrade]').click(); await p.waitForTimeout(500);
ok(await p.locator('#pro-chip').isVisible() && await p.locator('#cap-banner').isHidden(), 'mock upgrade -> Pro state');
// popup
const pp = await ctx.newPage(); pp.on('pageerror', e => errs.push(e.message));
await pp.setViewportSize({ width: 380, height: 600 });
await pp.goto(base + 'popup.html'); await pp.waitForSelector('.item');
await pp.fill('#q', 'bread'); await pp.waitForTimeout(400);
ok(await pp.locator('.item').count() >= 1, 'popup search');
await pp.fill('#q', 'zzzzqq'); await pp.waitForTimeout(400);
ok(await pp.locator('#empty').isVisible(), 'popup empty state');
// regression: library empty state (total 0) must not render a stray "null" (Element.replaceChildren(null) writes the text "null")
const noJunk = (t) => !/\bnull\b|\bundefined\b/.test(t);
const sync0 = async (q) => { const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push(e.message)); await pg.goto(base + 'library.html?' + q); await pg.waitForFunction(() => !/Checking|Loading/.test(document.getElementById('sync-text').textContent)); await pg.waitForTimeout(300); return pg; };
let lp = await sync0('count=0&sync=never');
let et = await lp.locator('#empty').textContent();
ok(await lp.locator('#empty').isVisible() && /No saves yet/.test(et) && /Sync your Reddit saved posts/.test(et) && noJunk(et), 'library empty state (never synced): ' + et.trim());
ok(await lp.locator('#empty').evaluate(e => e.childNodes.length === 3 && [...e.childNodes].every(n => n.nodeType === 1)), 'library empty state: only element children (no text node)');
ok(/Not synced yet/.test(await lp.textContent('#sync-text')), 'sync text: Not synced yet');
await lp.close();
lp = await sync0('count=0&added=0');
et = await lp.locator('#empty').textContent();
ok(/0 saves/.test(et) && /sync again/.test(et) && noJunk(et), 'library empty state after a sync that found 0 saves: ' + et.trim());
ok(/Synced .* 0 saves/.test(await lp.textContent('#sync-text')), 'sync text: "0 saves": ' + await lp.textContent('#sync-text'));
await lp.close();
lp = await sync0('count=20&added=0');
ok(/Synced .* nothing new/.test(await lp.textContent('#sync-text')), 'sync text with nothing new: ' + await lp.textContent('#sync-text'));
await lp.close();
lp = await sync0('count=20&added=3');
ok(/3 new/.test(await lp.textContent('#sync-text')), 'sync text with new saves: ' + await lp.textContent('#sync-text'));
await lp.close();
// popup: Sync is not in the top-right corner (it opens under the toolbar, over a page's own top-right controls)
await pp.goto(base + 'popup.html?count=20&added=0'); await pp.waitForSelector('.item'); await pp.waitForTimeout(300);
const box = await pp.locator('#sync-btn').boundingBox(); const vp = pp.viewportSize();
ok(box.y > vp.height / 2 && /Sync now/.test(await pp.textContent('#sync-btn')), `popup Sync button is a labelled button in the lower half (y=${Math.round(box.y)})`);
ok(/nothing new/.test(await pp.textContent('#sync-text')), 'popup sync text: nothing new');
await pp.goto(base + 'popup.html?count=0&added=0'); await pp.waitForTimeout(500);
ok(/0 saves/.test(await pp.textContent('#sync-text')) && /0 saves/.test(await pp.textContent('#empty')), 'popup 0-saves result: ' + await pp.textContent('#empty'));
console.log('errors:', errs);
ok(errs.length === 0, 'no page errors');
await b.close();
srv.close();

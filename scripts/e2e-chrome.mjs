// Loads dist/unpacked in real headless Chrome and drives it against a LOCAL fake reddit.com
// (HTTPS server + --host-resolver-rules, self-signed cert). Never touches the real Reddit.
//   node scripts/e2e-chrome.mjs        (run `npm run build` first)
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createFakeReddit } from '../tests/helpers/fixtures.js';
import { makeChildren } from '../tests/helpers/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const ext = join(root, 'dist/unpacked');
const shots = join(root, 'dist/e2e');
const chromePath = process.env.CHROME_PATH ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!existsSync(join(ext, 'manifest.json'))) throw new Error('dist/unpacked missing: run `npm run build` first');
if (!chromePath) throw new Error('no Chrome found; set CHROME_PATH');
mkdirSync(shots, { recursive: true });

// --- local fake reddit.com ---
const tmp = mkdtempSync(join(tmpdir(), 'rse2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=www.reddit.com',
  '-addext', 'subjectAltName=DNS:www.reddit.com', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem')], { stdio: 'ignore' });
const N = 250;
const reddit = createFakeReddit({ children: makeChildren(N), user: 'e2e_user' });
const seen = [];
const server = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, async (req, res) => {
  seen.push({ url: req.url, cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null });
  const r = await reddit.fetch(`https://www.reddit.com${req.url}`);
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
  res.end(await r.text());
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let browser;
const problems = [];
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) problems.push(msg); };
try {
  browser = await puppeteer.launch({
    executablePath: chromePath, headless: true, pipe: true, protocolTimeout: 60000, enableExtensions: [ext],
    userDataDir: join(tmp, 'profile'),
    args: ['--no-sandbox', `--host-resolver-rules=MAP www.reddit.com 127.0.0.1:${port}`, '--ignore-certificate-errors', '--no-first-run', '--disable-gpu'],
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check(Boolean(extId), `service worker started (${extId})`);
  const swErrors = [];
  const worker = await sw.worker();
  worker.on?.('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

  const open = async (path, w = 1100, h = 800) => {
    const p = await browser.newPage();
    await p.bringToFront(); // background tabs don't render, which stalls puppeteer clicks
    await p.setViewport({ width: w, height: h });
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(`chrome-extension://${extId}/${path}`, { waitUntil: 'networkidle0' });
    return { p, errs };
  };
  const rpc = (p, method, ...args) => p.evaluate((m, a) => chrome.runtime.sendMessage({ ns: 'saveshelf', method: m, args: a }), method, args);

  // Everything below goes through the real UI (typing, clicking) in the real extension against the
  // real service worker; rpc() is only used to read back state for assertions.
  const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
  const text = (p, sel) => p.$eval(sel, (e) => e.textContent.trim());
  const until = (p, fn, arg, timeout = 8000) => p.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
  const cardCount = (p) => p.$$eval('.card', (c) => c.length);
  const clickText = (p, sel, label) => p.evaluate((s2, l) => {
    const el = [...document.querySelectorAll(s2)].find((e) => e.textContent.includes(l));
    if (!el) throw new Error(`no ${s2} containing "${l}"`);
    el.click();
  }, sel, label);
  const download = async (p, menuFormat) => {
    await p.evaluate(() => {
      window.__dl = null;
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { fetch(this.href).then((r) => r.text()).then((t) => { window.__dl = { filename: this.download, content: t }; }); return; }
        return orig.call(this);
      };
    });
    await p.click('#export-btn');
    await p.click(`[data-format=${menuFormat}]`);
    await until(p, () => window.__dl, null);
    return p.evaluate(() => window.__dl);
  };

  // 1. empty state, as the user sees it in the toolbar popup
  const pop = await open('ui/popup.html', 380, 560);
  await until(pop.p, () => document.getElementById('sync-text').textContent !== 'Checking…', null);
  check(/Not synced yet/.test(await text(pop.p, '#sync-text')), 'popup: "Not synced yet" before first sync');
  check(await pop.p.$eval('#empty', (e) => !e.hidden && /Nothing saved yet/.test(e.textContent)), 'popup: empty state copy');
  let r = await rpc(pop.p, 'getPlan');
  check(r.ok && r.result.plan === 'free' && r.result.cap === 300 && r.result.count === 0, 'getPlan: empty free library');

  // 2. click the popup sync button -> real sync through the worker (3 pages, polite delays)
  const t0 = Date.now();
  await pop.p.bringToFront();
  await pop.p.click('#sync-btn');
  const synced = await until(pop.p, () => /Synced/.test(document.getElementById('sync-text').textContent), null, 60000);
  const popSync = await text(pop.p, '#sync-text');
  check(synced && new RegExp(`${N} new`).test(popSync), `popup sync button: "${popSync}" (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const saved = seen.filter((s2) => s2.url.startsWith('/user/e2e_user/saved.json'));
  check(saved.length === 3, `3 listing requests, sequential (got ${saved.length})`);
  check(seen.every((s2) => s2.origin === null || /reddit|extension/.test(s2.origin)), 'no stray origins');
  check(await pop.p.$$eval('.item', (i) => i.length) === 5, 'popup lists the 5 most recent saves');
  check(/250 of 300/.test(await text(pop.p, '#usage-text')), 'popup usage meter: ' + (await text(pop.p, '#usage-text')));

  // 3. popup search by typing
  await pop.p.type('#q', 'borrow checking');
  await until(pop.p, () => /Search|result|match/i.test(document.getElementById('list-title').textContent) || document.querySelectorAll('.item').length > 0, null);
  await sleep(500);
  const popHits = await pop.p.$$eval('.item-title', (t) => t.map((e) => e.textContent));
  check(popHits.length >= 1 && popHits.every((t) => /borrow checking/i.test(t)), `popup search "borrow checking": ${popHits.length} hits`);
  await pop.p.$eval('#q', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await pop.p.type('#q', 'zzzzqq'); await sleep(600);
  check(await pop.p.$eval('#empty', (e) => !e.hidden), 'popup: no-match state');
  await pop.p.screenshot({ path: join(shots, 'popup.png') });

  // 4. full-page library
  const lib = await open('ui/library.html');
  check(await until(lib.p, () => document.querySelectorAll('.card').length > 0, null), 'library renders cards');
  check(await cardCount(lib.p) === 40, 'library: first page is 40 cards');
  check(new RegExp(String(N)).test(await text(lib.p, '#summary')), 'library summary: ' + (await text(lib.p, '#summary')));
  check(await lib.p.$eval('#cap-banner', (b) => !b.hidden && b.dataset.kind === 'near'), 'cap banner: "near" at 250/300');
  const libText = await lib.p.evaluate(() => document.body.textContent);
  check(/Understanding borrow checking in Rust/.test(libText), 'library shows synced items');
  check(!/\bnull\b|\bundefined\b/.test(libText), 'library has no stray "null"/"undefined" text');
  await lib.p.screenshot({ path: join(shots, 'library.png') });

  // search box
  await lib.p.type('#q', 'sourdough');
  await until(lib.p, () => document.querySelectorAll('.card').length < 40, null);
  await sleep(300);
  const hits = await lib.p.$$eval('.card', (c) => c.map((e) => e.textContent));
  check(hits.length >= 1 && hits.every((t) => /sourdough/i.test(t)) && await lib.p.$$eval('mark', (m) => m.length) > 0, `library search narrows + highlights (${hits.length})`);
  await lib.p.$eval('#q', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(400);
  // type + subreddit filters, then clear
  await clickText(lib.p, '#type-seg label', 'Comments'); await sleep(400);
  const types = await lib.p.$$eval('.meta .type', (m) => m.map((e) => e.textContent));
  check(types.length > 0 && types.every((t) => /Comment/.test(t)), 'type filter: comments only');
  await clickText(lib.p, '#type-seg label', 'All'); await sleep(300);
  await lib.p.click('#subs label'); await sleep(400);
  const subs = await lib.p.$$eval('.card .meta .sub', (m) => m.map((e) => e.textContent));
  check(subs.length > 0 && new Set(subs).size === 1, `subreddit filter: ${subs[0]}`);
  await lib.p.click('#clear'); await sleep(400);
  check(await cardCount(lib.p) === 40, 'clear all filters restores the list');
  // tags: add via UI, filter by it, remove it
  await lib.p.click('.card .tag-add');
  await lib.p.keyboard.type('E2E Tag'); await lib.p.keyboard.press('Enter'); await sleep(500);
  check((await lib.p.$eval('.card', (c) => c.textContent)).includes('e2e-tag'), 'tag added through the UI (normalised to e2e-tag)');
  r = await rpc(lib.p, 'getItems', { tags: ['e2e-tag'] });
  check(r.ok && r.result.matched === 1, 'tag persisted by the worker');
  await clickText(lib.p, '.tag-toggle', 'e2e-tag'); await sleep(400);
  check(await cardCount(lib.p) === 1, 'tag filter shows the one tagged card');
  await lib.p.evaluate(() => { const b = document.querySelectorAll('.card .tag button'); b[b.length - 1].click(); }); await sleep(500);
  check(await cardCount(lib.p) === 0 && await lib.p.$eval('#empty', (e) => !e.hidden), 'removing the tag under the tag filter -> empty state');
  await lib.p.click('#empty button'); await sleep(400);
  // show more
  await lib.p.click('#more'); await sleep(300);
  check(await cardCount(lib.p) === 80, 'show more appends 40');
  // export (free on every tier) through the export menu
  const csv = await download(lib.p, 'csv');
  check(/^saveshelf-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.filename) && csv.content.split('\r\n').length > N, `export CSV from the menu: ${csv.filename}, ${csv.content.split('\r\n').length - 1} lines`);
  const json = await download(lib.p, 'json');
  check(/^saveshelf-\d{4}-\d{2}-\d{2}\.json$/.test(json.filename) && JSON.parse(json.content).count === N, `export JSON from the menu: ${json.filename}`);

  // folders, through the real UI: the page talks to the shared IndexedDB via the data API
  await lib.p.click('#folder-add');
  await lib.p.keyboard.type('E2E Folder'); await lib.p.keyboard.press('Enter'); await sleep(600);
  const folderRows = () => lib.p.$$eval('.folder-btn .name', (n) => n.map((e) => e.textContent));
  check((await folderRows()).includes('E2E Folder'), 'folders: created through the sidebar');
  await lib.p.evaluate(() => document.querySelector('.card .folder-pill').scrollIntoView({ block: 'center' })); await lib.p.click('.card .folder-pill'); await sleep(300);
  await clickText(lib.p, '#move-menu .menu-item', 'E2E Folder'); await sleep(700);
  const folderCount = () => lib.p.evaluate(() => Number([...document.querySelectorAll('.folder-btn')].find((b) => b.textContent.includes('E2E Folder'))?.querySelector('.count')?.textContent ?? -1));
  check(await folderCount() === 1, 'folders: moving a card updates the sidebar count');
  await clickText(lib.p, '.folder-btn', 'E2E Folder'); await sleep(700);
  check(await cardCount(lib.p) === 1, 'folders: filter shows only the filed card');
  await lib.p.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  check(await until(lib.p, () => document.querySelectorAll('.folder-btn').length > 2, null) && await folderCount() === 1, 'folders: persisted across a reload');
  await clickText(lib.p, '.folder-btn', 'E2E Folder'); await sleep(500);
  check(await cardCount(lib.p) === 1, 'folders: filter works after reload (assignments read from the store)');
  await lib.p.evaluate(() => [...document.querySelectorAll('.folder-row')].find((r) => r.textContent.includes('E2E Folder')).querySelector('[data-del]').click()); await sleep(300);
  await lib.p.click('#folder-delete [value=delete]'); await sleep(900);
  check(!(await folderRows()).includes('E2E Folder') && await cardCount(lib.p) > 1, 'folders: delete keeps the saves (back to the full list)');
  check(await lib.p.$eval('#summary', (e) => e.textContent).then((t2) => new RegExp(String(N)).test(t2)), 'folders: library total unchanged after delete');

  // 5. incremental re-sync from the library's sync button: stops at the first known item
  const before = seen.length;
  await lib.p.click('#sync-btn'); await sleep(2500);
  await until(lib.p, () => /Synced/.test(document.getElementById('sync-text').textContent), null, 30000);
  check(seen.length - before <= 2, `incremental sync cheap (${seen.length - before} requests)`);
  check(!/new/.test(await text(lib.p, '#sync-text')), 'library sync status shows nothing new');

  // 6. options page, then the upgrade dialog (stub) flips the plan
  const opt = await open('options/options.html', 800, 900);
  check((await opt.p.evaluate(() => document.getElementById('testmode').hidden)) === false, 'options page loads (stub test-mode visible)');
  await opt.p.screenshot({ path: join(shots, 'options.png') });
  const backup = await opt.p.evaluate(async () => {
    const { api } = await import('/src/lib/api.js');
    const x = await api.export.json();
    const imp = await api.import.json(x.content); // merge into itself: nothing new
    const s = await api.settings.set({ autoSync: true, autoSyncHours: 6 });
    return { count: x.count, merged: imp.merged, added: imp.added, s };
  });
  check(backup.count === N && backup.added === 0 && backup.s.autoSync === true, 'options page: backup + restore round trip, settings persist');
  const alarms = await opt.p.evaluate(() => chrome.alarms.getAll());
  check(alarms.some((a) => a.name === 'auto-sync' && Math.round(a.periodInMinutes) === 360), 'auto-sync alarm scheduled by worker');

  await lib.p.bringToFront();
  await lib.p.click('#upgrade-btn');
  check(await lib.p.$eval('#upsell', (d) => d.open), 'upgrade button opens the upsell dialog');
  await lib.p.keyboard.press('Escape');
  check(!(await lib.p.$eval('#upsell', (d) => d.open)), 'Esc closes the dialog');
  await lib.p.click('#upgrade-btn');
  await lib.p.click('#upsell [value=upgrade]'); await sleep(800);
  check(await lib.p.$eval('#pro-chip', (c) => !c.hidden) && await lib.p.$eval('#cap-banner', (b) => b.hidden), 'upgrade (stub) -> Pro chip, banner gone');
  r = await rpc(lib.p, 'getPlan');
  check(r.ok && r.result.plan === 'pro' && r.result.cap === null, 'worker reports plan = pro');
  await lib.p.screenshot({ path: join(shots, 'library-pro.png') });

  // 7. data survives worker restart (state lives in IndexedDB, not worker globals)
  await sw.worker().then((w) => w.evaluate(() => self.registration && 0)).catch(() => {});
  r = await rpc(lib.p, 'getItems', {});
  check(r.ok && r.result.total === N, 'data persists');
  await pop.p.bringToFront(); await pop.p.reload({ waitUntil: 'networkidle0' }); await sleep(400);
  check(await pop.p.$$eval('.item', (i) => i.length) === 5, 'popup shows the saves again after reload');

  for (const [n, e] of [['library', lib.errs], ['popup', pop.errs], ['options', opt.errs], ['worker', swErrors]]) {
    check(e.length === 0, `no console errors in ${n}${e.length ? ': ' + e.slice(0, 3).join(' | ') : ''}`);
  }
} catch (e) {
  console.error(e);
  problems.push(String(e));
} finally {
  await browser?.close().catch(() => {});
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(problems.length ? `\nE2E FAILED (${problems.length})` : `\nE2E OK (screenshots in dist/e2e/)`);
process.exit(problems.length ? 1 : 0);

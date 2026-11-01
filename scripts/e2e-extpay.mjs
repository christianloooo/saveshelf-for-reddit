// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Real-mode (EXTPAY_ID set) smoke test in real headless Chrome against a LOCAL fake extensionpay.com.
// The real extensionpay.com is never contacted: --host-resolver-rules maps it to 127.0.0.1 (self-signed cert).
// Covers: worker starts with ExtPay wired (no errors), upgrade opens the payment page via the SDK, and the
// "payment done" message path (extensionpay.com page -> vendored content script -> worker -> onPaid) flips the plan.
//   node scripts/e2e-extpay.mjs        (run `npm run build` first)
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const chromePath = process.env.CHROME_PATH ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!existsSync(join(root, 'dist/unpacked/manifest.json'))) throw new Error('dist/unpacked missing: run `npm run build` first');
if (!chromePath) throw new Error('no Chrome found; set CHROME_PATH');

const ID = 'saveshelf-e2e';
const tmp = mkdtempSync(join(tmpdir(), 'rsepay-'));
const ext = join(tmp, 'ext');
cpSync(join(root, 'dist/unpacked'), ext, { recursive: true });
const cfgPath = join(ext, 'src/config.js');
const cfg = readFileSync(cfgPath, 'utf8');
if (!/const EXTPAY_ID = '[^']*';/.test(cfg)) throw new Error('EXTPAY_ID line not found in src/config.js');
// always force the throwaway test id (the release build carries the real one) so we only ever talk to the local fake
writeFileSync(cfgPath, cfg.replace(/const EXTPAY_ID = '[^']*';/, `const EXTPAY_ID = '${ID}';`));

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=extensionpay.com',
  '-addext', 'subjectAltName=DNS:extensionpay.com', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem')], { stdio: 'ignore' });

const seen = [];
let paidAt = null;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const server = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, (req, res) => {
  const url = new URL(req.url, 'https://extensionpay.com');
  seen.push(`${req.method} ${url.pathname}`);
  const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, ...CORS, ...extra }); res.end(body); };
  if (req.method === 'OPTIONS') return send(204, 'text/plain', '');
  if (url.pathname === `/extension/${ID}/api/new-key`) return send(200, 'application/json', JSON.stringify('FAKEKEY'));
  if (url.pathname === `/extension/${ID}/api/v2/user`) return send(200, 'application/json', JSON.stringify({ paid: Boolean(paidAt), paidAt, trialStartedAt: null, email: null }));
  if (url.pathname === `/extension/${ID}/choose-plan`) return send(200, 'text/html', '<h1>choose a plan (fake)</h1>');
  if (url.pathname === `/extension/${ID}/paid`) {
    paidAt = new Date().toISOString(); // "Stripe webhook" arrived
    return send(200, 'text/html', "<h1>paid (fake)</h1><script>window.addEventListener('DOMContentLoaded',()=>window.postMessage('extpay-fetch-user','*'))</script>");
  }
  return send(404, 'text/plain', 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let browser;
const problems = [];
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) problems.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  browser = await puppeteer.launch({
    executablePath: chromePath, headless: true, pipe: true, protocolTimeout: 60000, enableExtensions: [ext],
    userDataDir: join(tmp, 'profile'),
    args: ['--no-sandbox', `--host-resolver-rules=MAP extensionpay.com 127.0.0.1:${port}, MAP www.reddit.com ~NOTFOUND`, '--ignore-certificate-errors', '--no-first-run', '--disable-gpu'],
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const swErrors = [];
  (await sw.worker()).on?.('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });
  await sleep(500);
  check(swErrors.length === 0, `worker started in real mode with ExtPay wired, no errors${swErrors.length ? ': ' + swErrors.join(' | ') : ''}`);

  const lib = await browser.newPage();
  await lib.bringToFront();
  const errs = [];
  lib.on('pageerror', (e) => errs.push(String(e)));
  await lib.goto(`chrome-extension://${extId}/ui/library.html`, { waitUntil: 'networkidle0' });
  await lib.evaluate(() => {
    window.__changes = [];
    chrome.runtime.onMessage.addListener((m) => { if (m?.event === 'changed') window.__changes.push(m.reason); });
  });
  const rpc = (method, ...args) => lib.evaluate((m, a) => chrome.runtime.sendMessage({ ns: 'saveshelf', method: m, args: a }), method, args);

  let r = await rpc('getPlan');
  check(r.ok && r.result.plan === 'free' && r.result.cap === 300, 'real mode starts Free (cap 300), not a local Pro flag');
  check(seen.length === 0, 'no extensionpay.com request yet (no api key until the user opens the payment page)');

  r = await rpc('upgrade');
  check(r.ok && r.result.opened === true && r.result.stub === false, 'upgrade opens the ExtensionPay payment page (not the stub toggle)');
  check(seen.includes(`POST /extension/${ID}/api/new-key`), 'SDK created an api key on (fake) extensionpay.com');
  const pages = await browser.pages();
  const payUrl = pages.map((p) => p.url()).find((u) => u.includes('/choose-plan'));
  check(payUrl === `https://extensionpay.com/extension/${ID}/choose-plan?api_key=FAKEKEY`, `payment tab opened: ${payUrl}`);
  r = await rpc('getPlan');
  check(r.ok && r.result.plan === 'free', 'still Free until the payment completes');

  // the user pays; extensionpay.com's success page messages the vendored content script, which messages the worker
  const payTab = pages.find((p) => p.url().includes('/choose-plan')) ?? await browser.newPage();
  await payTab.goto(`https://extensionpay.com/extension/${ID}/paid`, { waitUntil: 'load' });
  await lib.bringToFront();
  const flipped = await lib.waitForFunction(() => window.__changes.includes('plan'), { timeout: 15000 }).then(() => true, () => false);
  check(flipped, 'onPaid fired in the worker and told the UI (changed: plan), without the UI asking');
  r = await rpc('getPlan');
  check(r.ok && r.result.plan === 'pro' && r.result.cap === null, 'plan is now Pro');
  const known = [`POST /extension/${ID}/api/new-key`, `GET /extension/${ID}/choose-plan`, `GET /extension/${ID}/paid`, `GET /extension/${ID}/api/v2/user`];
  const stray = seen.filter((s) => !known.includes(s) && !s.endsWith('/favicon.ico') && !s.startsWith('OPTIONS '));
  check(stray.length === 0, `only the expected extensionpay.com endpoints were used (${[...new Set(seen)].join(', ')})${stray.length ? ' STRAY: ' + stray.join(', ') : ''}`);
  check(errs.length === 0, `no console errors in library${errs.length ? ': ' + errs.join(' | ') : ''}`);
  check(swErrors.length === 0, `no console errors in worker${swErrors.length ? ': ' + swErrors.join(' | ') : ''}`);
} catch (e) {
  console.error(e);
  problems.push(String(e));
} finally {
  await browser?.close().catch(() => {});
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(problems.length ? `\nEXTPAY E2E FAILED (${problems.length})` : '\nEXTPAY E2E OK (real mode against a local fake extensionpay.com)');
process.exit(problems.length ? 1 : 0);

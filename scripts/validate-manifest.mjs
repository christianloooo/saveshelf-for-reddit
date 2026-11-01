// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Static validation of the extension: manifest sanity, file references, icon sizes, permission allowlist,
// ES-module import graph resolves inside the shipped file set, no remote code.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shipFiles } from './shipfiles.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
let root = DEFAULT_ROOT;
const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const read = (f) => readFileSync(join(root, f), 'utf8');

export function validate(dir = DEFAULT_ROOT) {
  root = dir;
  errors.length = 0; warnings.length = 0;
  let m;
  try { m = JSON.parse(read('manifest.json')); } catch (e) { fail(`manifest.json unreadable: ${e.message}`); return { errors, warnings }; }
  const shipped = new Set(shipFiles(root));
  const must = (f, why) => { if (!f) return; if (!existsSync(join(root, f))) fail(`${why}: ${f} does not exist`); else if (!shipped.has(f)) fail(`${why}: ${f} exists but is excluded from the package`); };

  if (m.manifest_version !== 3) fail('manifest_version must be 3');
  for (const k of ['name', 'version', 'description']) if (!m[k]) fail(`missing ${k}`);
  if (m.name?.length > 75) fail('name > 75 chars');
  if (m.description?.length > 132) fail(`description is ${m.description.length} chars (store limit 132)`);
  if (!/^\d+(\.\d+){0,3}$/.test(m.version ?? '')) fail('version must be 1-4 dot-separated integers');

  // icons: files exist, PNG, correct dimensions
  for (const [size, f] of Object.entries(m.icons ?? {})) {
    must(f, `icon ${size}`);
    if (existsSync(join(root, f))) {
      const b = readFileSync(join(root, f));
      const png = b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
      if (!png) fail(`${f} is not a PNG`);
      else if (w !== Number(size) || h !== Number(size)) fail(`${f} is ${w}x${h}, manifest says ${size}`);
    }
  }
  for (const s of ['16', '48', '128']) if (!m.icons?.[s]) fail(`icons.${s} missing`);

  must(m.action?.default_popup, 'action.default_popup');
  must(m.options_ui?.page, 'options_ui.page');
  must(m.background?.service_worker, 'background.service_worker');
  if (m.background?.service_worker && m.background.type !== 'module') fail('background.type must be "module" (the worker uses ES imports)');

  // permissions: strict allowlist (every one needs a store justification)
  const allowed = new Set(['storage', 'alarms']);
  for (const p of m.permissions ?? []) if (!allowed.has(p)) fail(`unexpected permission "${p}" (add a justification in CHROMEWEBSTORE.md and allow it here)`);
  const hosts = m.host_permissions ?? [];
  if (hosts.length !== 1 || hosts[0] !== 'https://www.reddit.com/*') fail(`host_permissions must be exactly ["https://www.reddit.com/*"], got ${JSON.stringify(hosts)}`);
  // The only content script: ExtensionPay's own, on its payment pages (it relays "payment done" to the worker for onPaid).
  const cs = m.content_scripts ?? [];
  const csOk = cs.length === 1 && JSON.stringify(cs[0].matches) === '["https://extensionpay.com/*"]'
    && JSON.stringify(cs[0].js) === '["src/vendor/ExtPay.js"]' && cs[0].run_at === 'document_start' && !cs[0].css && !cs[0].all_frames;
  if (!csOk) fail('content_scripts must be exactly the ExtensionPay script: matches https://extensionpay.com/*, js src/vendor/ExtPay.js, run_at document_start');
  for (const c of cs) for (const f of c.js ?? []) must(f, 'content_scripts js');
  if (m.optional_host_permissions?.length) warnings.push('optional_host_permissions present');
  if (m.externally_connectable || m.web_accessible_resources) warnings.push('externally_connectable / web_accessible_resources present: review');
  const csp = m.content_security_policy?.extension_pages ?? '';
  if (!/script-src 'self'/.test(csp) || /unsafe-|https?:/.test(csp)) fail(`CSP must be 'self' only, got: ${csp}`);

  // HTML: local scripts/styles only
  for (const f of [...shipped].filter((x) => x.endsWith('.html'))) {
    const html = read(f);
    for (const mm of html.matchAll(/<(script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)) {
      const ref = mm[2];
      if (/^(https?:)?\/\//.test(ref)) { fail(`${f}: remote ${mm[1]} ${ref}`); continue; }
      if (/^(data|#|mailto)/.test(ref)) continue;
      const target = posix.normalize(posix.join(posix.dirname(f), ref));
      if (!shipped.has(target)) fail(`${f}: references ${target} which is not shipped`);
    }
    if (/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html)) fail(`${f}: inline script (blocked by MV3 CSP)`);
    if (/\son[a-z]+="/i.test(html)) fail(`${f}: inline event handler (blocked by MV3 CSP)`);
  }

  // JS: static import graph from every entry point must resolve inside the package; no eval / remote code
  const entries = [m.background?.service_worker, ...[...shipped].filter((x) => x.endsWith('.html')).flatMap((h) =>
    [...read(h).matchAll(/<script[^>]*src="([^"]+)"/g)].map((mm) => posix.normalize(posix.join(posix.dirname(h), mm[1]))))].filter(Boolean);
  const seen = new Set();
  const visit = (f, from) => {
    if (seen.has(f)) return; seen.add(f);
    if (!shipped.has(f)) { fail(`${from ?? 'manifest'} imports ${f} which is not shipped`); return; }
    const src = read(f);
    if (/\beval\s*\(|new Function\s*\(/.test(src)) fail(`${f}: eval / new Function`);
    if (/import\s*\(\s*['"]https?:/.test(src) || /from\s+['"]https?:/.test(src)) fail(`${f}: remote import`);
    for (const mm of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) {
      visit(posix.normalize(posix.join(posix.dirname(f), mm[1] ?? mm[2])), f);
    }
    // dynamic imports of relative files must also exist when shipped (mock is intentionally excluded)
    for (const mm of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const t = posix.normalize(posix.join(posix.dirname(f), mm[1]));
      if (!shipped.has(t) && !/^ui\/mock\//.test(t)) fail(`${f}: dynamic import of ${t} which is not shipped`);
      else if (shipped.has(t)) visit(t, f);
    }
  };
  entries.forEach((e) => visit(e));

  // config sanity
  const cfg = read('src/config.js');
  // stub mode = no EXTPAY_ID, or FORCE_STUB_LICENSE (mirrors the derivation in src/config.js)
  const extpayId = /const\s+EXTPAY_ID\s*=\s*'([^']*)'/.exec(cfg)?.[1];
  const forced = /const\s+FORCE_STUB_LICENSE\s*=\s*true/.test(cfg);
  if (extpayId === undefined) fail("src/config.js: could not read `const EXTPAY_ID = '...'`");
  const stub = forced || !extpayId;
  if (stub) warnings.push('stub license mode (no EXTPAY_ID): this build grants Pro locally and must NOT be published');
  else for (const f of ['src/vendor/ExtPay.js', 'src/vendor/ExtPay.esm.js']) must(f, 'ExtPay SDK (EXTPAY_ID is set)');
  return { errors, warnings, manifest: m, stub, files: shipped.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = validate();
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  for (const e of r.errors) console.error(`error: ${e}`);
  console.log(r.errors.length ? `\nmanifest INVALID (${r.errors.length} error(s))` : `manifest OK (${r.manifest.name} v${r.manifest.version}, ${r.files} files)`);
  process.exit(r.errors.length ? 1 : 0);
}

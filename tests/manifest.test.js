// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/validate-manifest.mjs';
import { shipFiles, shipContent } from '../scripts/shipfiles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function sandbox(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'mv-'));
  for (const f of ['manifest.json', 'src', 'ui', 'options', 'icons']) cpSync(join(root, f), join(dir, f), { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  mutate?.(m, dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  const r = validate(dir);
  rmSync(dir, { recursive: true, force: true });
  return r;
}

describe('manifest + package', () => {
  it('the real manifest is valid MV3 with minimal permissions', () => {
    const r = validate(root);
    expect(r.errors).toEqual([]);
    expect(r.manifest.manifest_version).toBe(3);
    expect(r.manifest.permissions.sort()).toEqual(['alarms', 'storage']);
    expect(r.manifest.host_permissions).toEqual(['https://www.reddit.com/*']);
    expect(r.manifest.action.default_popup).toBe('ui/popup.html');
  });
  it('rejects extra permissions, broad hosts, missing files and remote CSP', () => {
    expect(sandbox((m) => m.permissions.push('tabs')).errors.join()).toMatch(/unexpected permission "tabs"/);
    expect(sandbox((m) => (m.host_permissions = ['<all_urls>'])).errors.join()).toMatch(/host_permissions/);
    expect(sandbox((m) => (m.action.default_popup = 'nope.html')).errors.join()).toMatch(/nope\.html does not exist/);
    expect(sandbox((m) => (m.content_security_policy = { extension_pages: "script-src 'self' https://cdn.example.com" })).errors.join()).toMatch(/CSP/);
    expect(sandbox((m) => delete m.background.type).errors.join()).toMatch(/module/);
  });
  it('rejects an import that leaves the shipped set', () => {
    const r = sandbox((m, dir) => writeFileSync(join(dir, 'src/background.js'), readFileSync(join(dir, 'src/background.js'), 'utf8') + "\nimport '../ui/mock/mock-backend.js';\n"));
    expect(r.errors.join()).toMatch(/mock-backend\.js which is not shipped/);
  });
  it('ships no mock, tests or dev docs', () => {
    const files = shipFiles(root);
    expect(files).toContain('manifest.json');
    expect(files).toContain('ui/export-format.js');
    expect(files.filter((f) => /mock|\.test\.|README-ui|node_modules/.test(f))).toEqual([]);
  });
  it('the packaged ui/api.js has no reference to the mock backend (the source keeps it for dev)', () => {
    expect(readFileSync(join(root, 'ui/api.js'), 'utf8')).toMatch(/mock-backend/);
    const shipped = shipContent(root, 'ui/api.js').toString('utf8');
    expect(shipped).not.toMatch(/mock/i);
    expect(shipped).not.toMatch(/dev-only/);
    expect(shipped).toMatch(/chrome\.runtime\.sendMessage/);
  });
  it('is branded SaveShelf for Reddit and ships the AGPL license, third-party notices and privacy policy', () => {
    const { manifest } = validate(root);
    expect(manifest.name).toBe('SaveShelf for Reddit');
    expect(manifest.short_name).toBe('SaveShelf');
    expect(manifest.action.default_title).toBe('SaveShelf for Reddit');
    expect(shipFiles(root)).toEqual(expect.arrayContaining(['LICENSE', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md']));
    // the real contact address is in the policy and on the privacy page, and no placeholder is left
    for (const f of ['PRIVACY.md', 'landing/privacy.html']) {
      const text = readFileSync(join(root, f), 'utf8');
      expect(text, f).toContain('christianlo3823@gmail.com');
      expect(text, f).not.toMatch(/PLACEHOLDER|contact@example\.com/);
    }
  });
  it('allows exactly one content script: ExtensionPay\'s own, on extensionpay.com payment pages', () => {
    const r = validate(root);
    expect(r.manifest.content_scripts).toEqual([{ matches: ['https://extensionpay.com/*'], js: ['src/vendor/ExtPay.js'], run_at: 'document_start' }]);
    expect(sandbox((m) => m.content_scripts.push({ matches: ['https://www.reddit.com/*'], js: ['src/background.js'] })).errors.join()).toMatch(/content_scripts must be exactly/);
    expect(sandbox((m) => (m.content_scripts[0].matches = ['<all_urls>'])).errors.join()).toMatch(/content_scripts must be exactly/);
    expect(sandbox((m) => delete m.content_scripts).errors.join()).toMatch(/content_scripts must be exactly/);
  });
  it('real mode (EXTPAY_ID set) validates clean and is no longer reported as a stub', () => {
    const r = sandbox((m, dir) => {
      const f = join(dir, 'src/config.js');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/const EXTPAY_ID = '[^']*';/, "const EXTPAY_ID = 'saveshelf-test';"));
    });
    expect(r.errors).toEqual([]);
    expect(r.stub).toBe(false);
    const forced = sandbox((m, dir) => {
      const f = join(dir, 'src/config.js');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/const EXTPAY_ID = '[^']*';/, "const EXTPAY_ID = 'x';").replace('const FORCE_STUB_LICENSE = false;', 'const FORCE_STUB_LICENSE = true;'));
    });
    expect(forced.stub).toBe(true);
  });
  it('the shipped config is the release config: real mode with the registered ExtensionPay id, no stub warning', () => {
    const cfg = readFileSync(join(root, 'src/config.js'), 'utf8');
    expect(cfg).toContain("const EXTPAY_ID = 'saveshelf-for-reddit';");
    expect(cfg).toContain('const FORCE_STUB_LICENSE = false;');
    const r = validate(root);
    expect(r.stub).toBe(false);
    expect(r.warnings.join()).not.toMatch(/stub license mode/);
    expect(r.errors).toEqual([]);
  });
  it('warns loudly while the license is stubbed (no EXTPAY_ID)', () => {
    const r = sandbox((m, dir) => {
      const f = join(dir, 'src/config.js');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/const EXTPAY_ID = '[^']*';/, "const EXTPAY_ID = '';"));
    });
    expect(r.stub).toBe(true);
    expect(r.warnings.join()).toMatch(/stub license mode/);
  });
});

// ---- licensing: AGPL-3.0-or-later, with third-party notices ----
const SOURCE_REPO_URL = 'https://github.com/christianloooo/saveshelf-for-reddit';
describe('licensing', () => {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  it('LICENSE is the full AGPL-3.0 text with the 2026 Chris L copyright, not MIT', () => {
    const t = read('LICENSE');
    expect(t).toMatch(/Copyright \(C\) 2026 Chris L/);
    expect(t).toContain('SPDX-License-Identifier: AGPL-3.0-or-later');
    expect(t).toContain('GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007');
    expect(t).toContain('13. Remote Network Interaction; Use with the GNU General Public License.');
    expect(t).toContain('END OF TERMS AND CONDITIONS');
    expect(t).not.toMatch(/MIT License|Permission is hereby granted, free of charge/);
    expect(t.split('\n').length).toBeGreaterThan(650);
  });
  it('package.json declares AGPL-3.0-or-later; no stale MIT claim in the docs', () => {
    expect(JSON.parse(read('package.json')).license).toBe('AGPL-3.0-or-later');
    for (const f of ['README.md', 'CHROMEWEBSTORE.md', 'PRIVACY.md', 'store-listing/full-description.txt']) expect(read(f), f).not.toMatch(/\bMIT\b(?! \(for the icons)/);
    expect(read('README.md')).toMatch(/AGPL-3\.0-or-later/);
    expect(read('CHROMEWEBSTORE.md')).toMatch(/AGPL-3\.0-or-later/);
  });
  it('first-party source files carry an SPDX header; the vendored SDK is left byte-for-byte alone', () => {
    for (const f of ['src/background.js', 'src/config.js', 'src/lib/sync.js', 'ui/library.js', 'ui/popup.js', 'ui/icons.js', 'options/options.js']) {
      expect(read(f).slice(0, 120), f).toMatch(/^\/\/ SPDX-License-Identifier: AGPL-3\.0-or-later/);
    }
    expect(read('src/vendor/ExtPay.js')).not.toMatch(/SPDX-License-Identifier/);
    expect(read('src/vendor/ExtPay.js')).toContain('AGPLv3 licensed.');
  });
  it('THIRD_PARTY_NOTICES covers ExtPay (AGPL, original license text kept), the MPL-2.0 polyfill and Lucide', () => {
    const t = read('THIRD_PARTY_NOTICES.md');
    expect(t).toMatch(/ExtPay[\s\S]*AGPL-3\.0-or-later/);
    expect(t).toContain(read('node_modules/extpay/LICENSE').trim()); // its LICENSE text, verbatim
    expect(t).toContain('AGPLv3 licensed.');
    expect(t).toMatch(/webextension-polyfill 0\.7\.0 — MPL-2\.0/);
    expect(t).toContain(read('node_modules/webextension-polyfill/LICENSE').trim()); // full MPL-2.0 text
    expect(t).toMatch(/Lucide[\s\S]*ISC License/);
  });
  it('LICENSE and THIRD_PARTY_NOTICES.md are in the store zip file list', () => {
    const files = shipFiles(root);
    expect(files).toContain('LICENSE');
    expect(files).toContain('THIRD_PARTY_NOTICES.md');
  });
  it('the public source URL is the same everywhere (and clearly marked while it is still the placeholder)', () => {
    const where = ['README.md', 'PRIVACY.md', 'CHROMEWEBSTORE.md', 'THIRD_PARTY_NOTICES.md', 'store-listing/full-description.txt', 'landing/index.html', 'landing/privacy.html', 'options/options.html'];
    for (const f of where) {
      const t = read(f);
      expect(t, f).toContain(SOURCE_REPO_URL);
      if (SOURCE_REPO_URL.includes('/OWNER/')) expect(t, f).toContain('SOURCE_REPO_URL');
      else expect(t, f).not.toMatch(/OWNER\/saveshelf|SOURCE_REPO_URL/);
    }
    expect(read('PRIVACY.md')).toMatch(/Source code/);
  });
});


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
  it('is branded SaveShelf for Reddit and ships the MIT license and privacy policy', () => {
    const { manifest } = validate(root);
    expect(manifest.name).toBe('SaveShelf for Reddit');
    expect(manifest.short_name).toBe('SaveShelf');
    expect(manifest.action.default_title).toBe('SaveShelf for Reddit');
    expect(shipFiles(root)).toEqual(expect.arrayContaining(['LICENSE', 'PRIVACY.md']));
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toMatch(/^MIT License[\s\S]*Copyright \(c\) 2026 Chris L/);
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
      writeFileSync(f, readFileSync(f, 'utf8').replace("const EXTPAY_ID = '';", "const EXTPAY_ID = 'saveshelf-test';"));
    });
    expect(r.errors).toEqual([]);
    expect(r.stub).toBe(false);
    const forced = sandbox((m, dir) => {
      const f = join(dir, 'src/config.js');
      writeFileSync(f, readFileSync(f, 'utf8').replace("const EXTPAY_ID = '';", "const EXTPAY_ID = 'x';").replace('const FORCE_STUB_LICENSE = false;', 'const FORCE_STUB_LICENSE = true;'));
    });
    expect(forced.stub).toBe(true);
  });
  it('warns loudly while the license is stubbed', () => {
    expect(validate(root).warnings.join()).toMatch(/stub license mode/);
  });
});

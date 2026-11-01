// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// What goes into the store package. Single source of truth for package.mjs, validate and e2e.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const INCLUDE = ['manifest.json', 'src', 'ui', 'options', 'icons', 'PRIVACY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
// Never ship: dev mock backend, docs for devs. ui/api.js also has its mock import stripped (see shipContent).
export const EXCLUDE = [/^ui\/mock\//, /^ui\/README-ui\.md$/, /(^|\/)\.DS_Store$/, /\.test\.js$/];

const walk = (root, d) => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => {
  const rel = d ? `${d}/${e.name}` : e.name;
  return e.isDirectory() ? walk(root, rel) : [rel];
});

export function shipFiles(root) {
  const out = [];
  for (const inc of INCLUDE) {
    if (!existsSync(join(root, inc))) continue;
    const files = readdirSyncSafe(root, inc);
    out.push(...files);
  }
  return out.filter((f) => !EXCLUDE.some((re) => re.test(f))).sort();
}
function readdirSyncSafe(root, inc) {
  try { return walk(root, inc); } catch { return [inc]; } // a plain file
}
export { relative };

/** Bytes of a shipped file. ui/api.js loses its `dev-only` blocks, so the package has no reference to the mock backend. */
export function shipContent(root, f) {
  const buf = readFileSync(join(root, f));
  if (f !== 'ui/api.js') return buf;
  const src = buf.toString('utf8');
  const out = src.replace(/^[ \t]*\/\/ dev-only:start[^\n]*\n[\s\S]*?^[ \t]*\/\/ dev-only:end[^\n]*\n/gm, '');
  if (/mock/i.test(out.replace(/\/\*\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, ''))) throw new Error('ui/api.js still references the mock after stripping dev-only blocks');
  return Buffer.from(out);
}

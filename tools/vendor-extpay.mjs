// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Vendors the official ExtPay SDK (npm "extpay", pinned in devDependencies) into src/vendor/.
//   src/vendor/ExtPay.js      byte-identical copy of dist/ExtPay.js. Loaded as the content script on
//                             https://extensionpay.com/* (that is how onPaid learns a payment finished).
//   src/vendor/ExtPay.esm.js  the same file plus ONE appended line `export default ExtPay;`, so the ES-module
//                             service worker can import it (importScripts is not available in module workers).
// Run: npm run vendor:extpay   (tests/vendor-extpay.test.js fails if the vendored files drift from the package)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
export const ESM_SUFFIX = '\nexport default ExtPay;\n';

export function expected() {
  const pkgDir = join(root, 'node_modules', 'extpay');
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const js = readFileSync(join(pkgDir, 'dist', 'ExtPay.js'));
  return { version, js, esm: Buffer.concat([js, Buffer.from(ESM_SUFFIX)]), sha256: createHash('sha256').update(js).digest('hex') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const e = expected();
  const out = join(root, 'src', 'vendor');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ExtPay.js'), e.js);
  writeFileSync(join(out, 'ExtPay.esm.js'), e.esm);
  console.log(`vendored extpay@${e.version} (dist/ExtPay.js sha256 ${e.sha256})`);
}

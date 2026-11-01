import { defineConfig } from 'vitest/config';

// The shipped src/config.js carries the real ExtensionPay id (release build => real license mode). Unit tests exercise the
// default STUB mode and inject their own config for real mode, so blank the id (only) while loading src/config.js under
// vitest. Everything else in the config stays the real file, so the numbers under test cannot drift.
// tests/manifest.test.js and tests/extpay.test.js read the file from disk and assert the shipped id and derivation.
export default defineConfig({
  plugins: [{
    name: 'saveshelf-stub-license-for-tests',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/src\/config\.js$/.test(id.split('?')[0])) return null;
      if (!/const EXTPAY_ID = '[^']*';/.test(code)) throw new Error('vitest.config.js: EXTPAY_ID line not found in src/config.js');
      return { code: code.replace(/const EXTPAY_ID = '[^']*';/, "const EXTPAY_ID = '';"), map: null };
    },
  }],
});

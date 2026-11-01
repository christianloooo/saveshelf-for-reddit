// Builds dist/unpacked (load-unpacked / e2e) and a store-ready zip. No `zip` CLI needed.
//   node scripts/package.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { shipFiles, shipContent } from './shipfiles.mjs';
import { validate } from './validate-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

const v = validate(root);
v.warnings.forEach((w) => console.warn(`warning: ${w}`));
if (v.errors.length) { v.errors.forEach((e) => console.error(`error: ${e}`)); process.exit(1); }

const files = shipFiles(root);
rmSync(dist, { recursive: true, force: true });
for (const f of files) { mkdirSync(dirname(join(dist, 'unpacked', f)), { recursive: true }); writeFileSync(join(dist, 'unpacked', f), shipContent(root, f)); }

// --- minimal deterministic ZIP writer (deflate, fixed timestamp so builds are reproducible) ---
function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const name = `saveshelf-for-reddit-${version}${v.stub ? '-stub' : ''}.zip`;
const out = join(dist, name);
writeFileSync(out, zip(files.map((f) => ({ name: f, data: shipContent(root, f) }))));
console.log(`${files.length} files -> ${out} (${(statSync(out).size / 1024).toFixed(1)} KiB)`);
if (v.stub) console.warn('STUB BUILD: payments/analytics are stubbed and Pro can be toggled locally. Do not upload to the Chrome Web Store (see README "Before you publish").');

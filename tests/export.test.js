// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { describe, it, expect } from 'vitest';
import { toCSV, toJSON, parseImport, CSV_COLUMNS } from '../src/lib/export.js';
import { makeEnv } from './helpers/env.js';
import { makeChildren } from './helpers/fixtures.js';

// Minimal RFC 4180 parser used to verify our CSV round-trips.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  return rows;
}

const item = (over = {}) => ({
  id: 't3_a', kind: 'post', title: 'Hello, "world"', body: 'line1\nline2', url: 'https://x.test', domain: 'x.test',
  permalink: 'https://www.reddit.com/r/a/comments/a/', subreddit: 'a', author: 'u', score: 3, numComments: 1,
  createdAt: 1700000000000, nsfw: false, flair: '', removedOnReddit: false, tags: ['a b', 'c'], folderId: 'f1', seq: 5, ...over,
});

describe('export', () => {
  it('CSV: header, quoting, multiline, BOM, CRLF, tags, folder, saved_order', () => {
    const csv = toCSV([item(), item({ id: 't1_b', seq: 9, title: 'second', tags: [], folderId: null })], [{ id: 'f1', name: 'Work' }]);
    expect(csv.startsWith('\uFEFF' + CSV_COLUMNS.join(','))).toBe(true);
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual(CSV_COLUMNS);
    expect(rows[1][0]).toBe('t1_b'); // newest saved first
    expect(rows[1][CSV_COLUMNS.indexOf('saved_order')]).toBe('1');
    const second = rows[2];
    expect(second[CSV_COLUMNS.indexOf('title')]).toBe('Hello, "world"');
    expect(second[CSV_COLUMNS.indexOf('body')]).toBe('line1\nline2');
    expect(second[CSV_COLUMNS.indexOf('tags')]).toBe('a b; c');
    expect(second[CSV_COLUMNS.indexOf('folder')]).toBe('Work');
    expect(second[CSV_COLUMNS.indexOf('created_at')]).toBe('2023-11-14T22:13:20.000Z');
    expect(toCSV([item()], [], { bom: false }).startsWith('id,')).toBe(true);
  });

  it('CSV: neutralises spreadsheet formula injection in text cells', () => {
    const csv = toCSV([item({ title: '=HYPERLINK("http://evil","x")', body: '@SUM(A1)', author: '+1', tags: ['-cmd'] })], []);
    const row = parseCsv(csv.slice(1))[1];
    expect(row[CSV_COLUMNS.indexOf('title')].startsWith("'=")).toBe(true);
    expect(row[CSV_COLUMNS.indexOf('body')]).toBe("'@SUM(A1)");
    expect(row[CSV_COLUMNS.indexOf('author')]).toBe("'+1");
    expect(row[CSV_COLUMNS.indexOf('tags')]).toBe("'-cmd");
  });

  it('JSON: self-describing, only referenced folders, validated on import', () => {
    const json = toJSON([item()], [{ id: 'f1', name: 'Work', createdAt: 1 }, { id: 'f2', name: 'Unused', createdAt: 2 }], { exportedAt: 0, appVersion: '0.1.0' });
    const doc = JSON.parse(json);
    expect(doc).toMatchObject({ format: 'saveshelf-library', version: 1, appVersion: '0.1.0', exportedAt: '1970-01-01T00:00:00.000Z' });
    expect(doc.folders).toEqual([{ id: 'f1', name: 'Work', createdAt: 1 }]);
    const parsed = parseImport(json);
    expect(parsed.items[0]).toMatchObject({ id: 't3_a', tags: ['a b', 'c'], folderId: 'f1', seq: 5 });
  });

  it('rejects bad imports', () => {
    expect(() => parseImport('nope')).toThrow(/valid JSON/);
    expect(() => parseImport('{"format":"other"}')).toThrow(/export/);
    expect(() => parseImport('{"format":"saveshelf-library","version":99,"items":[]}')).toThrow(/version/);
    expect(() => parseImport('{"format":"saveshelf-library","version":1}')).toThrow(/items/);
    const ok = parseImport('{"format":"saveshelf-library","version":1,"items":[{"id":"bad"},null,{"id":"t3_ok","title":5}]}');
    expect(ok.items.map((i) => i.id)).toEqual(['t3_ok']); // junk rows dropped, fields coerced
    expect(ok.items[0].title).toBe('5');
  });

  it('api: export everything, a folder/tag query, or explicit ids; JSON round-trips into a fresh library', async () => {
    const src = await makeEnv({ children: makeChildren(40), pro: true });
    await src.api.sync.start();
    const f = await src.api.folders.create('Dev');
    const rust = await src.api.library.search({ q: 'r/rust', limit: 500 });
    await src.api.folders.move(rust.items.map((i) => i.id), f.id);
    await src.api.tags.add([rust.items[0].id], ['Favourite']);

    const all = await src.api.export.json();
    expect(all.count).toBe(40);
    expect(all.filename).toMatch(/^saveshelf-\d{4}-\d{2}-\d{2}\.json$/);
    const csvAll = await src.api.export.csv();
    expect(csvAll.count).toBe(40);
    expect(parseCsv(csvAll.content.slice(1)).length).toBe(41);

    const sub = await src.api.export.json({ query: { q: 'r/rust' } });
    expect(sub.count).toBe(rust.total);
    const byIds = await src.api.export.csv({ ids: [rust.items[0].id] });
    expect(byIds.count).toBe(1);
    expect(byIds.content).toContain('favourite');

    const dst = await makeEnv({ pro: true });
    const r = await dst.api.import.json(all.content);
    expect(r).toMatchObject({ added: 40, foldersCreated: 1 });
    expect((await dst.api.folders.list())[0]).toMatchObject({ name: 'Dev', count: rust.total });
    expect((await dst.api.tags.list())).toEqual([{ tag: 'favourite', count: 1 }]);
    expect((await dst.api.library.search({ q: 'tag:favourite' })).total).toBe(1);
  });

  it('api: import respects the free cap', async () => {
    const src = await makeEnv({ children: makeChildren(50), pro: true });
    await src.api.sync.start();
    const dump = await src.api.export.json();
    const free = await makeEnv({ pro: false });
    // shrink the effective cap by pre-filling to 290 via a Pro-less import of 300 is too slow; instead check boundary
    const big = await makeEnv({ children: makeChildren(310), pro: true });
    await big.api.sync.start();
    const bigDump = await big.api.export.json();
    const r = await free.api.import.json(bigDump.content);
    expect(r).toMatchObject({ added: 300, skipped: 10 });
    expect((await free.api.library.stats()).total).toBe(300);
    void dump;
  });
});

describe('restoring a backup from the real extension (live test file)', () => {
  it('imports the live-test backup, then merging it again adds nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('./fixtures/live-backup.json', import.meta.url), 'utf8');
    const env = await makeEnv({});
    const r = await env.api.import.json(text);
    expect(r).toMatchObject({ added: 1, merged: 0, skipped: 0 });
    const got = await env.api.library.search({ limit: 10 });
    expect(got.total).toBe(1);
    expect(got.items[0]).toMatchObject({ id: 't3_1xi36qj', subreddit: 'fries', title: 'My ideal cut of fries' });
    expect(await env.api.import.json(text)).toMatchObject({ added: 0, merged: 1 });
  });
});

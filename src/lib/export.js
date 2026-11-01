// Export / import. JSON is the lossless format (tags, folders, order); CSV is for spreadsheets.

import { LibraryError } from './errors.js';

export const EXPORT_FORMAT = 'saveshelf-library';
export const EXPORT_VERSION = 1;

export function toJSON(items, folders = [], { exportedAt = Date.now(), appVersion = '' } = {}) {
  const used = new Set(items.map((i) => i.folderId).filter(Boolean));
  const doc = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    appVersion,
    exportedAt: new Date(exportedAt).toISOString(),
    folders: folders.filter((f) => used.has(f.id)).map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    items,
  };
  return JSON.stringify(doc, null, 2);
}

/** Validate + parse an export produced by toJSON. Throws LibraryError('INVALID_IMPORT'). */
export function parseImport(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LibraryError('INVALID_IMPORT', 'File is not valid JSON');
  }
  if (doc?.format !== EXPORT_FORMAT) throw new LibraryError('INVALID_IMPORT', 'Not a SaveShelf export');
  if (!Number.isInteger(doc.version) || doc.version > EXPORT_VERSION) {
    throw new LibraryError('INVALID_IMPORT', `Unsupported export version ${doc.version}`);
  }
  if (!Array.isArray(doc.items)) throw new LibraryError('INVALID_IMPORT', 'Export has no items');
  const items = [];
  for (const raw of doc.items) {
    if (!raw || typeof raw.id !== 'string' || !/^t[13]_/.test(raw.id)) continue;
    items.push({
      id: raw.id,
      kind: raw.kind === 'comment' ? 'comment' : 'post',
      title: String(raw.title ?? ''),
      body: String(raw.body ?? ''),
      url: String(raw.url ?? ''),
      domain: String(raw.domain ?? ''),
      permalink: String(raw.permalink ?? ''),
      subreddit: String(raw.subreddit ?? ''),
      author: String(raw.author ?? ''),
      score: Number.isFinite(raw.score) ? raw.score : 0,
      numComments: Number.isFinite(raw.numComments) ? raw.numComments : 0,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
      nsfw: Boolean(raw.nsfw),
      flair: String(raw.flair ?? ''),
      removedOnReddit: Boolean(raw.removedOnReddit),
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      folderId: typeof raw.folderId === 'string' ? raw.folderId : null,
      seq: Number.isFinite(raw.seq) ? raw.seq : undefined,
      firstSyncedAt: Number.isFinite(raw.firstSyncedAt) ? raw.firstSyncedAt : undefined,
      lastSyncedAt: Number.isFinite(raw.lastSyncedAt) ? raw.lastSyncedAt : undefined,
    });
  }
  const folders = Array.isArray(doc.folders)
    ? doc.folders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
    : [];
  return { items, folders };
}

export const CSV_COLUMNS = [
  'id', 'type', 'title', 'subreddit', 'author', 'permalink', 'url', 'score', 'num_comments',
  'created_at', 'saved_order', 'tags', 'folder', 'nsfw', 'removed_on_reddit', 'body',
];

/** Neutralise spreadsheet formula injection in untrusted text cells (=, +, -, @, tab, CR). */
function safeText(value) {
  const s = String(value ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 CSV (CRLF line endings). `saved_order` = 1 for the most recently saved item.
 * @param {{bom?: boolean}} [opts] bom: prepend UTF-8 BOM so Excel reads non-ASCII correctly (default true)
 */
export function toCSV(items, folders = [], { bom = true } = {}) {
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const sorted = [...items].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  const rows = [CSV_COLUMNS.join(',')];
  sorted.forEach((it, i) => {
    rows.push(
      [
        it.id,
        it.kind,
        safeText(it.title),
        it.subreddit,
        safeText(it.author),
        it.permalink,
        safeText(it.url),
        it.score,
        it.numComments,
        it.createdAt ? new Date(it.createdAt).toISOString() : '',
        i + 1,
        safeText((it.tags ?? []).join('; ')),
        safeText(folderName.get(it.folderId) ?? ''),
        it.nsfw ? 'yes' : 'no',
        it.removedOnReddit ? 'yes' : 'no',
        safeText(it.body),
      ].map(csvCell).join(','),
    );
  });
  return (bom ? '\uFEFF' : '') + rows.join('\r\n') + '\r\n';
}

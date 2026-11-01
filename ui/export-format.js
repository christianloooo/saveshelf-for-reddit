// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Serializers for export. Pure functions with no DOM / chrome.* use, so the service worker can import them too.

export function toJSON(items) {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), count: items.length, items },
    null,
    2,
  );
}

const CSV_COLUMNS = ['id', 'type', 'title', 'subreddit', 'author', 'url', 'saved_at', 'created_at', 'score', 'comments', 'tags', 'text'];

function cell(v) {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCSV(items) {
  const rows = items.map((i) => [
    i.id, i.type, i.title, i.subreddit, i.author, i.url,
    new Date(i.savedAt).toISOString(), new Date(i.createdAt).toISOString(),
    i.score, i.numComments, i.tags.join('|'), i.snippet,
  ]);
  return [CSV_COLUMNS, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function buildExport(items, format) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') return { filename: `saveshelf-${stamp}.csv`, mime: 'text/csv', content: '\ufeff' + toCSV(items) };
  return { filename: `saveshelf-${stamp}.json`, mime: 'application/json', content: toJSON(items) };
}

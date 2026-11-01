// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
import { api } from '../src/lib/api.js';

const $ = (id) => document.getElementById(id);
const say = (t, err = false) => { $('status').textContent = t; $('status').style.color = err ? 'var(--danger)' : ''; };
const notify = (reason) => chrome.runtime.sendMessage({ ns: 'saveshelf', event: 'changed', reason }).catch(() => {});

function save(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function load() {
  const [s, stats, lic] = await Promise.all([api.settings.get(), api.library.stats(), api.license.status()]);
  $('autosync').checked = s.autoSync;
  $('hours').value = s.autoSyncHours;
  $('hours').disabled = !s.autoSync;
  $('analytics').checked = s.analyticsOptIn;
  $('preview').textContent = JSON.stringify(await api.settings.analyticsPreview(), null, 2);
  $('deleted-note').textContent = stats.deletedCount
    ? `${stats.deletedCount} item(s) you deleted are remembered so sync does not re-add them.`
    : 'Nothing is being remembered as deleted.';
  $('forget').disabled = !stats.deletedCount;
  $('testmode').hidden = !lic.stub;
  $('stubpro').checked = lic.tier === 'pro';
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { say(e.message, true); } };

$('autosync').addEventListener('change', guard(async () => { await api.settings.set({ autoSync: $('autosync').checked }); await load(); }));
$('hours').addEventListener('change', guard(async () => { await api.settings.set({ autoSyncHours: Number($('hours').value) }); await load(); }));
$('analytics').addEventListener('change', guard(async () => { await api.settings.set({ analyticsOptIn: $('analytics').checked }); await load(); }));
$('full').addEventListener('click', guard(async () => {
  say('Full re-sync running… this takes a while by design.');
  const r = await api.sync.start({ full: true });
  say(`Done: ${r.status}. ${r.added} new, ${r.updated} refreshed.`);
  await notify('sync');
}));
$('backup').addEventListener('click', guard(async () => { const x = await api.export.json(); save(x.filename, x.content, x.mime); say(`Exported ${x.count} items.`); }));
$('restore').addEventListener('change', guard(async () => {
  const f = $('restore').files[0];
  if (!f) return;
  say(`Restoring ${f.name}…`);
  let r;
  try { r = await api.import.json(await f.text()); } finally { $('restore').value = ''; } // so the same file can be picked again
  say(r.added || r.merged || r.skipped
    ? `Restored: ${r.added} added, ${r.merged} already here${r.skipped ? `, ${r.skipped} skipped (free limit)` : ''}.`
    : 'That backup has no saves in it, so nothing was restored.');
  await notify('import');
}));
$('forget').addEventListener('click', guard(async () => { await api.library.restoreDeleted(); await load(); say('Done. They will come back on the next sync.'); }));
$('stubpro').addEventListener('change', guard(async () => { await api.license.setStubPro($('stubpro').checked); await notify('plan'); say('Test plan updated.'); }));
$('wipe').addEventListener('click', () => $('confirm').showModal());
$('confirm').addEventListener('close', guard(async () => {
  if ($('confirm').returnValue !== 'ok') return;
  await api.library.clearAll({ confirm: true });
  await notify('wipe');
  await load();
  say('Local library deleted.');
}));

load().catch((e) => say(e.message, true));

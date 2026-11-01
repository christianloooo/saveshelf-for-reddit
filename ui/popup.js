import { hydrateIcons } from './icons.js';
import { getRecent, getItems, getPlan, getSyncStatus, syncNow, upgrade, onChange, openLibraryUrl } from './api.js';
import { h, ic, relTime, fmtNum, highlight, debounce, meterLevel, syncedText } from './util.js';

const $ = (id) => document.getElementById(id);
hydrateIcons();

function renderItems(items, query = '') {
  const list = $('list');
  list.replaceChildren(
    ...items.map((i) =>
      h('li', {},
        h('a', { class: 'item', href: i.url, target: '_blank', rel: 'noopener' },
          h('div', { class: 'item-title' }, highlight(i.title, query)),
          h('div', { class: 'item-meta' },
            ic(i.type === 'comment' ? 'message-square' : 'file-text', 13),
            h('span', { class: 'sub' }, `r/${i.subreddit}`),
            h('span', {}, '·'),
            h('span', {}, `saved ${relTime(i.savedAt)}`),
          ),
        ),
      ),
    ),
  );
  const empty = $('empty');
  empty.hidden = items.length > 0;
  if (!items.length) empty.textContent = query ? `No saved posts match “${query}”.` : 'Nothing saved yet. Save a post on Reddit and sync.';
  if (!items.length && !query) getSyncStatus().then((s) => {
    // a sync that finished and found nothing is a result, not "not synced yet"
    if (s.lastSyncAt && s.total === 0 && !$('empty').hidden && !$('q').value.trim()) empty.textContent = '0 saves: Reddit has none for this account yet. Save a post on Reddit, then sync again.';
  }).catch(() => {});
}

async function showList(query) {
  try {
    if (query.trim()) {
      $('list-title').textContent = 'Results';
      const { items, matched } = await getItems({ query, limit: 5 });
      renderItems(items, query);
      if (matched > 5) $('list-title').textContent = `Results · ${fmtNum(matched)} matches`;
    } else {
      $('list-title').textContent = 'Recent saves';
      renderItems(await getRecent(5));
    }
  } catch (err) {
    $('empty').hidden = false;
    $('empty').textContent = 'Could not load your library. ' + err.message;
  }
}

async function showSync() {
  const s = await getSyncStatus();
  $('sync-dot').dataset.state = s.state;
  $('sync-btn').classList.toggle('is-syncing', s.state === 'syncing');
  $('sync-text').textContent =
    s.state === 'syncing' ? (s.progress ? `Syncing ${fmtNum(s.progress.done)} / ${fmtNum(s.progress.total)}` : 'Syncing…')
    : s.state === 'error' ? 'Sync failed'
    : s.state === 'needs-login' ? 'Sign in to Reddit'
    : s.lastSyncAt ? syncedText(s) : 'Not synced yet';
  $('sync').title = s.message ?? '';
}

async function showPlan() {
  const p = await getPlan();
  const meter = $('meter');
  if (p.plan === 'pro') {
    $('usage-text').textContent = `${fmtNum(p.count)} items saved · Pro`;
    meter.hidden = true;
    $('upgrade-link').hidden = true;
    return;
  }
  meter.hidden = false;
  $('usage-text').textContent = p.limitReached
    ? `Free limit reached · ${fmtNum(p.count)} / ${fmtNum(p.cap)}`
    : `${fmtNum(p.count)} of ${fmtNum(p.cap)} free items`;
  meter.dataset.level = meterLevel(p);
  meter.setAttribute('aria-valuemax', p.cap);
  meter.setAttribute('aria-valuenow', p.count);
  $('meter-fill').style.width = `${Math.min(100, (p.count / p.cap) * 100)}%`;
  $('upgrade-link').hidden = !(p.limitReached || p.count / p.cap >= 0.8);
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  const url = openLibraryUrl(q);
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
});
$('q').addEventListener('input', debounce((e) => showList(e.target.value)));
$('sync-btn').addEventListener('click', async () => { $('sync-btn').classList.add('is-syncing'); await syncNow(); await refresh(); });
$('upgrade-link').addEventListener('click', async (e) => { e.preventDefault(); await upgrade(); await showPlan(); });
$('open-library').addEventListener('click', (e) => {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    e.preventDefault();
    chrome.tabs.create({ url: openLibraryUrl($('q').value.trim()) });
  }
});
$('open-library').href = openLibraryUrl();

async function refresh() {
  await Promise.all([showList($('q').value), showSync(), showPlan()]);
}
await refresh();
onChange(refresh);

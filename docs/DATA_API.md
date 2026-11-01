# Data API

Two layers. Use the first from UI code, the second from the options page / tests / future features.

```
UI page --chrome.runtime.sendMessage({ns:'saveshelf', method, args})--> service worker
        --> ui/sw-bridge.js registerUiRpc --> src/lib/ui-rpc.js (createUiHandlers) --> store / sync / license
options page, tests --> src/lib/api.js (createApi)            (same store, richer surface)
```

## 1. UI RPC contract — `src/lib/ui-rpc.js`

The contract is owned by the UI (`ui/README-ui.md`, mock: `ui/mock/mock-backend.js`); `tests/ui-contract.test.js` runs identical assertions against the mock and these handlers, and `tests/rpc-wire.test.js` drives them over a stubbed `chrome.runtime` bus. Replies are `{ok:true, result}` or `{ok:false, error}`.

`createUiHandlers(getDeps, { notifyChanged })` returns:

| method | args | result |
|---|---|---|
| `getItems` | `{query?, type?:'all'\|'post'\|'comment', subreddits?:string[], tags?:string[] (AND), folderId?:string\|'none', from?, to? (epoch ms, savedAt), sort?:'saved-desc'\|'saved-asc'\|'score-desc'\|'posted-desc', offset?, limit?}` | `{items: Item[], matched, total}` |
| `getFacets` | same params as `getItems` | `{subreddits:{name,count}[], tags:{name,count}[], allTags:string[], types:{post,comment}}`; each facet ignores its own filter |
| `addTag(id, tag)` / `removeTag(id, tag)` | | the item's `tags[]` (`[]` for unknown ids). Tag rule: trim, lowercase, whitespace→`-`, ≤32 chars |
| `exportItems(params, 'json'\|'csv')` | | `{filename, mime, content}`. **Free on every tier.** Honours filters incl. `folderId` (the file format has no folder column) |
| `listFolders` | | `{id, name, createdAt, count}[]` |
| `createFolder(name)` / `renameFolder(id, name)` | | the folder. Rejects (`LibraryError`: `INVALID_FOLDER`, `FOLDER_EXISTS`, `NOT_FOUND`; the bridge relays `message`) for empty / duplicate names, unknown id |
| `deleteFolder(id)` | | void; items are never deleted, they become un-filed |
| `moveToFolder(ids, folderId\|null)` | | void; `null` un-files; unknown folder rejects `NOT_FOUND` |
| `getPlan` | | `{plan:'free'\|'pro', cap:300\|null, count, pending, limitReached, priceLabel}` |
| `upgrade` | | `{opened, stub}`. Real mode opens the ExtensionPay page; stub mode flips local Pro. Backfill of pending saves starts automatically after a free→pro flip |
| `getSyncStatus` | | `{state:'idle'\|'syncing'\|'error'\|'needs-login', lastSyncAt:number\|null, added, total, progress:{done,total}\|null, message?}` |
| `syncNow` | | the new sync status |

`Item = {id, type, title, subreddit, author, url, snippet, score, numComments, savedAt, createdAt, tags, folderId}` (`folderId`: string \| null)
`folderId` filter: an id = only saves filed in that folder, `'none'` = only un-filed, absent = all; unknown id matches nothing. Combined with the other filters before paging; `getFacets` counts inside the folder; `total` stays the whole library. Folder edits call `notifyChanged('folders')`.
Mapping from the stored record: `type`=kind; `url`=Reddit permalink; `title` of a comment = parent post title; `snippet` = whitespace-collapsed body ≤300 chars (link posts show the outbound URL); `savedAt` = when sync first saw it (Reddit's API does not expose the true "saved at" time; order within one sync preserves Reddit's order). Search is case-insensitive substring-AND over title, **full** body, subreddit, author and tags.

### Free-cap semantics
* Stored items are never deleted by the cap. At 300 the library stops *adding*; sync keeps paging (politely) to count what it skipped → `pending`. `limitReached = plan==='free' && count>=cap`.
* After upgrading, sync runs a full walk and stores the pending items; `pending` goes to 0.
* Reddit itself only serves ~1,000 saved items, so `count + pending` ≤ ~1,000.

`notifyChanged(reason)` (from `ui/sw-bridge.js`) broadcasts `{ns:'saveshelf', event:'changed', reason}`; reasons used: `sync`, `plan`, `import`, `wipe`, `sync-progress`.

## 2. Rich API — `src/lib/api.js`

`createApi(getDeps)` (tests) or the page singleton `import { api } from '../src/lib/api.js'` (extension pages; the worker builds its own deps, see `src/lib/runtime.js`). All methods are async, throw `LibraryError {code, message}` on misuse.

* `api.library.search({q, sort, folderId|'none', tag, kind, subreddit, limit, offset})` → `{items,total,offset,limit,hasMore}`; `get(id)`, `delete(ids)` (tombstoned so sync doesn't re-add), `restoreDeleted()`, `subreddits()`, `stats()`, `clearAll({confirm:true})`.
* `api.tags.add/remove(ids, names)`, `set(id, names)`, `rename(from,to)`, `delete(name)`.
* `api.folders.list/create/rename/delete/move(ids, folderId)` (deleting a folder never deletes items). *The library sidebar uses the equivalent `ui-rpc.js` folder methods (section 1) through `ui/api.js`; the options page uses this layer.*
* `api.sync.start({full})`, `status()`, `onProgress(cb)`. Statuses: `ok`, `capped`, `not_logged_in`, `rate_limited`, `busy`, `aborted`, `error`.
* `api.export.json/csv(opts)` → `{filename, mime, content, count}` (JSON is a lossless backup incl. folders); `api.import.json(text)` merges, respects the cap.
* `api.license.status/refresh/upgrade/setStubPro`, `api.settings.get/set/analyticsPreview`.

## Storage
IndexedDB `saveshelf-library` v1: `items` (keyPath `id`, index on `seq`/`kind`/`subreddit`/`tags` multiEntry), `folders`, `meta` (sync state, `pendingIds`, `pending`), `tombstones`. Settings/licence/analytics state: `chrome.storage.local`; transient sync progress: `chrome.storage.session`.

## Sync behaviour (politeness)
Sequential requests only, 1.5 s + ≤0.5 s jitter between pages, 100 items/page, ≤12 pages, `Retry-After` / `x-ratelimit-*` honoured, ≤3 retries with exponential backoff, lock against concurrent runs, abortable. Incremental syncs stop at the first page that reaches already-known items.

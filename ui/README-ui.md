# SaveShelf for Reddit – UI (popup + full-page library)

Plain HTML/CSS/ES modules. No build step, no framework, no network. Lucide icons are inlined (`icons.js`).
Works with `prefers-color-scheme` dark mode, keyboard-accessible, native `<dialog>` / `popover`.

## Files
| File | Purpose |
|---|---|
| `popup.html/.css/.js` | Toolbar popup (380px): search, 5 recent saves, sync status, usage vs free cap, "Open full library" |
| `library.html/.css/.js` | Full-page library: search, sort, type/subreddit/date filters, tags, export, cap banner, Pro modal |
| `api.js` | **The only data interface the UI uses.** Forwards to the service worker (or mock when not in an extension) |
| `sw-bridge.js` | `registerUiRpc(handlers)` + `notifyChanged()` for the service worker side |
| `export-format.js` | Pure `buildExport(items, 'json'\|'csv')` – usable from the service worker |
| `mock/` | Mock backend + sample data. Executable spec of the semantics. Used when `chrome.runtime.id` is absent |
| `tokens.css`, `util.js`, `icons.js` | Design tokens, DOM helpers, Lucide SVGs |

## How to wire it (lecoder)
1. `manifest.json`: `"action": {"default_popup": "ui/popup.html"}`. The library opens via `chrome.tabs.create({url: chrome.runtime.getURL('ui/library.html')})`.
   No `tabs` permission is needed for that. Icons for the manifest are in `../icons/icon-{16,32,48,128}.png`.
2. Service worker (module): 
   ```js
   import { registerUiRpc, notifyChanged } from './ui/sw-bridge.js';
   registerUiRpc({ getItems, getFacets, addTag, removeTag, exportItems, getPlan, upgrade, getSyncStatus, syncNow,
                   listFolders, createFolder, renameFolder, deleteFolder, moveToFolder });
   // call notifyChanged() after a sync finishes, a plan change, or any item write
   ```
3. Message shape (already handled by `api.js` and `sw-bridge.js`):
   request `chrome.runtime.sendMessage({ns:'saveshelf', method, args})` → response `{ok:true,result}` or `{ok:false,error}`.
4. UI pages are served from the extension origin, so the default MV3 CSP is fine (no inline scripts, no eval).

Try it without the backend: serve `extension/` over http and open `ui/library.html`.
Mock scenarios by query string: `?count=300&pending=700` (capped), `?plan=pro`, `?sync=syncing|error|needs-login`, `?q=term`, `?upsell=1`.

## Data model
```ts
type Item = {
  id: string;            // reddit fullname, e.g. "t3_abc123" / "t1_xyz"
  type: 'post' | 'comment';
  title: string;         // comments: parent post title (UI shows "Re: ..." style as given)
  subreddit: string;     // without "r/"
  author: string;        // without "u/"
  url: string;           // permalink (https://www.reddit.com/...)
  snippet: string;       // selftext / comment body, plain text, trimmed (~300 chars)
  score: number; numComments: number;
  savedAt: number;       // epoch ms when the user saved it (or when we first saw it)
  createdAt: number;     // epoch ms of the post/comment
  tags: string[];        // lowercase, hyphenated, <= 32 chars
  folderId: string | null; // id of the folder the save is filed in, null = un-filed
};

type Folder = { id: string; name: string; createdAt: number; count: number };  // count = saves filed in it
```

## API (all async; see `api.js`)
| Method | Args → Result |
|---|---|
| `getItems(params)` | `{query?, type?:'all'\|'post'\|'comment', subreddits?:string[], tags?:string[] (AND), folderId?:string\|'none', from?:ms, to?:ms, sort?:'saved-desc'\|'saved-asc'\|'score-desc'\|'posted-desc', offset?, limit?}` → `{items, matched, total}` |
| `getFacets(params)` | same filter params → `{subreddits:[{name,count}], tags:[{name,count}], allTags:string[], types:{post,comment}}`. Each facet's counts ignore *that facet's own* filter (so users can broaden). `allTags` = every tag, unfiltered |
| `addTag(id, tag)` / `removeTag(id, tag)` | → the item's updated `tags[]`. Normalise on add: trim, lowercase, spaces→`-`, max 32 |
| `listFolders()` | → `Folder[]` (with `count`) |
| `createFolder(name)` / `renameFolder(id, name)` | → the `Folder`. Trim + collapse whitespace, ≤60 chars. Reject (readable `Error.message`) for an empty name, a duplicate name (case-insensitive) or, for rename, an unknown id |
| `deleteFolder(id)` | → void. **Never deletes saves**: they become un-filed |
| `moveToFolder(ids, folderId\|null)` | → void. `null` takes the saves out of any folder. Rejects for an unknown folder id |
| `exportItems(params, 'json'\|'csv')` | → `{filename, mime, content}` for items matching the filter params (UI turns it into a download). Use `buildExport` |
| `getPlan()` | → `{plan:'free'\|'pro', cap:300\|null, count, pending, limitReached, priceLabel}`. `pending` = saves found on Reddit but **not stored** because of the cap (drives the banner copy; use 0 if unknown) |
| `upgrade()` | open the checkout page (ExtensionPay). UI re-reads `getPlan()` after the modal closes; also call `notifyChanged()` when the paid status flips |
| `getSyncStatus()` | → `{state:'idle'\|'syncing'\|'error'\|'needs-login', lastSyncAt, added, total, progress:{done,total}\|null, message?}`. `added` = items the last sync added; `total` = items in the library now. The UI says "· N new" when `added > 0`, "· nothing new" when `added === 0`, and "· 0 saves" (plus an explicit empty state) when a sync finished (`lastSyncAt` set) and `total === 0`. |
| `syncNow()` | trigger a sync; resolves with the new sync status |

`folderId` filter (getItems / getFacets / exportItems): a folder id keeps only saves filed there, `'none'` only un-filed saves, absent = everything; an unknown id matches nothing. It is applied *with* the other filters, before paging, and facets are counted inside the folder (the folder is not a facet, so it never broadens). `total` in `getItems` stays the size of the whole library. The export file format is unchanged (`folderId` is not written; folders travel in the options-page backup). Folder methods call `notifyChanged('folders')`; `api.js` drops that broadcast on the page that made the edit.

Search semantics (mock = reference): case-insensitive; every whitespace-separated word must appear in
title / snippet / subreddit / author / tags (AND). Sorting by `saved-desc` is the default. `getItems` is paged by `offset`/`limit` (UI uses 40).

## Behaviour the backend should honour
* **Free cap:** when `plan==='free'` and `count >= cap`, stop *adding* new items (never delete stored ones), report `limitReached:true` and `pending`.
  Search, tags and export keep working at the cap. The UI shows a banner from 80% usage and a modal on request (banner / header button / popup link).
* After a paid upgrade, backfill the pending items and `notifyChanged()`.
* Export is intentionally free (privacy-first / no lock-in pitch on the landing page). Change if the paywall differs.

## Dev / verification scripts (`../tools`)
`node tools/e2e.mjs` (UI behaviour against the mock), `rpc-test.mjs` (api.js ↔ runtime-messaging path with a stubbed `chrome`),
`screenshots.mjs` (CWS screenshots), `build-landing.mjs` (landing from `landing.src.html`). They need `npm i` in `tools/` and a static server on :8765.

## Folders
Folders are part of the contract above (items carry `folderId`, the three read methods filter by it, five folder methods) and `ui/api.js` just forwards them; there is no client-side folder logic. In dev, `ui/mock/mock-backend.js` implements them in memory via `ui/mock/mock-folders.js` (`?folders=demo` seeds a few). The same assertions run against the mock and the real handlers in `tests/ui-contract.test.js`.

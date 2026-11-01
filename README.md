# SaveShelf for Reddit (MV3 Chrome extension)

A local, searchable library of **your own** Reddit saved posts and comments. Reddit only keeps your latest ~1,000 saves visible; this extension copies them into IndexedDB on your machine so you can search, tag and export them and keep them after Reddit stops showing them.

* **Sync**: from your logged-in reddit.com session (`/user/<you>/saved.json`), paginated, sequential, rate-limit aware, incremental. No scraping of other users, no Reddit login handled by the extension.
* **Library**: full-text search, subreddit/type/date filters, tags, CSV/JSON export (free on every tier), lossless JSON backup/restore (options page). Folders (create, rename, delete, move a save to a folder, filter by folder) in the library sidebar.
* **Free** keeps up to 300 items (never deletes; extra saves are counted as *pending*). **Pro** = unlimited, $9 one-time via [ExtensionPay](https://extensionpay.com) — **the repo now ships in real license mode** (`EXTPAY_ID = 'saveshelf-for-reddit'`). **Stripe is not connected to the ExtensionPay account yet, so live payments do not work**: Upgrade opens the real ExtensionPay page but nobody can complete a purchase until Stripe is connected in the ExtensionPay dashboard. Unit tests and `npm run e2e` run in stub mode (see below).
* **Analytics**: opt-in, anonymous, stubbed endpoint (see `PRIVACY.md`).

Status: feature-complete prototype, **unpublished, untested against the live reddit.com**. Nothing has been paid for, registered or submitted.

## Layout

```
manifest.json            MV3; permissions: storage, alarms; host: https://www.reddit.com/*; content script: ExtPay on extensionpay.com only
src/background.js        service worker: UI RPC, sync, alarms
src/config.js            ALL stubs/knobs (cap, price, STUB_LICENSE, EXTPAY_ID, ANALYTICS_ENDPOINT, sync pacing)
src/lib/                 db, store, search, sync, license, extpay (ExtensionPay glue), analytics, export, api (rich), ui-rpc (UI contract), runtime (wiring)
src/vendor/              the official ExtPay SDK 3.1.2 (see "Payments" below; regenerate with `npm run vendor:extpay`)
ui/                      popup + full-page library UI (merged from the former UI project; see below)
options/                 minimal settings page: auto-sync, backup/restore, analytics opt-in, test-mode Pro toggle
icons/                   from the UI source
docs/DATA_API.md         the data API (UI contract + rich API)
tests/                   vitest + fake-indexeddb; fixtures in Reddit's listing format (tests/fixtures, tests/helpers)
scripts/                 validate-manifest, package (zip, no `zip` CLI needed), e2e-chrome, e2e-extpay (real mode vs a local fake extensionpay.com)
dist/                    build output (git-ignored): unpacked/, <name>-stub.zip, e2e/ screenshots
```

### The UI folder
`ui/`, `icons/`, `landing/`, `store-assets/` and `tools/` were merged in from the former standalone UI project (`/workspace/reddit-saves`, built by leuifrontend); **this repo is now the single source of truth**. Edit `ui/` directly. The UI↔backend contract is `ui/README-ui.md`; `src/lib/ui-rpc.js` implements it and `tests/ui-contract.test.js` checks it against the UI's own dev mock (`ui/mock/`). The mock is dev-only: `scripts/package.mjs` strips its import from the packaged `ui/api.js` and `ui/mock/` is not shipped.

```
landing/         marketing page (generated from tools/landing.src.html: `npm run build:landing`)
store-assets/    Chrome Web Store screenshots (store-assets/screenshots, `npm run screenshots`)
tools/           icon/landing/screenshot generators, UI-only mock e2e (`npm run test:ui-mock`)
```

## Develop

```
npm install
npm run check      # validate manifest -> unit tests -> UI mock e2e -> build zip -> e2e in headless Chrome -> ExtPay real-mode e2e
npm test           # unit tests (vitest)
npm run build      # dist/unpacked + dist/saveshelf-for-reddit-<ver>.zip   (a `-stub` suffix appears only if EXTPAY_ID is blanked)
```

Load unpacked: chrome://extensions → Developer mode → "Load unpacked" → `dist/unpacked` (log in to reddit.com, click the toolbar icon, press sync).

`npm run e2e:extpay` runs the same extension in **real license mode** (EXTPAY_ID patched into a temp copy) against a local fake extensionpay.com: upgrade opens the payment page via the SDK, then the success page → content script → worker → `onPaid` flips the plan to Pro. It never contacts the real extensionpay.com.

`npm run e2e` launches system Chrome (`CHROME_PATH` to override) with the built extension and a **local fake reddit.com** (self-signed HTTPS + `--host-resolver-rules`), runs a real sync, tags, searches, exports, renders popup/library/options and saves screenshots to `dist/e2e/`. It never contacts real Reddit.

## Payments / ExtensionPay

**Shipped config = real mode**: `EXTPAY_ID = 'saveshelf-for-reddit'` in `src/config.js`. The plan (**$9 one-time, nickname `pro`**) is defined in the ExtensionPay dashboard; the code never names a plan or sets a price (`tests/extpay.test.js` pins that; `PRO_PRICE_USD` is display text only). **Stripe is not connected yet, so live payments will not work** until the owner connects Stripe in the ExtensionPay dashboard.

**Stub mode** (blank the id): no network, no account, "Upgrade" flips a local Pro flag (also available as a test switch on the options page). The test suites keep covering it without touching the shipped config: `vitest.config.js` blanks the id while loading `src/config.js`, and `npm run e2e` runs a temp copy of `dist/unpacked` with the id blanked; `e2e:extpay` swaps in a throwaway id and talks only to a local fake.

| | stub (`EXTPAY_ID = ''`) | real (shipped: `EXTPAY_ID = 'saveshelf-for-reddit'`) |
|---|---|---|
| plan source | local flag | `extpay.getUser().paid`, re-checked at most every 30 s while Free, daily by alarm, after `onPaid`, and before each manual sync |
| Upgrade button | flips the flag | `extpay.openPaymentPage()` (a tab on extensionpay.com) |
| after paying | n/a | success page → content script → worker → SDK polls the user → `onPaid` → licence re-verified, UI told (`changed: plan`), saves the cap held back are backfilled, conversion counted for opted-in users |
| offline | n/a | a purchase verified within the last 30 days (`OFFLINE_GRACE_DAYS`) is still honoured |
| zip name | `…-stub.zip` | `….zip` |

Wiring: `src/lib/extpay.js` (service + `onPaid` handler), `src/background.js` (top-level, synchronous `startBackground()`, as MV3 service workers require), `src/lib/runtime.js` (provider for the licence), `manifest.json` (content script for `https://extensionpay.com/*` as ExtPay requires for `onPaid`; no extra permission, `storage` was already there). `scripts/validate-manifest.mjs` pins that content script to exactly the ExtPay one.

**Vendored SDK**: `src/vendor/ExtPay.js` is `dist/ExtPay.js` from the official npm package `extpay@3.1.2` (pinned devDependency), byte for byte; it is the content script. `src/vendor/ExtPay.esm.js` is the same file plus one appended line, `export default ExtPay;`, because the worker is an ES module and cannot `importScripts`. `npm run vendor:extpay` regenerates both and `tests/vendor-extpay.test.js` fails if they drift.

**Licence caveat for the owner**: the SDK is copyleft. Its source header says AGPLv3, its `package.json` says `AGPL-3.0-or-later`, and the package's `LICENSE` file only contains the text `LGPL-3.0`. This repo is MIT. Shipping the SDK inside the extension means the combined work may have to be offered under the AGPL, and the bundled `webextension-polyfill` is MPL-2.0. Get a legal read (or ask ExtensionPay for their position on extension authors) before publishing a real-mode build.

**Test mode**: ExtensionPay has a test mode per extension; an unpacked (development) install uses it automatically, and the payment page asks for your account password before Stripe Checkout (use Stripe's test cards). See "Manual live test" below.

## Manual live test on a real Reddit account

Automated tests use a fake Reddit, so none of this is proven yet. Use a throwaway or low-stakes account first, and do this in a separate Chrome profile. Nothing here needs a code change; read the worker console at `chrome://extensions` → SaveShelf → "service worker" while you go.

1. **Load unpacked**: `npm run build`, then chrome://extensions → Developer mode → Load unpacked → `dist/unpacked`. Confirm: no errors on the extension card, the welcome library tab opens, the popup opens from the toolbar.
2. **Log in** to reddit.com in that profile (normal login, 2FA if you use it). Reload the popup: it should offer to sync, not say "sign in".
3. **Confirm the session cookie is sent**: open the service worker DevTools → Network, press Sync. `GET https://www.reddit.com/api/me.json` must return your username (not `{}` / a login redirect) and the `saved.json` requests must return 200 with your items. In the request headers check `Cookie:` is present (`reddit_session`/`token_v2`). If sync reports "needs login" while you are logged in, extension-origin fetches are not carrying the session; that is the top risk, note the status codes and stop.
4. **First sync**: expect sequential `saved.json?limit=100` requests ~1.5–2 s apart, progress in the popup/library, and a final count. Library cards should show real titles, subreddits, snippets, links that open the right Reddit page, and comments with their parent context.
5. **Check against the ~1,000 limit**: on an account with ≥1,000 saves, the total should stop at about 1,000 (Reddit's cap), not 1,000+; with the free cap on you should see 300 stored and the rest shown as *pending* ("N more saves are waiting"). Compare the library count with Reddit's own saved page; note any items that appear on Reddit but not here (e.g. NSFW, deleted, quarantined) and any type mismatch (posts vs comments).
6. **Incremental sync**: save one new post on Reddit, press Sync again. It should issue ~2 requests, add exactly 1 item and say so. Press Sync with nothing new: "Synced just now · nothing new", no duplicates. An account with 0 saves shows "0 saves" and an explicit empty state, not a blank library. The popup's Sync button is in the footer (not the top-right, where an early click lands on the host page's controls). Also try "full sync" from the options page and confirm the count does not change.
7. **Free cap and pending count**: with ≥300 saves, confirm the cap banner, that the library holds exactly 300, that pending = saves − 300 (up to Reddit's ~1,000), that nothing is deleted when you sync again, and that exporting still works (export is free). Then flip the test Pro switch (options page, stub mode) or use Upgrade and confirm the pending items backfill to the full count.
8. **Export**: library → Export → CSV and JSON. Open both: row/item counts match the library, special characters and newlines in titles/bodies survive, the CSV opens in a spreadsheet without broken rows. Try a filtered view and confirm only the matches are exported. Round-trip the options-page backup (back up, delete library, click "Restore from backup…", pick the file) and confirm the counts match.
9. **Unsave behaviour**: the extension never writes to Reddit and never deletes your local copy. Unsave an item on Reddit, sync, and confirm it is **still** in the library (that is the point of the extension) and that nothing is removed or duplicated. Re-save it and confirm no duplicate. Note that unsaving frees nothing in the local free cap.
10. **Rate limits**: do not provoke Reddit on purpose. Watch the sync's response headers (`x-ratelimit-remaining`, `x-ratelimit-reset`) and confirm the worker slows down when `remaining` is low. Run two syncs back to back and confirm the second is refused/queued rather than doubling the traffic. If you ever see a 429, confirm the popup says Reddit asked us to slow down, the worker waits for `Retry-After`, and a later sync recovers. Leave auto-sync at 6 h; do not lower it for the test.
11. **ExtPay test mode** (real mode only, needs the owner's go-ahead since it means registering at extensionpay.com): create the extension there in **test mode**, set `EXTPAY_ID`, `npm run build`, load the new `dist/unpacked`. Confirm: Upgrade opens the extensionpay.com plan page in a tab (not the stub flip) and the options-page test switch is gone; pay with Stripe's test card `4242 4242 4242 4242` (any future date/CVC; you will be asked for your ExtensionPay password in test mode); on the success page the library should flip to Pro **without a reload** (that is `onPaid` and the content script) and the pending saves backfill; the zip is named without `-stub`. Then reload the extension and confirm Pro persists, turn the network off and confirm Pro is still honoured (30-day grace), and use ExtensionPay's dashboard to refund/cancel the test payment and confirm the plan returns to Free on the next check (assuming ExtensionPay then reports the user as unpaid; if it does not, note it). Also confirm the install permission warning lists only reddit.com and extensionpay.com.

Record what you saw (status codes, counts, anything odd) before changing code; the fixes most likely needed are in `src/lib/sync.js` (headers, pagination, `me.json` shape) and `src/lib/normalize.js` (field shapes).

## Before you publish (checklist — each needs the owner's go-ahead)

1. **Payments** (see "Payments / ExtensionPay" below): the extension is registered and `EXTPAY_ID = 'saveshelf-for-reddit'` is set ($9 one-time, plan nickname `pro`). **Still to do: connect Stripe in the ExtensionPay dashboard** (until then live payments cannot complete), and check test-mode checkout first (item 11 of the live test). Resolve the SDK licence question (AGPL, see below).
2. **Analytics**: stand up a collector (HTTPS, CORS POST of `text/plain` JSON, no IP logging) and set `ANALYTICS_ENDPOINT`, or leave it empty to ship with no analytics at all. Update `PRIVACY.md` accordingly.
3. **Name/branding**: "Reddit" in the name is a trademark risk (see `CHROMEWEBSTORE.md`).
4. **Legal**: read Reddit's current terms/Data API terms before charging for something that reads reddit.com JSON.
5. Host the privacy policy (`landing/privacy.html` is the web version of `PRIVACY.md`; keep them in sync; contact email is set), replace `PLACEHOLDER_EXTENSION_ID` in the landing page links. License is MIT (`LICENSE`).
6. `npm run build` — with `EXTPAY_ID` set the zip has no `-stub` suffix (`dist/saveshelf-for-reddit-<ver>.zip`). Upload manually.

## Known gaps / honest caveats
* **Not verified against live Reddit.** Whether extension-origin `fetch(..., {credentials:'include'})` carries the session cookie (SameSite, Reddit's bot defences) is unproven; the e2e uses a fake. Test with a real account before anything else (see "Manual live test on a real Reddit account" above). Reddit may also change/limit `.json` endpoints.
* Reddit only serves ~1,000 saved items; older ones can't be imported by any method.
* `savedAt` is when we first saw an item (Reddit doesn't expose the true saved time). Items backfilled after upgrading are ordered by Reddit's order but dated at backfill time.
* The sync worker can be interrupted if Chrome kills the service worker mid-sync; progress is persisted and the next sync resumes incrementally.
* Folders are part of the UI↔service-worker contract (`folderId` on items and filters, five folder methods); there is no bulk "move" yet (the library has no multi-select). No settings UI in the contract beyond the minimal options page.
* Opt-in analytics undercounts installs; conversions are only counted for opted-in users.
* The vendored `ui/api.js` has a dynamic `import('./mock/mock-backend.js')` that only runs outside the extension; the mock is excluded from the package so it is dead code there.
* `ui/library.js` `renderCard` passes a `null` child to `li.append()`, which renders the text "null" when a card has no snippet. Worked around server-side (link posts get their URL as the snippet) but the UI should filter nulls.

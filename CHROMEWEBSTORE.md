# Chrome Web Store listing notes (draft — nothing has been submitted)

## Single purpose
Let a user search, tag and export their own Reddit saved posts and comments from a local library stored in their browser.

## Permission justifications
| Permission | Justification (paste into the dashboard) |
|---|---|
| `storage` | Saves the user's settings and licence state locally (also required by the ExtensionPay SDK). |
| `alarms` | Schedules the optional background re-sync (default every 6 hours) and a once-a-day licence check. |
| Host `https://www.reddit.com/*` | Reads the signed-in user's **own** saved-items list (`/user/<name>/saved.json`) with the user's existing session, so the items can be kept locally. No other host is contacted for Reddit data. |
| Content script on `https://extensionpay.com/*` | Required by ExtensionPay for payment confirmation (`onPaid`): on the payment-success page it relays a "payment finished" message to the extension. It runs only on extensionpay.com, never on Reddit or other sites. Shows as "read and change your data on extensionpay.com" in the install prompt. |

Not requested: `tabs`, `cookies`, `history`, `<all_urls>`, `scripting`, `webRequest`. (The IndexedDB library needs no permission; `unlimitedStorage` is not requested and is not required for text data at this scale.)

## Data-use disclosures (Privacy practices tab)
* Collected & stored **locally only**: "Web history"-adjacent personal content = the user's own Reddit saved items; nothing leaves the device.
* No analytics in this version: `ANALYTICS_ENDPOINT` is empty (nothing is ever sent) and the Settings analytics toggle is hidden when it is empty. Do NOT tick "User activity".
* Certify: not sold; not used for unrelated purposes; not used for creditworthiness.
* Privacy policy URL: https://saveshelf.surge.sh/privacy.html (live on Surge, from `landing/`). Homepage: https://saveshelf.surge.sh/

## Listing text starting points
* Name: "SaveShelf for Reddit" (short name "SaveShelf"). "Reddit" appears only descriptively ("for Reddit"); Chrome Web Store and Reddit both discourage trademarks in names, so keep the "not affiliated with Reddit, Inc." line in the listing and on the landing page, and be ready to drop "for Reddit" if a reviewer objects.
* Summary (≤132): "Search, tag and export your Reddit saved posts and comments. Everything stays on your device, beyond Reddit's 1,000-save limit."
* Screenshots: the store-ready 1280x800 set is in `store-assets/screenshots/` (regenerate with `npm run screenshots`); `dist/e2e/*.png` are real-extension captures against fixture data.
* Pricing: free up to 300 items; Pro is a one-time $9 via ExtensionPay. Disclose the in-app purchase.

## Source repository (listing text)
* Add to the listing description and the Support/Homepage field: "Open source (AGPL-3.0-or-later). Source code: https://github.com/christianloooo/saveshelf-for-reddit"
* The same line is in `store-listing/full-description.txt`.

## Review risks
* Reddit ToS / API terms: the extension uses the user's own session against reddit.com JSON endpoints (not the OAuth API). Reddit's Data API terms restrict commercial use of the API; get a legal read before charging. Keep it single-user, polite and rate limited.
* Stub build must never be uploaded: stub mode (no `EXTPAY_ID`) grants Pro locally. The zip carries a `-stub` suffix while stub mode is on.
* Licensing: SaveShelf is AGPL-3.0-or-later, which matches the vendored ExtPay SDK (AGPL-3.0-or-later; its LICENSE file says LGPL-3.0; the polyfill inside is MPL-2.0). `LICENSE` and `THIRD_PARTY_NOTICES.md` ship in the zip. Open-source: say so in the listing and link the source repo.

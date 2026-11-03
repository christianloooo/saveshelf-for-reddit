# Privacy practices tab: answers to paste into the Developer Dashboard

Source of truth: `manifest.json` (v0.1.1), `PRIVACY.md`, `src/` and `landing/`. Nothing here has been submitted.

## Single purpose
SaveShelf for Reddit lets a user search, tag, organise in folders and export their own Reddit saved posts and comments from a local library stored in their browser.

## Permission justifications

| Permission | Justification (paste) |
|---|---|
| `storage` | Stores the user's settings (auto-sync on/off and interval), sync progress and the Pro license state in `chrome.storage.local` / `chrome.storage.session`. The saved-post library itself is in IndexedDB and needs no permission. Also used by the ExtensionPay SDK for its local key. |
| `alarms` | Schedules (1) the optional background sync, which is off by default and runs only if the user turns on "Sync automatically" in Settings, at the interval they choose (default 6 hours), and (2) one daily check that re-verifies the Pro license and sends the opt-in anonymous "active" count, if the user enabled it. A service worker cannot use timers for this. |
| Host `https://www.reddit.com/*` | Reads the signed-in user's own saved list with their existing browser session: `GET /api/me.json` (to learn the username) and `GET /user/<name>/saved.json` (paged, sequential, rate-limit aware). This is the extension's core function. No other reddit.com data is requested, and nothing is ever written to Reddit. |
| Content script on `https://extensionpay.com/*` | Required by the ExtensionPay payment library. On the payment-success page it relays a "payment finished" message to the extension so Pro unlocks without a reload. It runs only on extensionpay.com, never on reddit.com or any other site. The install prompt shows it as "read and change your data on extensionpay.com". |

Not requested: `tabs`, `activeTab`, `cookies`, `history`, `scripting`, `webRequest`, `unlimitedStorage`, `<all_urls>`. The extension opens its own library page on first install (`chrome.tabs.create` on an extension URL needs no permission).

Reviewer note: the content script on extensionpay.com is only present because ExtensionPay requires it; `scripts/validate-manifest.mjs` pins it to exactly that script.

## Remote code
**No, I am not using remote code.** All JavaScript is in the package, including the vendored ExtensionPay SDK (`src/vendor/ExtPay.js`, byte-identical to npm `extpay@3.1.2`). The extension-page CSP is `script-src 'self'; object-src 'self'; base-uri 'none'`. No `eval`, no remotely hosted scripts or modules, no WebAssembly from the network. Network requests are data-only (JSON from reddit.com, ExtensionPay license checks, and the optional analytics POST).

## Data usage: what to tick

The extension has no server that receives the user's saves. Items below say whether data leaves the device.

| Data type (dashboard checkbox) | Tick? | What and where |
|---|---|---|
| Personally identifiable information | **Yes (conservative)** | Reddit username, read from `/api/me.json` and used only to build the request URL on reddit.com. Not stored in analytics, not sent to the publisher. |
| Health information | No | n/a |
| Financial and payment information | **Yes, if the published build has real ExtensionPay (`EXTPAY_ID` set)** | The one-time $1.50 purchase is made on extensionpay.com / Stripe. The extension never sees card data; it only receives paid/unpaid status. Tick it to stay on the safe side of review. In a stub build (no payments) do not tick. |
| Authentication information | No | The extension never reads Reddit cookies or tokens. The browser attaches the user's own session to the reddit.com request. ExtensionPay keeps a random key locally; no password is handled by the extension. |
| Personal communications | No | n/a |
| Location | No | n/a |
| Web history | No | The extension does not read tabs or browsing history. |
| User activity | **No** (v0.1.1 has no analytics) | `ANALYTICS_ENDPOINT` is empty, so nothing is ever sent, and the Settings analytics toggle is hidden. The code for an opt-in counter exists but is inactive. If an endpoint is ever set, tick this box and update the policy first. |
| Website content | **Yes** | Text, titles, subreddit, author, links, scores and dates of the user's own saved Reddit posts and comments, read from reddit.com and stored only in this browser. Never transmitted to the publisher or anyone else. |

Handling statements to match (for the "how is it used" fields): used only to provide the single purpose (local search, tags, folders, export); not shared; not sold.

## Certifications (tick all three; each is true for the current code)
1. I do not sell or transfer user data to third parties, outside of the approved use cases. (ExtensionPay/Stripe process the user's payment on their own site; no Reddit data goes to them.)
2. I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
3. I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL
**https://saveshelf.surge.sh/privacy.html** (live on Surge, served from `landing/`). The text matches `PRIVACY.md` and the page links its contact address chrislo3823@gmail.com. Paste this URL in the dashboard. It must stay public and match the answers above.

## Homepage / website field
**https://saveshelf.surge.sh/** (also set as `homepage_url` in `manifest.json`).

## Consistency checks before submitting
* `PRIVACY.md` and `landing/privacy.html` still say the same thing and the analytics section matches the build config.
* Analytics are disabled in this build and PRIVACY.md, `landing/privacy.html` and the listing say so plainly.
* The zip name must not end in `-stub` (stub mode grants Pro locally and makes no payment requests).

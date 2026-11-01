# Privacy Policy — SaveShelf for Reddit

_Draft for review by the publisher before the extension is submitted. Last updated: 2026-11-01._

Web version: https://saveshelf.surge.sh/privacy.html

**Short version:** your saved posts and comments stay on your device. We do not run a server that receives them, we cannot see them, and we never sell or share data.

## What the extension does with your data

| Data | Where it goes | Why |
|---|---|---|
| Your Reddit saved posts and comments (title, text, subreddit, author, link, score, dates) | Read from reddit.com using **your own logged-in browser session**, then stored **only in this browser** (IndexedDB). Never uploaded anywhere. | So you can search, tag and export them. |
| Your tags and folders | Stored only in this browser. | Organisation. |
| Settings (auto-sync on/off, interval, analytics choice) | `chrome.storage.local`, this browser only. | Remember your preferences. |
| Your Reddit username | Held only to build the request URL for *your own* saved list. Not sent anywhere except reddit.com. | Reddit's saved list lives at `/user/<you>/saved`. |

The extension only reads **your own** saved items. It does not read, collect or store other people's profiles, and it does not read any page you are browsing. The only content script is the payment library's, and it runs solely on extensionpay.com payment pages (it passes a "payment finished" signal to the extension); it does not run on reddit.com or any other site.

## Network requests

* **reddit.com** (`https://www.reddit.com/*`): `GET /api/me.json` and `GET /user/<you>/saved.json`, sequentially, with delays, honouring Reddit's rate-limit headers.
* **ExtensionPay** (`https://extensionpay.com`; only when Pro payments are enabled in the published build, never in the free tier's normal use until you open the upgrade page or the extension re-checks a purchase): checks whether your one-time purchase is active. It identifies you to ExtensionPay with a random key stored by the extension; no Reddit data is sent. ExtensionPay (and its payment processor, Stripe) handle your email and card details; the extension never sees card data. See extensionpay.com and stripe.com for their policies.
* **Anonymous usage statistics** (optional, **off by default**): see below.

No other network requests are made. No remote code is loaded.

## Anonymous usage statistics (opt-in)

If — and only if — you tick the box in Settings, the extension sends up to three kinds of event to the publisher's endpoint:
`install`, `active` (at most once per day) and `conversion` (when you buy Pro). Each contains exactly:

```json
{ "event": "active", "anonId": "<random UUID>", "v": "0.1.0", "tier": "free", "day": "2026-11-01" }
```

`anonId` is generated when you opt in, is unrelated to your Reddit account or Google account, and is deleted when you opt out. **Never sent:** Reddit username, saved content, subreddits, tags, folder names, counts of items, search terms, URLs. The settings page shows this exact payload. The collector must not log IP addresses (publisher's obligation; see README).
Because it is opt-in, the figures undercount real usage.

## Retention and deletion

Everything lives in your browser until you delete it. Settings → "Delete my whole local library" erases items, tags and folders; uninstalling the extension removes all of its stored data. Deleting an item here does not delete it on Reddit.

## Children

The extension is not directed to children under 13.

## Changes

Material changes will be described in the extension's release notes and this file.

## Source code

SaveShelf is open source under the AGPL-3.0-or-later, so you can check every claim above in the code: https://github.com/christianloooo/saveshelf-for-reddit

## Contact

Questions or deletion requests: **christianlo3823@gmail.com**

_(The extension keeps nothing on a server, so there is nothing for us to delete remotely; this address is for questions and for the opt-in statistics, if you enabled them.)_

_Not affiliated with, endorsed by, or sponsored by Reddit, Inc. "Reddit" is a trademark of Reddit, Inc._

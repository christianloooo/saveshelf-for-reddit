# Privacy Policy — SaveShelf for Reddit

_Last updated: 2026-11-01 (version 0.1.1)._

Web version: https://saveshelf.surge.sh/privacy.html

**Short version:** your saved posts and comments stay on your device. We do not run a server that receives them, we cannot see them, and we never sell or share data. **This version collects no analytics or usage data of any kind.**

## What the extension does with your data

| Data | Where it goes | Why |
|---|---|---|
| Your Reddit saved posts and comments (title, text, subreddit, author, link, score, dates) | Read from reddit.com using **your own logged-in browser session**, then stored **only in this browser** (IndexedDB). Never uploaded anywhere. | So you can search, tag and export them. |
| Your tags and folders | Stored only in this browser. | Organisation. |
| Settings (auto-sync on/off, interval) | `chrome.storage.local`, this browser only. | Remember your preferences. |
| Your Reddit username | Held only to build the request URL for *your own* saved list. Not sent anywhere except reddit.com. | Reddit's saved list lives at `/user/<you>/saved`. |

The extension only reads **your own** saved items. It does not read, collect or store other people's profiles, and it does not read any page you are browsing. The only content script is the payment library's, and it runs solely on extensionpay.com payment pages (it passes a "payment finished" signal to the extension); it does not run on reddit.com or any other site.

## Network requests

* **reddit.com** (`https://www.reddit.com/*`): `GET /api/me.json` and `GET /user/<you>/saved.json`, sequentially, with delays, honouring Reddit's rate-limit headers.
* **ExtensionPay** (`https://extensionpay.com`; only when Pro payments are enabled in the published build, never in the free tier's normal use until you open the upgrade page or the extension re-checks a purchase): checks whether your one-time purchase is active. It identifies you to ExtensionPay with a random key stored by the extension; no Reddit data is sent. ExtensionPay (and its payment processor, Stripe) handle your email and card details; the extension never sees card data. See extensionpay.com and stripe.com for their policies.

No other network requests are made. In particular, **no analytics, telemetry, crash reports or usage statistics are sent anywhere**. No remote code is loaded.

## Analytics: none

This version of SaveShelf collects **no analytics**. It does not count installs, active users, searches, syncs or purchases, and it has no usage-statistics setting. The build's analytics address (`ANALYTICS_ENDPOINT`) is empty, so there is nowhere to send anything, and the Settings page does not show an analytics option.

The open-source code contains an optional, off-by-default counter that is switched off in this build. If a future version ever turns it on, it will be opt-in, it will say exactly what it sends in Settings, and this policy will be updated first.

## Retention and deletion

Everything lives in your browser until you delete it. Settings → "Delete my whole local library" erases items, tags and folders; uninstalling the extension removes all of its stored data. Deleting an item here does not delete it on Reddit.

## Children

The extension is not directed to children under 13.

## Changes

Material changes will be described in the extension's release notes and this file.

## Source code

SaveShelf is open source under the AGPL-3.0-or-later, so you can check every claim above in the code: https://github.com/christianloooo/saveshelf-for-reddit

## Contact

Questions or deletion requests: **chrislo3823@gmail.com**

_(The extension keeps nothing on a server, so there is nothing for us to delete remotely; this address is for questions.)_

_Not affiliated with, endorsed by, or sponsored by Reddit, Inc. "Reddit" is a trademark of Reddit, Inc._

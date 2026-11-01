# SaveShelf for Reddit: Chrome Web Store listing package

Nothing in this folder has been submitted or published. Copy fields into the Developer Dashboard by hand once the open items below are settled.
Regenerate the images: `node store-listing/make-assets.mjs` (from the repo root; sample data only, writes inside this folder).

## Field checklist

| Dashboard field | File | Status |
|---|---|---|
| Summary / short description (max 132) | `short-description.txt` | Ready. 127 chars; identical to `manifest.json` `description`, which the store uses as the summary. |
| Detailed description | `full-description.txt` | Ready. Plain text, sections, "not affiliated with Reddit, Inc." line. Check that the pricing lines match the published build. |
| Category | `category.txt` | Ready: Productivity > Workflow & Planning (fallback: Tools). |
| Store icon 128x128 | `icon-128.png` | Ready. 128x128, copied from `icons/icon-128.png`, which is the `128` entry in `manifest.json`. |
| Screenshots (1-5, 1280x800) | `screenshots/1-library-and-folders.png`<br>`2-search-your-saves.png`<br>`3-filter-by-folder.png`<br>`4-toolbar-popup.png`<br>`5-export-json-csv-dark.png` | Ready. Rendered from the current UI (with folders) on the dev mock with sample data; contact email and old names do not appear. Old `store-assets/screenshots/` predate folders: do not use them. |
| Small promo tile 440x280 | `promo-tile-440x280.png` | Ready. Name, icon, one line. Marquee tile (1400x560) not made; it is optional. |
| Single purpose | `privacy-practices.md` | Ready. |
| Permission justifications (storage, alarms, reddit.com host, extensionpay.com content script) | `privacy-practices.md` | Ready. |
| Remote code | `privacy-practices.md` | Ready: No. |
| Data usage checkboxes + 3 certifications | `privacy-practices.md` | Ready, but two boxes depend on the published build (payments, analytics); see open items. |
| Privacy policy URL | `privacy-practices.md` | Ready: https://saveshelf.surge.sh/privacy.html (live on Surge). |
| Support / contact email | none | **Needs Chris** (see below). |
| Homepage / website URL | `privacy-practices.md` | Ready: https://saveshelf.surge.sh/ (live on Surge; also `homepage_url` in the manifest). |
| Support URL | none | Optional; can reuse the homepage or the support email. |
| Distribution, regions, pricing | none | Free listing with in-app purchase via ExtensionPay; choose in the dashboard. |

## Open items for Chris
1. **Contact/support email.** `PRIVACY.md`, `landing/privacy.html` and the full description use `christianlo3823@gmail.com` (the earlier `contact@example.com` placeholder is gone). Confirm it is the address you want public on the listing, or give a dedicated support address. The dashboard also needs a verified contact email on the developer account.
2. **Hosted URLs are done** (homepage and `/privacy.html` on Surge). Still open: replace `PLACEHOLDER_EXTENSION_ID` in the landing page install links with the store ID once assigned, then redeploy. Surge is a free static host; move to a custom domain if wanted, keeping the privacy URL stable.
3. **ExtPay account.** At the time of this commit `src/config.js` in git has `EXTPAY_ID = ''` (stub mode), but another agent has an uncommitted change setting `EXTPAY_ID = 'saveshelf-for-reddit'` (real mode). Confirm that account exists under Chris's login, that Stripe is connected, and that the $9 one-time plan (nickname `pro`) is created in the ExtensionPay dashboard. Never upload a `-stub` zip. Resolve the SDK licence question in the README (AGPL) before publishing. With real mode, tick "Financial and payment information" (see `privacy-practices.md`).
4. **Analytics.** `ANALYTICS_ENDPOINT` is empty, so nothing is ever sent even if a user opts in. Either leave it empty (then do not tick "User activity", and ideally trim the analytics section of PRIVACY.md to say it is not active) or stand up a collector that does not log IPs and set the endpoint (then tick "User activity").
5. **Reddit terms/legal.** The extension reads reddit.com JSON with the user's own session. Get a legal read on Reddit's terms before charging $9. Also be ready to drop "for Reddit" from the name if a reviewer objects to the trademark.
6. **Not verified against live Reddit** (README "Known gaps"): do the manual live test before submitting.
7. **Developer account**: one-time registration fee and 2-step verification are the owner's to do.
8. Optional: a marquee promo tile (1400x560) and a YouTube promo video.

## Notes
* Screenshots show "Upgrade to Pro" and "243 of 300 free items used", which reflect the Free plan in a real-mode build. The dev mock supplies the sample items (invented titles, usernames and subreddits).
* Screenshot 4 reuses `tools/scenes/popup-scene.html`, a plain backdrop with the real popup UI in a frame.

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris L. Licensed under the GNU AGPL v3 or later; see LICENSE.
// Realistic-looking sample saves for the mock backend / screenshots. Not real posts.
// [type, subreddit, title, author, snippet, score, comments, tags]
export const SEED = [
  ['post', 'ExperiencedDevs', 'After 12 years, the best career advice I can give: write things down', 'quietbuilder', 'Keep a brag doc, a decision log and a "things I got wrong" file. Reviews, promotions and job hunts all get easier when you have receipts.', 8421, 612, ['career']],
  ['post', 'programming', 'How SQLite is tested: 590x more test code than library code', 'drh_fan', 'A walk through the four independent test harnesses, fuzzers, and why they still find bugs after twenty years.', 5390, 287, ['testing', 'read-later']],
  ['comment', 'AskCulinary', 'Re: Why does my bread come out dense no matter what I do?', 'sourdough_sam', 'Your starter is probably not at peak. Do the float test, and give the dough more time at room temperature before shaping. Hydration is rarely the real problem.', 1893, 41, ['recipes']],
  ['post', 'homelab', 'My 10-inch rack finally feels finished (mini PCs, 2.5GbE, 38W idle)', 'rackrat', 'Three N100 boxes running Proxmox, a fanless switch and a Pi for DNS. Parts list and power measurements inside.', 3120, 204, ['hardware']],
  ['post', 'personalfinance', 'I read every fee in my 401(k) so you do not have to', 'index_fund_ian', 'Expense ratios were the small part. The recordkeeping fee and the "managed account" upsell cost more over 30 years.', 12704, 1530, ['money', 'read-later']],
  ['post', 'MechanicalKeyboards', 'Comparing 14 linear switches with a force gauge and a microphone', 'thocklab', 'Bottom-out force, travel to actuation and sound spectra for every switch, with raw data in a spreadsheet.', 2417, 133, ['hardware']],
  ['comment', 'ExperiencedDevs', 'Re: How do you keep side projects alive past the first month?', 'shipsmall', 'Make the smallest useful version and use it daily. If you are not your own user, you will quit around week three.', 1204, 58, ['career', 'side-projects']],
  ['post', 'Frontend', 'You probably do not need a CSS-in-JS runtime in 2026', 'cascade_cat', 'Native nesting, @layer, container queries and :has() cover most of what we used libraries for. Migration notes included.', 1688, 176, ['css']],
  ['post', 'travel', 'Two weeks in Japan on a mid-range budget: what I would do differently', 'tokyodrifter', 'Skip the rail pass if you stay in one region, book the sleeper ferry, and eat at ticket-machine restaurants at least twice.', 6822, 498, ['trips']],
  ['post', 'selfhosted', 'Self-hosting a password manager for the family: what actually broke', 'vaultkeeper', 'Backups, reverse proxy headers and mobile app sync were the three rough spots. Here is the checklist I wish I had.', 2955, 322, ['hardware', 'read-later']],
  ['post', 'LearnJapanese', 'A realistic 1-year plan that worked for me (45 min per day)', 'kanji_slowly', 'Core deck for 4 months, graded readers after that, and conversation exchange from month 3. Burnout is the real enemy.', 4510, 260, ['learning']],
  ['comment', 'personalfinance', 'Re: Is it worth paying off a 3% mortgage early?', 'math_before_mood', 'Compare it to the risk-free rate you can get today, not to the stock market. Then decide how much liquidity you want.', 2208, 97, ['money']],
  ['post', 'sysadmin', 'Postmortem: the DNS change that took down our own status page', 'oncall_owl', 'Circular dependency, a 24h TTL and a runbook nobody had tested. What we changed afterwards.', 3774, 410, ['devops', 'read-later']],
  ['post', 'photography', 'Shot the same street for 365 days. Here are the 12 keepers', 'frameofmind', 'Light matters more than gear. Notes on timing, patience and the editing I stopped doing.', 7236, 189, ['inspiration']],
  ['post', 'webdev', 'The accessibility checklist I give every junior on my team', 'a11y_amy', 'Keyboard first, visible focus, real buttons, labels on every input, and test with a screen reader once a sprint.', 5113, 340, ['css', 'accessibility']],
  ['post', 'AskHistorians', 'How did medieval cities actually deal with sewage?', 'dr_midden', 'Cesspits, gong farmers, rivers as drains and surprisingly strict ordinances. A long answer with sources.', 9912, 275, ['read-later']],
  ['post', 'Cooking', 'The only 5 knife skills you need to learn first', 'mise_en_place', 'The claw grip, the rock chop, julienne, dice and breaking down a chicken. Practice on onions and carrots.', 3366, 154, ['recipes']],
  ['post', 'learnprogramming', 'Stop collecting tutorials. Build this instead (a list of 20 tiny projects)', 'build_first', 'Each project teaches exactly one concept and takes a weekend at most. Pick one and ship it.', 6120, 301, ['learning']],
  ['comment', 'sysadmin', 'Re: What is the one habit that saved you the most on-call pain?', 'pager_pete', 'Write the runbook while the incident is still fresh, and make fixing the alert part of the postmortem actions.', 1740, 36, ['devops']],
  ['post', 'DIY', 'Built floating shelves from a single 2x10 and zero visible hardware', 'sawdust_sunday', 'Hidden steel rod, tight drilled holes, and a jig made from scrap. Step by step with photos.', 4408, 120, ['projects']],
  ['post', 'Fitness', 'Evidence-based programming for people with 3 days a week', 'liftsmart', 'Full body, two hard sets per exercise, progress by reps first. Simple works if you keep showing up.', 5821, 380, ['health']],
  ['post', 'Python', 'uv replaced pip, pipx, pyenv and virtualenv on all my machines', 'snake_case_', 'One tool for environments and installs, and the lockfile finally behaves. Migration tips for monorepos.', 7305, 410, ['tools']],
  ['post', 'webdev', 'Core Web Vitals: what moved the needle on a real production site', 'perf_pat', 'Image priority, font loading and cutting third-party scripts did 90% of the work. Before and after numbers.', 2680, 144, ['performance']],
  ['post', 'Frontend', 'Container queries changed how I think about components', 'cascade_cat', 'A card that adapts to its slot instead of the viewport. Examples with real layouts and no JS.', 2004, 87, ['css']],
  ['post', 'startups', 'We got our first 100 customers without ads. Here is the unglamorous list', 'bootstrap_bea', 'Forums, cold DMs to people already complaining, and a free tool that fed the paid product.', 4177, 266, ['business']],
  ['comment', 'startups', 'Re: Is a one-time price a bad idea for a small software product?', 'priced_right', 'For tools with low running costs it is a feature, not a bug. Customers are tired of subscriptions for utilities.', 1520, 72, ['business']],
  ['post', 'gadgets', 'I tested 9 portable SSDs for heat throttling. Two were terrible', 'benchmark_ben', 'Sustained writes tell a very different story from the headline numbers. Charts and methodology inside.', 3011, 205, ['hardware']],
  ['post', 'linux', 'A sane, boring dotfiles setup that survives reinstalls', 'stow_away', 'Plain git, one install script and GNU Stow. No frameworks, no magic, 40 lines of shell.', 2760, 118, ['tools']],
  ['post', 'books', 'Books that changed how I think about work: a quiet list of 15', 'marginalia', 'Mostly older titles, a few novels, one surprising cookbook. Short notes on what each taught me.', 5392, 421, ['read-later', 'inspiration']],
  ['post', 'datascience', 'Please stop using accuracy as your only metric', 'precision_recall', 'A walkthrough with imbalanced data, calibration plots and the questions to ask stakeholders first.', 3902, 156, ['learning']],
  ['post', 'ChatGPTCoding', 'What I learned shipping an extension in a week with AI assistance', 'weekend_shipper', 'Scope tightly, write the data layer by hand, let the model do the boring UI and tests.', 1844, 232, ['side-projects']],
  ['comment', 'Frontend', 'Re: How do you structure design tokens without a framework?', 'token_tess', 'CSS custom properties on :root, one file, semantic names (surface, text, accent) and a dark scheme override via prefers-color-scheme.', 987, 24, ['css']],
  ['post', 'gardening', 'Three years of no-dig beds: soil tests before and after', 'compost_chris', 'Organic matter doubled and weeds dropped by roughly 80%. Cardboard, compost and patience.', 2230, 99, ['projects']],
  ['post', 'privacy', 'Browser extensions that keep everything local: a vetted list', 'zero_cloud', 'Each one checked for network requests with the dev tools open. No accounts, no telemetry.', 3560, 174, ['tools', 'privacy']],
  ['post', 'sideproject', 'I built a tiny tool for my own annoyance and 4,000 people use it now', 'itch_scratcher', 'Small, focused, boring tech. The landing page is one static file and the pricing is a one-time $1.50.', 2416, 188, ['side-projects', 'business']],
  ['post', 'ErgoMechKeyboards', 'Switching to a split keyboard fixed my wrist pain. Tenting and layout notes', 'neutral_wrists', 'Start with a layout that keeps the keys you use most on the home row. Give yourself a month.', 1932, 143, ['health', 'hardware']],
  ['post', 'AskCulinary', 'What is the difference between stock, broth and bone broth, really?', 'stock_exchange', 'Collagen, time, salt and what you plan to cook with it. A practical guide, not a purity test.', 2661, 82, ['recipes']],
  ['post', 'europe', 'The long read on how night trains came back, route by route', 'sleeper_seeker', 'New operators, new rolling stock and what still holds the network back. Maps included.', 5740, 509, ['trips', 'read-later']],
];

export const FILLER_SUBS = ['programming', 'webdev', 'ExperiencedDevs', 'personalfinance', 'Cooking', 'homelab', 'travel', 'books', 'DIY', 'Python', 'linux', 'photography'];
export const FILLER_TOPICS = ['caching', 'error handling', 'pour-over coffee', 'index funds', 'keyboard shortcuts', 'sleep schedules', 'sourdough', 'Docker networking', 'trail running', 'budget travel', 'note-taking', 'SQL joins', 'Rust ownership', 'cold plunges', 'film cameras', 'mesh Wi-Fi'];
export const FILLER_FORMS = [
  (t) => `A beginner-friendly guide to ${t}, written by someone who got it wrong first`,
  (t) => `What I wish I knew about ${t} five years ago`,
  (t) => `Weekly discussion: your best tips for ${t}`,
  (t) => `I spent a month testing ${t}. The results surprised me`,
  (t) => `The definitive FAQ on ${t} (updated this year)`,
];
export const FILLER_AUTHORS = ['plain_spoken', 'north_by_nw', 'late_bloomer', 'tinker_tom', 'notes_nora', 'fieldwork_fi', 'the_long_game', 'grain_of_salt'];
export const FILLER_TAGS = [[], [], [], ['read-later'], ['learning'], ['tools'], []];

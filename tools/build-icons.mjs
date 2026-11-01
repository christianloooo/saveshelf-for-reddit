import fs from 'node:fs';
import { ROOT } from './lib.mjs';
const names = ['search','bookmark','library','refresh-cw','check','x','tag','download','file-json','file-spreadsheet','sparkles','lock','shield-check','external-link','message-square','file-text','calendar','chevron-down','plus','arrow-right','arrow-up','hard-drive','zap','infinity','search-x','circle-alert','layers','inbox','clock','link','settings','trash-2','cloud-off','list-filter','badge-check','heart','folder','folder-plus','folder-open','folder-input','pencil','ellipsis'];
const out = {};
for (const n of names) {
  const svg = fs.readFileSync(`${ROOT}node_modules/lucide-static/icons/${n}.svg`, 'utf8');
  out[n] = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<!--.*?-->/gs,'').replace(/\s+/g, ' ').trim();
}
const js = `// Lucide icons (ISC license, https://lucide.dev), inlined so the extension needs no network or bundler.
// Static strings only - never interpolate user data into these.
const PATHS = ${JSON.stringify(out, null, 1)};

export function icon(name, size = 16, label = '') {
  const inner = PATHS[name];
  if (!inner) throw new Error('Unknown icon: ' + name);
  const a11y = label ? \`role="img" aria-label="\${label}"\` : 'aria-hidden="true"';
  return \`<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" \${a11y}>\${inner}</svg>\`;
}

/** Replace every <i data-icon="name" data-size="16"> inside root with the inline SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    const tpl = document.createElement('template');
    tpl.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 16);
    el.replaceWith(tpl.content.firstElementChild);
  }
}
`;
fs.writeFileSync(`${ROOT}ui/icons.js`, js);
console.log(Object.keys(out).length);

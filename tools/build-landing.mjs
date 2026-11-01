import fs from 'node:fs';
import { ROOT } from './lib.mjs';
const dir = `${ROOT}node_modules/lucide-static/icons/`;
let html = fs.readFileSync(`${ROOT}tools/landing.src.html`, 'utf8');
html = html.replace(/\{\{icon:([a-z-]+)\}\}/g, (_, n) => {
  if (n === 'chrome-placeholder') return '';
  const inner = fs.readFileSync(dir + n + '.svg', 'utf8').replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<!--.*?-->/gs, '').replace(/\s+/g, ' ').trim();
  return `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
});
fs.writeFileSync(`${ROOT}landing/index.html`, html);

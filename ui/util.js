import { icon } from './icons.js';

/** Tiny DOM helper: h('div', {class:'x', onclick}, child, 'text'). Text is always inserted as text nodes (no innerHTML with data). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

/** Inline Lucide icon element. */
export function ic(name, size = 16, label = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, label);
  return t.content.firstElementChild;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
export function relTime(ts, now = Date.now()) {
  const s = Math.round((ts - now) / 1000);
  const a = Math.abs(s);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  if (a < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), 'month');
  return rtf.format(Math.round(s / (86400 * 365)), 'year');
}
export const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const nf = new Intl.NumberFormat();
export const fmtNum = (n) => nf.format(n);
export const fmtCompact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** Returns a DocumentFragment with query words wrapped in <mark>. Safe for untrusted text. */
export function highlight(text, query) {
  const words = (query ?? '').trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const frag = document.createDocumentFragment();
  if (!words.length) { frag.append(text); return frag; }
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  text.split(re).forEach((part, i) => frag.append(i % 2 ? h('mark', {}, part) : part));
  return frag;
}

export const debounce = (fn, ms = 120) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/** Shared "meter" fill level for plan usage. */
export function meterLevel(plan) {
  if (!plan.cap) return 'ok';
  const r = plan.count / plan.cap;
  return r >= 1 ? 'full' : r >= 0.8 ? 'warn' : 'ok';
}

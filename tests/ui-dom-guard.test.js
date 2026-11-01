import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the "stray null" bug: Element.replaceChildren()/append()/prepend() turn a null/undefined/false
// argument into the literal TEXT "null" (unlike our h() helper, which skips them). So in ui/ and options/ any such call
// whose arguments can be null (a `cond ? x : null` / `&& x` / `?? null`) must go through fill() or filter the list.
const root = new URL('..', import.meta.url).pathname;
const files = ['ui', 'options'].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.js')).map((f) => join(d, f)));

const NULLABLE = /(\?\s*(null|undefined|false)\s*:)|(:\s*(null|undefined|false)\s*(,|$))|(\?\?\s*null)|(&&\s*h\()/;

function calls(src) {
  const out = [];
  const re = /\.(replaceChildren|append|prepend|before|after)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; }
    out.push({ name: m[1], args: src.slice(re.lastIndex, i - 1), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

describe('DOM child insertion never passes a nullable value', () => {
  for (const f of files) {
    it(f, () => {
      const bad = calls(readFileSync(join(root, f), 'utf8'))
        .filter((c) => NULLABLE.test(c.args) && !/\.filter\(/.test(c.args))
        .map((c) => `${f}:${c.line} .${c.name}(…) can receive null; use fill() from util.js`);
      expect(bad).toEqual([]);
    });
  }

  it('the old bug shape is caught by the guard', () => {
    const src = "empty.replaceChildren(a, none ? null : b);";
    expect(calls(src).filter((c) => NULLABLE.test(c.args))).toHaveLength(1);
    expect(calls('x.append(a, ok ? b : null);').filter((c) => NULLABLE.test(c.args))).toHaveLength(1);
    expect(calls('x.append(...kids.filter(Boolean));')).toHaveLength(1);
  });
});

// Reassemble a served page from its C++ source.
//
// Each page is a PROGMEM string built by concatenating raw string literals around
// the UI_CSS macro, so the three pages share one stylesheet and cannot drift. That
// means the HTML cannot be read straight off disk - this puts it back together the
// way the compiler will, so the tests and the screenshot harness look at exactly
// what the board serves.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function rawLiteral(src, tag) {
  const m = src.match(new RegExp(`R"${tag}\\(([\\s\\S]*?)\\)${tag}"`));
  if (!m) throw new Error(`no R"${tag}(...)" literal found`);
  return m[1];
}

let cssCache = null;
function uiCss() {
  if (cssCache === null) {
    cssCache = rawLiteral(readFileSync(join(here, '../NexonOBD/ui_css.h'), 'utf8'), 'css');
  }
  return cssCache;
}

// file is relative to firmware/test/.
export function pageSource(file) {
  const src = readFileSync(join(here, file), 'utf8');
  if (file.endsWith('.html')) return src;          // already plain HTML

  let out = '';
  const re = /R"rawliteral\(([\s\S]*?)\)rawliteral"|\bUI_CSS\b/g;
  let m, found = false;
  while ((m = re.exec(src)) !== null) {
    found = true;
    out += m[1] !== undefined ? m[1] : uiCss();
  }
  if (!found) throw new Error(`no page literal in ${file}`);
  return out;
}

export function scriptsOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

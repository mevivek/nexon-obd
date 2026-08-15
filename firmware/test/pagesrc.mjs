// Reassemble a served page from its C++ source.
//
// Each page is a PROGMEM string built by concatenating raw string literals around
// the FW_VERSION macro, so the HTML cannot be read straight off disk - this puts it
// back together the way the compiler will, so the tests and the screenshot harness
// look at exactly what the board serves.
//
// The shared stylesheet used to be spliced in the same way, via a UI_CSS macro. It
// is now served separately from /ui.css and linked, so that a tab switch does not
// re-download an identical 7 KB; uiCss() below is what that route sends, and the
// harness serves it at the same path the pages ask for.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function rawLiteral(src, tag) {
  const m = src.match(new RegExp(`R"${tag}\\(([\\s\\S]*?)\\)${tag}"`));
  if (!m) throw new Error(`no R"${tag}(...)" literal found`);
  return m[1];
}

// The shared stylesheet is served from /ui.css rather than inlined, so the harness
// has to serve it too - and the rules that used to be asserted against page source
// are now asserted against this.
let cssCache = null;
export function uiCss() {
  if (cssCache === null) {
    cssCache = rawLiteral(readFileSync(join(here, '../NexonOBD/ui_css.h'), 'utf8'), 'css');
  }
  return cssCache;
}

// The pages splice the version literal in the same way they splice the stylesheet.
let verCache = null;
export function fwVersion() {
  if (verCache === null) {
    const src = readFileSync(join(here, '../NexonOBD/version.h'), 'utf8');
    const m = src.match(/#define\s+FW_VERSION\s+"([^"]+)"/);
    if (!m) throw new Error('no FW_VERSION in version.h');
    verCache = m[1];
  }
  return verCache;
}

// file is relative to firmware/test/.
export function pageSource(file) {
  const src = readFileSync(join(here, file), 'utf8');
  if (file.endsWith('.html')) return src;          // already plain HTML

  let out = '';
  const re = /R"rawliteral\(([\s\S]*?)\)rawliteral"|\bUI_CSS\b|\bFW_VERSION\b/g;
  let m, found = false;
  while ((m = re.exec(src)) !== null) {
    found = true;
    if (m[1] !== undefined) out += m[1];
    else if (m[0] === 'UI_CSS') out += uiCss();
    else out += fwVersion();
  }
  if (!found) throw new Error(`no page literal in ${file}`);
  return out;
}

export function scriptsOf(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

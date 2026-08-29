// Unterminated string literals in the firmware source.
//
// The host suite compiles the ISO-TP layer and asserts the rest of the sketch
// against its own text, but nothing in it ever parses the sketch as C++. extract.py
// pulls named functions, so anything outside that list - setup(), the handlers, the
// periodic tasks - can carry a syntax error the whole suite passes over. Twice in
// one afternoon a printf lost its \n escape to a text-munging script, turning
//
//     Serial.printf("[triage] resuming, %u ids\n", n);
//
// into a string split across two lines. Both times the suite went green and the
// error appeared only at `arduino-cli compile`, which needs a 6 GB toolchain and is
// the slowest possible place to learn it. One of them was committed and pushed.
//
// This is the cheap guard: a line whose double quotes do not balance is either a
// broken literal or a construct nobody here writes. It costs milliseconds and it
// catches the whole class before the compiler is even started.
//
// It is deliberately a lint over lines rather than a parser. Raw strings and
// comments are skipped rather than understood, because a parser is a thing that
// itself needs testing and this needs to stay obviously correct.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lines whose string literals do not close.
 *
 * @returns {{line: number, text: string}[]}
 */
export function unbalancedQuotes(src) {
  const out = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');

  let inBlockComment = false;
  let rawTag = null;             // inside R"TAG( ... )TAG", which spans lines legally

  for (let i = 0; i < lines.length; i++) {
    let s = lines[i];

    // A raw string in flight: look for its closing tag and resume after it.
    if (rawTag !== null) {
      const end = s.indexOf(')' + rawTag + '"');
      if (end < 0) continue;
      s = s.slice(end + rawTag.length + 2);
      rawTag = null;
    }

    if (inBlockComment) {
      const end = s.indexOf('*/');
      if (end < 0) continue;
      s = s.slice(end + 2);
      inBlockComment = false;
    }

    // Drop escaped characters wholesale: \" and \\ must not be read as delimiters.
    let t = s.replace(/\\./g, '');

    // A raw string opening on this line takes the rest of it with it.
    const raw = t.match(/R"([A-Za-z0-9_]*)\(/);
    if (raw) {
      const close = t.indexOf(')' + raw[1] + '"');
      if (close < 0) { rawTag = raw[1]; t = t.slice(0, raw.index); }
      else t = t.slice(0, raw.index) + t.slice(close + raw[1].length + 2);
    }

    // Character literals hold no double quotes and only confuse the count.
    t = t.replace(/'(?:[^'])*'/g, '');

    // A // or /* outside a string ends the code on this line. "Outside" is decided
    // by whether an even number of quotes precedes it.
    const cut = (marker) => {
      let at = t.indexOf(marker);
      while (at >= 0) {
        const before = (t.slice(0, at).match(/"/g) || []).length;
        if (before % 2 === 0) return at;
        at = t.indexOf(marker, at + 1);
      }
      return -1;
    };
    const line = cut('//'), block = cut('/*');
    if (line >= 0 && (block < 0 || line < block)) t = t.slice(0, line);
    else if (block >= 0) {
      const shut = t.indexOf('*/', block + 2);
      if (shut < 0) { inBlockComment = true; t = t.slice(0, block); }
      else t = t.slice(0, block) + t.slice(shut + 2);
    }

    if (((t.match(/"/g) || []).length) % 2) out.push({ line: i + 1, text: s.trim() });
  }
  return out;
}

/** Every firmware source file, so a new header is covered the day it is added. */
export function firmwareSources(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.h') || f.endsWith('.ino'))
    .map((f) => ({ name: f, src: readFileSync(join(dir, f), 'utf8') }));
}

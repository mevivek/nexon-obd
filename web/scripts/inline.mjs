// Fold the script and stylesheet into index.html, so the bundle is one file.
//
// Not a size optimisation - one gzip stream over the lot is a shade smaller than
// three, but that is noise. It is about how the thing gets installed. The board is
// updated from a phone standing next to a car, and picking three files out of a
// downloads folder on a phone is materially worse than picking one. A firmware
// update is a single .bin; the frontend should cost no more than that.
//
// Nothing is lost by inlining. Separate files would let the browser cache app.js
// across changes to index.html, but the two only ever change together here: a
// deploy replaces the whole bundle, and the firmware serves index.html with
// no-cache precisely so a new one is picked up.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error('inline: no dist/index.html - run vite build first');
  process.exit(1);
}

let html = readFileSync(indexPath, 'utf8');

// An HTML parser ends a <script> at the first `</script`, wherever it appears -
// inside a string literal included. Same for </style>. Vite would have no reason to
// emit either, but "no reason to" is not a guarantee, and the failure mode is a
// dashboard that silently truncates.
const guard = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');

let inlined = 0;

// <script type="module" crossorigin src="./app.js"></script>
html = html.replace(
  /<script([^>]*?)\ssrc="\.?\/?(app[^"]*\.js)"([^>]*)><\/script>/gi,
  (whole, before, file, after) => {
    const p = join(dist, file);
    if (!existsSync(p)) return whole;
    const js = guard(readFileSync(p, 'utf8'));
    unlinkSync(p);
    inlined++;
    // Keep whatever attributes the build asked for - type="module" above all, since
    // the code is ESM and would throw on the first import statement without it.
    // Drop crossorigin, which means nothing once there is no request to make.
    const attrs = (before + after).replace(/\scrossorigin/gi, '').trim();
    return `<script${attrs ? ' ' + attrs : ''}>${js}</script>`;
  });

// <link rel="stylesheet" crossorigin href="./app.css">
html = html.replace(
  /<link[^>]*?href="\.?\/?(app[^"]*\.css)"[^>]*>/gi,
  (whole, file) => {
    const p = join(dist, file);
    if (!existsSync(p)) return whole;
    const css = guard(readFileSync(p, 'utf8'));
    unlinkSync(p);
    inlined++;
    return `<style>${css}</style>`;
  });

if (inlined === 0) {
  console.error('inline: found nothing to inline - did the build output change?');
  process.exit(1);
}

writeFileSync(indexPath, html);
console.log(`\n  inlined ${inlined} asset${inlined > 1 ? 's' : ''} into index.html`);

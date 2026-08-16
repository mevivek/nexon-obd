// Emit a .gz beside every compressible file in dist/.
//
// The firmware serves the pre-compressed copy when the client sends
// Accept-Encoding: gzip, so the board never spends CPU compressing and never
// stores the bytes twice in flash beyond what is uploaded. Node's zlib does this
// in twenty lines, which is one fewer build dependency to licence-check than
// vite-plugin-compression.
import { gzipSync, constants } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

// Anything already compressed (png, woff2, ...) only gets bigger.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.map']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const kb = (n) => (n / 1024).toFixed(1).padStart(7) + ' KB';

let rawTotal = 0, gzTotal = 0;
const rows = [];

for (const file of walk(dist)) {
  if (file.endsWith('.gz')) continue;
  const raw = readFileSync(file);
  if (!COMPRESSIBLE.has(extname(file))) {
    rows.push([relative(dist, file), raw.length, null]);
    rawTotal += raw.length;
    gzTotal += raw.length;
    continue;
  }
  const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
  writeFileSync(file + '.gz', gz);
  rows.push([relative(dist, file), raw.length, gz.length]);
  rawTotal += raw.length;
  gzTotal += gz.length;
}

// 300 KB is the whole-bundle budget: the filesystem partition is 1.5 MB and the
// trip logs need most of it (README, "Trip logs").
const BUDGET = 300 * 1024;

console.log('\n  dist/                                raw        gzip');
for (const [name, raw, gz] of rows.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(28)} ${kb(raw)}  ${gz == null ? '       —  ' : kb(gz)}`);
}
console.log(`  ${'TOTAL'.padEnd(28)} ${kb(rawTotal)}  ${kb(gzTotal)}`);
console.log(`  budget                       ${' '.repeat(9)}  ${kb(BUDGET)}  ` +
            `(${((gzTotal / BUDGET) * 100).toFixed(1)} % used)\n`);

if (gzTotal > BUDGET) {
  console.error(`  gzipped bundle is over the ${kb(BUDGET).trim()} budget.`);
  process.exit(1);
}

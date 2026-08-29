// The "All values" table, checked in a real browser.
//
// This suite exists because no unit test can check this table. The thing that can
// break is the pairing between a row definition and the cell that displays it: get
// that wrong and every value appears against the wrong PID, which is worse than a
// blank one and which nothing else notices. Rendering it is the only way to know.
//
// The table used to live in the firmware's own dashboard page. That page is gone -
// the frontend is a Vite/Preact bundle under web/, served off LittleFS - so the
// primary target here is the built bundle, driven exactly the way the board serves
// it: gzipped assets with Content-Encoding, unknown paths falling back to
// index.html. That is the same static handling shots_spa.mjs uses, for the same
// reason: what is measured has to be what the firmware hands out.
//
//   npm --prefix web run build
//   NODE_PATH=/opt/node22/lib/node_modules node firmware/test/test_table.mjs

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageSource } from './pagesrc.mjs';
import { loadPlaywright } from './browser.mjs';
// The bundle's own row definitions, so adding a PID does not need this file edited
// and the two can never disagree about what row 12 is.
import { ROWS as BUNDLE_ROWS } from '../../web/src/pages/live/rows.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../../web/dist');

const pw = loadPlaywright({ soft: true });
if (!pw) {
  // Not a failure: the rest of the suite runs without a browser, and a machine
  // without Playwright should still be able to run it.
  console.log('table: skipped - playwright not installed');
  process.exit(0);
}
const { chromium } = pw;

// A browser is present, so the bundle target is expected to run. Build it if it has
// not been built - silently skipping it would leave the one check that cannot be
// done anywhere else undone.
if (!existsSync(join(dist, 'index.html'))) {
  console.log('table: no bundle build found, running `npm --prefix web run build`');
  try {
    execFileSync('npm', ['--prefix', join(here, '../../web'), 'run', 'build'],
                 { stdio: 'inherit' });
  } catch (e) {
    console.error(`table: could not build the bundle (${e.message})`);
  }
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error('table: FAIL - no web/dist to test. Run: npm --prefix web ci && '
                + 'npm --prefix web run build');
  process.exit(1);
}

let ran = 0, failed = 0;
function ok(cond, what) {
  ran++;
  if (cond) console.log(`  ok    ${what}`);
  else { failed++; console.log(`  FAIL  ${what}`); }
}
function eq(got, want, what) {
  ok(Object.is(got, want), `${what}${Object.is(got, want) ? '' : ` (got ${got}, want ${want})`}`);
}

// A full sample, and the same sample with the b2 batch missing - which is the state
// that puts held values into the stale class, and the one the whole hold-last-value
// design exists for.
const FULL = {
  rpm: 2150, speed: 58, map: 92, baro: 100, throttle: 18.4, load: 34.5,
  coolant: 89, oil: 96, iat: 34, ambient: 34, volt: 14.32, stft: 2.3,
  ltft: -1.6, lambda: 0.998, cat: 642.5, timing: 18.5, fuelRate: 4.85,
  fuel: 100, runtime: 1284, tripKm: 23.62, tripL: 1.661,
  // The bundle's table lists the pedal and torque PIDs too; sending them means every
  // row below carries a real number rather than being skipped as never-sent.
  absLoad: 41.2, pedalD: 22.7, pedalE: 22.4, cmdThrottle: 19.1,
  torqDem: 34, torqAct: 33, torqRef: 200,
};
const HELD = ['oil', 'iat', 'volt', 'stft', 'ltft', 'fuelRate'];
const PARTIAL = { ...FULL };
for (const k of HELD) PARTIAL[k] = null;

// A second full sample with different numbers, to prove the cells actually track
// the data rather than having been painted once and left.
const MOVED = { ...FULL, rpm: 3310, speed: 92, coolant: 94, load: 61.2 };

let sample = FULL, seq = 0;
// Set per target: 'bundle' serves web/dist, otherwise a single page's HTML.
let statik = null;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// web/dist the way the board serves it, lifted from shots_spa.mjs: the gzipped copy
// first, then the plain one, then index.html for anything else. Hash routes never
// reach the server, but a reload on /#/ does, and a 404 there would look like a
// broken table rather than a broken harness.
function serveDist(url, res) {
  const p = url === '/' ? '/index.html' : url;
  for (const cand of [p + '.gz', p]) {
    const f = join(dist, cand.replace(/^\//, ''));
    if (!existsSync(f)) continue;
    const ext = cand.replace(/\.gz$/, '').match(/\.[a-z]+$/)?.[0] || '';
    const head = { 'content-type': TYPES[ext] || 'application/octet-stream' };
    if (cand.endsWith('.gz')) head['content-encoding'] = 'gzip';
    res.writeHead(200, head);
    return res.end(readFileSync(f));
  }
  const idx = ['index.html.gz', 'index.html'].map(f => join(dist, f)).find(existsSync);
  const head = { 'content-type': 'text/html' };
  if (idx.endsWith('.gz')) head['content-encoding'] = 'gzip';
  res.writeHead(200, head);
  res.end(readFileSync(idx));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (url === '/data') return json({ ok: true, fw: 'test', tr: 'can', seq: ++seq,
                                     age: 40, scan: false, v: sample });
  if (url === '/history') return json({ period: 6, n: 0, rpm: [], speed: [], boost: [], coolant: [] });
  if (url.startsWith('/time')) return json({ set: true, epoch: 1755000000000 });
  if (url === '/mon') return json({ ready: true, ids: 0, recs: [] });
  if (url === '/trips/list') return json({ fs: true, used: 0, total: 1572864, trips: [] });
  if (url === '/watch/list') return json({ max: 8, period: 1000, cycle: 3000,
                                           scanning: false, dids: [], v: {} });
  if (url.startsWith('/scan/status')) return json({ running: false, cur: '0000', tried: 0,
                                                    total: 65536, negatives: 0, elapsed: 0,
                                                    stalled: false, hits: [] });
  if (url === '/ui/manifest') return json({ installed: true, bytes: 0, max: 307200,
                                            free: 1000000, files: [] });
  return statik(url, res);
});

await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// The table sits inside a collapsed <details> on both targets. Its rows are in the
// DOM either way, but open it so what is read is what a person would be looking at.
const openTable = (page) => page.evaluate(() => {
  for (const d of document.querySelectorAll('details')) {
    const s = d.querySelector('summary');
    if (s && /all values/i.test(s.textContent)) d.open = true;
  }
});

// Read the table back as plain data: one entry per row, in document order. Both
// targets render four cells - PID, name, value, unit - with the class that carries
// the dimming on the value cell.
const readTable = (page) => page.evaluate(() => {
  const details = [...document.querySelectorAll('details')]
    .find(d => /all values/i.test(d.querySelector('summary')?.textContent || ''));
  const scope = details || document;
  const body = scope.querySelector('#tbody, #tb, tbody');
  return [...(body ? body.rows : [])].map(tr => ({
    cells: [...tr.children].map(td => td.textContent),
    cls: tr.children[2] ? tr.children[2].className : null,
  }));
});

const fmt = (v, dp) => (v === null || v === undefined || Number.isNaN(v))
  ? '—' : Number(v).toFixed(dp);

/**
 * @param label   what to print
 * @param target  { kind: 'bundle' } or { kind: 'page', file, rows }
 *   `rows` for a page target is read out of the page's own global, so this file
 *   never restates a row definition it is meant to be checking.
 */
async function suite(label, target) {
  console.log(`\n${label} — all-values table`);
  sample = FULL; seq = 0;

  let path = '/';
  if (target.kind === 'bundle') {
    statik = serveDist;
    path = '/#/';
  } else {
    const html = pageSource(target.file);
    statik = (_url, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    };
  }

  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}${path}`);
  await page.waitForTimeout(800);
  await openTable(page);

  const rows = target.kind === 'bundle'
    ? BUNDLE_ROWS
    : await page.evaluate(() => ROWS);
  ok(Array.isArray(rows) && rows.length > 10, `target defines ${rows.length} rows`);
  ok(errors.length === 0,
     `the page renders without console errors${errors.length ? ` — ${errors[0]}` : ''}`);

  {
    const t = await readTable(page);
    eq(t.length, rows.length, 'one table row per definition, no more and no fewer');

    // The assertion that matters: row i shows the value of the key ROWS[i] names.
    // If the rows and the values were addressed separately and did not line up,
    // every value would appear against the wrong PID - and nothing else would notice.
    let aligned = 0, misaligned = [];
    for (let i = 0; i < rows.length; i++) {
      const [pid, , key, unit, dp] = rows[i];
      if (!t[i] || t[i].cells[0] !== pid || t[i].cells[3] !== unit) {
        misaligned.push(`row ${i}: ${t[i] ? `${t[i].cells[0]}/${t[i].cells[3]}` : 'missing'}`
                        + ` != ${pid}/${unit}`);
        continue;
      }
      if (!(key in FULL)) continue;               // derived or never sent
      if (t[i].cells[2] === fmt(FULL[key], dp)) aligned++;
      else misaligned.push(`${pid} ${key}: showed "${t[i].cells[2]}", expected "${fmt(FULL[key], dp)}"`);
    }
    ok(misaligned.length === 0,
       `every row shows its own PID's value${misaligned.length ? ` — ${misaligned[0]}` : ` (${aligned} checked)`}`);
    ok(aligned >= 15, `and that is most of the table (${aligned} rows carry a sent value)`);
    ok(t.every(r => r.cls === 'num'), 'nothing is marked stale while every batch is answering');
  }

  {
    // Drop the b2 batch. Those rows must keep showing their last reading, dimmed -
    // not blank, and not zero.
    sample = PARTIAL;
    await page.waitForTimeout(800);
    const t = await readTable(page);
    const staleKeys = [], wrong = [];
    for (let i = 0; i < rows.length; i++) {
      const [pid, , key, , dp] = rows[i];
      if (t[i].cls.includes('stale')) staleKeys.push(key);
      if (!HELD.includes(key)) continue;
      if (!t[i].cls.includes('stale')) wrong.push(`${pid} ${key} not dimmed`);
      if (t[i].cells[2] !== fmt(FULL[key], dp)) wrong.push(`${pid} ${key} lost its held value`);
    }
    ok(wrong.length === 0,
       `held rows stay dimmed and keep their reading${wrong.length ? ` — ${wrong[0]}` : ''}`);
    // Exactly the missing ones, so the class is not being sprayed across the table.
    // Rows this target does not list are not expected either way.
    const expected = HELD.filter(k => rows.some(r => r[2] === k));
    eq(staleKeys.sort().join(','), [...expected].sort().join(','),
       'and only the rows that actually went missing are dimmed');
  }

  {
    // Back to a full sample with different numbers: the class has to come off and
    // the values have to move. A table painted once and never updated passes every
    // check above but fails this one.
    sample = MOVED;
    await page.waitForTimeout(800);
    const t = await readTable(page);
    ok(t.every(r => r.cls === 'num'), 'the dimming clears once the batch answers again');
    const moved = [];
    for (let i = 0; i < rows.length; i++) {
      const [pid, , key, , dp] = rows[i];
      if (!(key in MOVED) || MOVED[key] === FULL[key]) continue;
      if (t[i].cells[2] !== fmt(MOVED[key], dp))
        moved.push(`${pid} ${key}: showed "${t[i].cells[2]}", expected "${fmt(MOVED[key], dp)}"`);
    }
    ok(moved.length === 0, `values track the data${moved.length ? ` — ${moved[0]}` : ''}`);
  }

  await ctx.close();
}

await suite('bundle (web/dist, Live page)', { kind: 'bundle' });

await browser.close();
server.close();
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

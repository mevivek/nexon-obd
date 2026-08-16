// The "All values" table, checked in a real browser.
//
// This suite exists because the node harness structurally cannot check this table.
// Its fake DOM creates any element that is asked for by id, so a table whose cells
// are built once and then addressed by id passes whether or not those ids line up
// with the rows - the entire suite goes green with the table showing every value
// against the wrong PID, or showing nothing at all. Rendering it is the only way to
// know.
//
// What that means in practice: the table is built once and its value cells updated
// in place (rather than the whole thing being rebuilt eight times a second), and
// the correspondence between ROWS[i] and the cell that displays it is now an
// assumption held only by a pair of matching id strings. That assumption is what
// is checked here.
//
// Both dashboards carry the same table (TOOLS.md: kept in sync by hand), so both
// are driven through the same states.
//
//   NODE_PATH=/opt/node22/lib/node_modules node firmware/test/test_table.mjs

import http from 'node:http';
import { pageSource, uiCss } from './pagesrc.mjs';
import { loadPlaywright } from './browser.mjs';

const pw = loadPlaywright({ soft: true });
if (!pw) {
  // Not a failure: the rest of the suite runs without a browser, and a machine
  // without Playwright should still be able to run it.
  console.log('table: skipped - playwright not installed');
  process.exit(0);
}
const { chromium } = pw;

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
};
const HELD = ['oil', 'iat', 'volt', 'stft', 'ltft', 'fuelRate'];
const PARTIAL = { ...FULL };
for (const k of HELD) PARTIAL[k] = null;

// A second full sample with different numbers, to prove the cells actually track
// the data rather than having been painted once and left.
const MOVED = { ...FULL, rpm: 3310, speed: 92, coolant: 94, load: 61.2 };

let sample = FULL, seq = 0;

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
  if (url === '/ui.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(uiCss());
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let html = '';
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// Read the table back as plain data: one entry per row, in document order.
const readTable = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#tb tr, #tbody tr')].map(tr => ({
    cells: [...tr.children].map(td => td.textContent),
    cls: tr.children[2] ? tr.children[2].className : null,
  })));

// The page's own row definitions, so adding a PID does not need this file edited.
// A top-level `const` in a classic script lands in the global lexical environment,
// which page.evaluate can see.
const readRows = (page) => page.evaluate(() => ROWS);

const fmt = (v, dp) => (v === null || v === undefined || Number.isNaN(v))
  ? '—' : Number(v).toFixed(dp);

async function suite(label, file) {
  console.log(`\n${label} — all-values table`);
  html = pageSource(file);
  sample = FULL; seq = 0;

  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.waitForTimeout(800);

  const rows = await readRows(page);
  ok(Array.isArray(rows) && rows.length > 10, `page defines ${rows.length} rows`);

  {
    const t = await readTable(page);
    eq(t.length, rows.length, 'one table row per definition, no more and no fewer');

    // The assertion that matters: row i shows the value of the key ROWS[i] names.
    // If the build-once cells were addressed by an id that did not line up, every
    // value would appear against the wrong PID - and nothing else would notice.
    let aligned = 0, misaligned = [];
    for (let i = 0; i < rows.length; i++) {
      const [pid, , key, unit, dp] = rows[i];
      if (t[i].cells[0] !== pid || t[i].cells[3] !== unit) {
        misaligned.push(`row ${i}: ${t[i].cells[0]}/${t[i].cells[3]} != ${pid}/${unit}`);
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
    eq(staleKeys.sort().join(','), [...HELD].sort().join(','),
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

await suite('firmware dashboard (dashboard_html.h)', '../NexonOBD/dashboard_html.h');
await suite('laptop dashboard (tools/dashboard.html)', '../../tools/dashboard.html');

await browser.close();
server.close();
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

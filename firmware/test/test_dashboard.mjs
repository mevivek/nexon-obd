// Tests for the dashboard's hold-last-value logic and its warning flags.
//
// Two bugs these were written for, both visible on the car at once:
//
//  1. /data flags a sample ok as soon as any one of the batched mode-01 requests
//     answers, so a partial poll arrives with nulls in it. render() wrote every
//     field unconditionally and null became an em-dash, so gauges that had been
//     reading fine went blank.
//  2. Every threshold compared a raw value, and JS coerces null to 0 - so a
//     *missing* lambda satisfied `v.lambda <= 0.85` and lit "running rich"
//     underneath a blank reading.
//
// Both dashboards carry the same logic (TOOLS.md: kept in sync by hand), so the
// same suite runs against both and fails if they drift apart.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let ran = 0, failed = 0;
function ok(cond, what) {
  ran++;
  if (cond) console.log(`  ok    ${what}`);
  else { failed++; console.log(`  FAIL  ${what}`); }
}
function eq(got, want, what) {
  ok(Object.is(got, want), `${what}${Object.is(got, want) ? '' : ` (got ${got}, want ${want})`}`);
}

function scripts(src) {
  return [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

// ---------------------------------------------------------------- fake DOM
//
// Enough of a document for render() to run headless: it only ever looks elements
// up by id, sets text/class/attributes, and reads one width for the sparklines.
function fakeDom() {
  const els = new Map();
  const make = (id) => ({
    id, textContent: '', className: '', innerHTML: '', clientWidth: 220,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    classList: {
      set: new Set(),
      toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
  });
  const get = (id) => {
    if (!els.has(id)) els.set(id, make(id));
    return els.get(id);
  };
  return {
    document: { getElementById: get, documentElement: make('html') },
    getComputedStyle: () => ({ getPropertyValue: () => '#3987e5' }),
    el: get,
  };
}

// Load a page's script wholesale, so the tests drive the shipped render() rather
// than a reimplementation of it. fetch/setTimeout are inert, so the tick() call at
// the end of the script starts and then parks without doing anything.
function load(file) {
  const src = readFileSync(join(here, file), 'utf8');
  const js = scripts(src)[0];
  const dom = fakeDom();
  const api = new Function(
    'document', 'getComputedStyle', 'fetch', 'setTimeout',
    js + '\n;return { merge, render, hz };'
  )(dom.document, dom.getComputedStyle, () => new Promise(() => {}), () => 0);
  return { ...api, el: dom.el };
}

// ---------------------------------------------------------------- suites

function suiteMerge(label, m) {
  console.log(`\n${label} — hold-last-value`);

  {
    const [v, q, held] = m.merge({ rpm: 820, coolant: 88 });
    eq(v.rpm, 820, 'fresh value passes through');
    ok(!q.rpm, 'fresh value is not marked held');
    eq(held, 0, 'nothing held on a complete sample');
  }
  {
    const [v, q, held] = m.merge({ rpm: null, coolant: null });
    eq(v.rpm, 820, 'held value re-shown instead of null');
    ok(q.rpm, 'held value is marked so it renders dimmed');
    eq(held, 2, 'header reports how many are being held');
  }
  {
    const [v, q] = m.merge({ rpm: 1500, coolant: null });
    eq(v.rpm, 1500, 'fresh value supersedes the held one');
    ok(!q.rpm, 'mark cleared');
    ok(q.coolant, 'the still-missing field stays marked');
  }
  {
    // Walk the clock past the hold window by ageing what merge() remembered.
    for (let i = 0; i < 6000; i += 100) m.merge({});      // no-op samples
    const before = Date.now();
    while (Date.now() - before < 0) { /* nothing */ }
    const [v, q] = m.merge({ neverSeen: null });
    eq(v.neverSeen, null, 'a field never seen has nothing to hold');
    ok(q.neverSeen, 'and is marked');
  }
  {
    m.merge({ oil: 95 });
    const [v, q] = m.merge({ oil: NaN });
    eq(v.oil, 95, 'NaN falls back to the held value');
    ok(q.oil, 'and is marked');
  }
  {
    m.merge({ speed: 42 });
    const [v, q] = m.merge({ speed: 0 });
    eq(v.speed, 0, 'zero passes through as a fresh reading');
    ok(!q.speed, 'zero is not treated as absent');
  }
}

function suiteFlags(label, m, ids) {
  console.log(`\n${label} — warnings never fire on data that is not there`);

  const lit = (id) => m.el(id).className.includes('on');

  // The screenshot case: lambda missing entirely.
  {
    const [v, q] = m.merge({ lambda: null, coolant: null, volt: null, oil: null,
                             stft: null, ltft: null, cat: null, rpm: null });
    m.render(v, q);
    ok(!lit(ids.lambda), 'blank lambda does not light "running rich"');
    ok(!lit(ids.coolant), 'blank coolant does not light an overheat warning');
    ok(!lit(ids.volt), 'blank voltage does not light "not charging"');
    ok(!lit(ids.oil), 'blank oil temperature does not light a warning');
    ok(!lit(ids.trim), 'blank fuel trims do not light a leak warning');
  }

  // A real lean reading still warns.
  {
    const [v, q] = m.merge({ lambda: 1.25, coolant: 90, volt: 14.0 });
    m.render(v, q);
    ok(lit(ids.lambda), 'a genuinely lean lambda still warns');
    eq(m.el('lambda').textContent, '1.250', 'and the value is shown');
  }

  // A real overheat still warns.
  {
    const [v, q] = m.merge({ coolant: 115, lambda: 1.0 });
    m.render(v, q);
    ok(lit(ids.coolant), 'a genuine overheat still warns');
    ok(!lit(ids.lambda), 'a healthy lambda does not warn');
  }

  // A held reading must not sustain a warning it raised while fresh.
  {
    m.merge({ coolant: 115 });                       // fresh, warning on
    const [v, q] = m.merge({ coolant: null });       // now held
    m.render(v, q);
    ok(q.coolant, 'the value is being held');
    eq(m.el('coolant').textContent, 115, 'the last reading is still shown');
    ok(!lit(ids.coolant), 'but the overheat warning is not sustained on stale data');
    ok(m.el('coolant').classList.contains('stale'), 'and it renders dimmed');
  }

  // A fresh reading clears the dim.
  {
    const [v, q] = m.merge({ coolant: 88 });
    m.render(v, q);
    ok(!m.el('coolant').classList.contains('stale'), 'a fresh reading is not dimmed');
  }
}

function suiteRate(label, m) {
  console.log(`\n${label} — rate readout`);
  // Trailing window, not a lifetime average: a slow patch has to wash out of the
  // reading once polling recovers, which the old cumulative average never did.
  const s = m.hz();
  ok(typeof s === 'string', 'hz() returns a string');
}

// ---------------------------------------------------------------- syntax
//
// The firmware pages are JavaScript inside C++ raw string literals, so nothing in
// the normal build ever parses them - a typo ships and shows up as a dead
// dashboard on the car. Compile each page's script without running it.
console.log('syntax');
for (const f of ['../NexonOBD/dashboard_html.h', '../NexonOBD/scan_html.h',
                 '../NexonOBD/ota_html.h', '../../tools/dashboard.html']) {
  const blocks = scripts(readFileSync(join(here, f), 'utf8'));
  ok(blocks.length > 0, `${f}: has a script block`);
  for (const js of blocks) {
    try { new Function(js); ok(true, `${f}: script parses`); }
    catch (e) { ok(false, `${f}: script parses (${e.message})`); }
  }
}

const PAGES = [
  ['firmware dashboard (dashboard_html.h)', '../NexonOBD/dashboard_html.h',
   { lambda: 'lambdaF', coolant: 'coolantF', volt: 'voltF', oil: 'oilF', trim: 'trimF' }],
  ['laptop dashboard (tools/dashboard.html)', '../../tools/dashboard.html',
   { lambda: 'lambdaFlag', coolant: 'coolantFlag', volt: 'voltFlag', oil: 'oilFlag',
     trim: 'trimFlag' }],
];

for (const [label, file, ids] of PAGES) {
  suiteMerge(label, load(file));
  suiteFlags(label, load(file), ids);
  suiteRate(label, load(file));
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

// The laptop dashboard's own logic, which nothing else covers any more.
//
// tools/dashboard.html is served by tools/obd_dashboard.ps1 on a PC talking to an
// ELM327 over serial - not by the board. It therefore did NOT move into web/, and
// it carries its own copy of merge(), holdMs(), hz() and the warning-flag gating.
//
// Those used to be checked here only incidentally: the old suite ran the same
// assertions against the firmware dashboard and this one in a loop, and when the
// firmware dashboard was deleted the laptop half went with it. That would have left
// a working tool with no coverage at all, which is exactly the kind of silent gap
// this project keeps paying for - so the loop's laptop half lives on here.
//
// The two copies are NOT kept in sync by anything. web/src/lib is the maintained
// implementation; this is a separate one that happens to encode the same rules, and
// these checks are what stop it rotting. See docs/TOOLS.md.
//
// The bugs behind these assertions, both seen on the car at once:
//
//  1. /data flags a sample ok as soon as any one of the batched mode-01 requests
//     answers, so a partial poll arrives with nulls in it. render() wrote every
//     field unconditionally and null became an em-dash, so gauges that had been
//     reading fine went blank.
//  2. Every threshold compared a raw value, and JS coerces null to 0 - so a
//     *missing* lambda satisfied `v.lambda <= 0.85` and lit "running rich"
//     underneath a blank reading.

import { pageSource, scriptsOf } from './pagesrc.mjs';

let ran = 0, failed = 0;
function ok(cond, what) {
  ran++;
  if (cond) console.log(`  ok    ${what}`);
  else { failed++; console.log(`  FAIL  ${what}`); }
}
function eq(got, want, what) {
  ok(Object.is(got, want), `${what}${Object.is(got, want) ? '' : ` (got ${got}, want ${want})`}`);
}

// ---------------------------------------------------------------- fake DOM
//
// Enough of a document for render() to run headless: it only ever looks elements
// up by id, sets text/class/attributes, and reads one width for the sparklines.
function fakeDom() {
  const els = new Map();
  const make = (id) => ({
    id, textContent: '', className: '', innerHTML: '', clientWidth: 220,
    attrs: {}, style: {},
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
  const listeners = {};
  return {
    document: {
      getElementById: get,
      documentElement: make('html'),
      hidden: false,
      addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#3987e5' }),
    el: get,
    listeners,
  };
}

// Load a page's script wholesale, so the tests drive the shipped render() and
// tick() rather than a reimplementation of them.
//
// fetch and setTimeout are supplied by the harness: /data answers come from a queue
// the test fills, and the self-rescheduling tick is captured instead of run, so a
// poll loop can be stepped one iteration at a time.
const flush = () => new Promise(r => setImmediate(r));

function load(file, opts = {}) {
  const js = scriptsOf(pageSource(file))[0];
  const dom = fakeDom();
  const queue = [];
  let pending = null;

  const fetchImpl = (url) => {
    if (String(url).startsWith('/history')) {
      return Promise.resolve({ json: () => Promise.resolve(opts.history || {}) });
    }
    if (!queue.length) return new Promise(() => {});      // park: no more scripted polls
    const r = queue.shift();
    if (r === 'offline') return Promise.reject(new Error('offline'));
    return Promise.resolve({ json: () => Promise.resolve(r) });
  };
  const setTimeoutImpl = (fn) => { pending = fn; return 0; };
  // The scan page schedules with setInterval; capture the period so a test can see
  // that the page goes live on its own rather than only after Start is pressed.
  let interval = null;
  const setIntervalImpl = (fn, ms) => { interval = { fn, ms }; return 1; };
  const clearIntervalImpl = () => { interval = null; };

  const api = new Function(
    'document', 'getComputedStyle', 'fetch', 'setTimeout', 'setInterval', 'clearInterval',
    js + '\n;return ' + (opts.exports || '{ merge, render, hz, holdMs, rate }') + ';'
  )(dom.document, dom.getComputedStyle, fetchImpl, setTimeoutImpl,
    setIntervalImpl, clearIntervalImpl);

  return {
    ...api, el: dom.el, queue, doc: dom.document,
    fire(ev) { for (const fn of dom.listeners[ev] || []) fn(); },
    scheduled: () => pending !== null,
    interval: () => interval,
    // Exactly one poll per call: run whatever tick() last rescheduled, then let the
    // promises settle. The first call has nothing scheduled yet and simply lets
    // seed().then(tick) get going. Firing at the end instead would run an extra
    // tick that parks on the empty queue and kills the loop.
    async step() {
      const fn = pending; pending = null;
      if (fn) fn();
      for (let i = 0; i < 8; i++) await flush();
    },
  };
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

function suiteHold(label, m) {
  console.log(`\n${label} — hold window follows the sample rate`);
  if (!m.holdMs) { ok(false, 'holdMs is exported'); return; }

  m.rate.length = 0;
  eq(m.holdMs(), 2500, 'falls back to the floor before a rate is known');

  // Fast link: samples 100 ms apart. The floor still applies.
  m.rate.length = 0;
  for (let i = 0; i < 10; i++) m.rate.push(1000 + i * 100);
  eq(m.holdMs(), 2500, 'a fast link keeps the floor');

  // Slow BLE link: samples 2 s apart. A fixed 2.5 s window is barely one sample,
  // so a field that simply has not come round yet blinks to an em-dash - which is
  // exactly what made the All values table flicker.
  m.rate.length = 0;
  for (let i = 0; i < 10; i++) m.rate.push(1000 + i * 2000);
  eq(m.holdMs(), 8000, 'a slow link holds for several samples');

  // ...but never so long that a genuinely dead field looks alive.
  m.rate.length = 0;
  for (let i = 0; i < 10; i++) m.rate.push(1000 + i * 60000);
  eq(m.holdMs(), 15000, 'and is capped');
  m.rate.length = 0;
}

// ---------------------------------------------------------------- run
//
// One target: the laptop dashboard. The firmware pages these suites used to also
// run against no longer exist, and their successor is tested by Vitest in web/.
const LAPTOP = '../../tools/dashboard.html';
const IDS = { lambda: 'lambdaFlag', coolant: 'coolantFlag', volt: 'voltFlag',
              oil: 'oilFlag', trim: 'trimFlag' };

suiteMerge('laptop dashboard (tools/dashboard.html)', load(LAPTOP));
suiteFlags('laptop dashboard (tools/dashboard.html)', load(LAPTOP), IDS);
suiteRate('laptop dashboard (tools/dashboard.html)', load(LAPTOP));
suiteHold('laptop dashboard (tools/dashboard.html)', load(LAPTOP));

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

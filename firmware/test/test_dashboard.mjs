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

import { pageSource, scriptsOf, fwVersion, uiCss } from './pagesrc.mjs';
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

async function suiteStatus(label, file) {
  console.log(`\n${label} — status hysteresis`);
  const m = load(file);
  const good = { ok: true, tr: 'can', v: { rpm: 800, speed: 0, coolant: 88, map: 100, baro: 100 } };
  const bad = { ok: false, error: 'no response from ECU (ignition off?)' };
  const text = () => m.el('st').textContent;

  m.queue.push(good);
  await m.step();
  eq(text(), 'live', 'a good sample reads live');

  // Four dropped polls in a row is a rough patch, not a dead ECU. This is the
  // flicker: the values are held through it, so the status must be too.
  m.queue.push(bad, bad, bad, bad);
  for (let i = 0; i < 4; i++) { await m.step(); }
  eq(text(), 'live', 'four consecutive failures do not change the status');

  m.queue.push(bad);
  await m.step();
  eq(text(), 'no response from ECU (ignition off?)', 'the fifth does');

  m.queue.push(good);
  await m.step();
  eq(text(), 'live', 'recovering clears it');

  // ...and the counter reset means it takes a fresh run of five to trip again.
  m.queue.push(bad, bad, bad, bad);
  for (let i = 0; i < 4; i++) { await m.step(); }
  eq(text(), 'live', 'the miss counter reset on success');

  // A transport failure is the same story.
  const n = load(file);
  n.queue.push(good, 'offline', 'offline');
  await n.step(); await n.step(); await n.step();
  eq(n.el('st').textContent, 'live', 'two fetch failures do not report the board unreachable');
}

async function suiteVisibility(label, file) {
  console.log(`\n${label} — polling pauses off screen`);
  const m = load(file);
  const good = { ok: true, seq: 1, tr: 'ble', v: { rpm: 800, coolant: 88 } };

  m.queue.push(good);
  await m.step();
  ok(m.scheduled(), 'a visible page keeps polling');

  // The board samples on its own now, so a backgrounded tab hammering /data buys
  // nothing and costs battery and bus time.
  m.doc.hidden = true;
  m.fire('visibilitychange');
  m.queue.push(good);
  await m.step();
  ok(!m.scheduled(), 'a hidden page stops rescheduling');

  m.doc.hidden = false;
  m.queue.push(good);
  m.fire('visibilitychange');
  for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
  ok(m.scheduled(), 'coming back on screen resumes it');
}

async function suiteScanBanner(label, file) {
  console.log(`\n${label} — scan visibility`);
  const m = load(file);

  m.queue.push({ ok: true, seq: 1, tr: 'ble', scan: false, v: { rpm: 800 } });
  await m.step();
  eq(m.el('scanBar').style.display, 'none', 'no banner when nothing is scanning');
  eq(m.el('tr').textContent, 'ble', 'the transport is shown');

  // The bug this suite exists for: progress was only emitted on the ok:true branch,
  // which is exactly the branch that cannot be taken while the scanner holds the
  // bus. The bar sat at 0 % for an entire sweep and the transport read as a dash.
  m.queue.push({ ok: false, scan: true, tr: 'ble', error: 'waiting - scanner has the bus',
                 scanPct: 12.5, scanTried: 8192, scanTotal: 65536, scanEcu: 'ECM' });
  await m.step();
  eq(m.el('scanBar').style.display, 'block', 'the banner appears on the Live page');
  eq(m.el('scanProg').style.width, '12.5%', 'progress is shown even with no live sample');
  eq(m.el('tr').textContent, 'ble', 'and the transport survives a stale sample');
  ok(m.el('scanNum').textContent.includes('8,192'),
     `counts are shown, not just a percentage (${m.el('scanNum').textContent})`);
  eq(m.el('st').textContent, 'waiting · scanning', 'status says scanning, not no-response');

  // ...and scanning must not trip the no-response hysteresis however long it runs.
  for (let i = 0; i < 8; i++) {
    m.queue.push({ ok: false, scan: true, error: 'waiting - scanner has the bus',
                   scanPct: 20, scanTried: 13107, scanTotal: 65536 });
    await m.step();
  }
  eq(m.el('st').textContent, 'waiting · scanning', 'and stays that way while it runs');

  // The board shares the bus, so live samples still arrive during a scan.
  m.queue.push({ ok: true, seq: 2, tr: 'ble', scan: true, scanPct: 21,
                 scanTried: 13800, scanTotal: 65536, v: { rpm: 900 } });
  await m.step();
  eq(m.el('st').textContent, 'live · scanning', 'a sample arriving mid-scan reads as live');
  eq(m.el('scanBar').style.display, 'block', 'and the banner stays up');
}

async function suiteSeed(label, file) {
  console.log(`\n${label} — history seeding`);
  const hist = { period: 6, n: 300, rpm: [], speed: [], boost: [], coolant: [] };
  for (let i = 0; i < 300; i++) {
    hist.rpm.push(1000 + i); hist.speed.push(i % 90);
    hist.boost.push(-0.2 + i / 1000); hist.coolant.push(70 + i / 20);
  }
  // One null in the middle, as the board emits for a slot it never filled.
  hist.speed[100] = null;

  const m = load(file, { history: hist });
  await m.step();
  const pts = (m.el('spSpeed').innerHTML.match(/points="([^"]*)"/) || [, ''])[1];
  const n = pts ? pts.trim().split(/\s+/).length : 0;
  ok(n > 200, `sparkline is seeded from the board's history (${n} points, not flat)`);
  ok(!/NaN/.test(m.el('spSpeed').innerHTML), 'nulls in the stored history do not produce NaN geometry');
  ok(/^0[,.]/.test(pts) || pts.startsWith('0,'), 'the trace starts at the left edge');
}

async function suiteScanControls() {
  console.log('\nDID scanner (scan_html.h) — controls follow the scan');
  const idle = { running: false, cur: '0000', tried: 0, total: 65536, negatives: 0,
                 elapsed: 0, hits: [], stalled: false };
  const busy = { running: true, cur: 'F1A4', tried: 420, total: 65536, negatives: 415,
                 elapsed: 37, stalled: false,
                 hits: [{ did: 'F18A', ecu: 'ECM', len: 13,
                          hex: '424F534348', ascii: 'BOSCH' }] };
  const stalled = { ...busy, stalled: true };

  const m = load('../NexonOBD/scan_html.h', { exports: '{ poll }' });

  m.queue.push(idle);
  await m.poll();
  eq(m.el('go').disabled, false, 'idle: Start is available');
  eq(m.el('go').textContent, 'Start scan', 'idle: Start reads "Start scan"');
  eq(m.el('stop').disabled, true, 'idle: Stop is not');
  eq(m.el('csv').disabled, true, 'idle: nothing to export yet');

  // Start resets position and clears the hit list on the board, and none of that is
  // persisted - so a live Start button during a sweep is one stray tap from losing
  // the whole run.
  m.queue.push(busy);
  await m.poll();
  eq(m.el('go').disabled, true, 'scanning: Start is disabled');
  ok(m.el('go').textContent.startsWith('Scanning'), 'scanning: it says so');
  eq(m.el('stop').disabled, false, 'scanning: Stop is available');
  eq(m.el('ecu').disabled, true, 'scanning: the range inputs are locked');
  eq(m.el('from').disabled, true, 'scanning: from is locked');
  eq(m.el('csv').disabled, false, 'scanning: there are hits to export');

  // The board owns the scan, so this page has to go live on its own - it may have
  // been opened mid-sweep, or the scan started from another phone.
  ok(m.interval(), 'the page schedules its own polling');
  eq(m.interval().ms, 1000, 'and polls quickly while a scan runs');

  // A stalled sweep is neither scanning nor idle - it is alive and deliberately not
  // progressing, because the ECU went quiet. Reporting "scanning" would imply it is
  // still sweeping, and "idle" would suggest it had given up.
  m.queue.push(stalled);
  await m.poll();
  eq(m.el('state').textContent, 'waiting for ECU', 'stalled reads as waiting');
  eq(m.el('stall').style.display, 'block', 'and explains itself');
  eq(m.el('go').disabled, true, 'Start stays disabled - the sweep has not ended');
  eq(m.el('stop').disabled, false, 'and Stop is still how you end it');

  m.queue.push(idle);
  await m.poll();
  eq(m.el('stall').style.display, 'none', 'the notice clears when it is not stalled');
  eq(m.el('go').disabled, false, 'finishing re-enables Start');
  eq(m.el('ecu').disabled, false, 'and unlocks the inputs');
  eq(m.interval().ms, 4000, 'and backs the polling off when idle');
}

await suiteScanControls();

// ---------------------------------------------------------------- version
//
// The version has to be legible on the phone that is doing the flashing - on
// /update most of all, where it is the only way to tell whether the last upload
// took. It was previously visible on the dashboard alone, because the rule that
// hides the subtitle lives in the shared stylesheet while the override that
// countered it had been put on one page.
console.log('\nversion stamp');
{
  const v = fwVersion();
  ok(/^\d+\.\d+\.\d+$/.test(v), `version.h holds a version (${v})`);

  for (const f of ['../NexonOBD/dashboard_html.h', '../NexonOBD/scan_html.h',
                   '../NexonOBD/ota_html.h', '../NexonOBD/mon_html.h']) {
    const html = pageSource(f);
    const name = f.split('/').pop();
    const sub = (html.match(/<span class="sub">([\s\S]*?)<\/span>/) || [, ''])[1];
    ok(sub.includes(v), `${name}: header shows v${v}`);
  }

  // The rule that hides the subtitle lives in the shared stylesheet, so that is
  // where it has to be checked - a page-level override countering it was how the
  // version came to be invisible on /scan and /update in the first place.
  const hidden = [...uiCss().matchAll(/@media\(max-width:(\d+)px\)\{\.sub\{display:none\}\}/g)]
    .map(m => Number(m[1]))
    .filter(w => w > 360);
  ok(hidden.length === 0,
     `ui.css: version stays visible at phone width${hidden.length ? ` (hidden below ${hidden}px)` : ''}`);

  // history.h cannot be compiled on the host - it needs RTC attributes and NVS - so
  // check the constants that encode the design decisions instead of nothing at all.
  const hist = readFileSync(join(here, '../NexonOBD/history.h'), 'utf8');
  const konst = (n) => {
    const m = hist.match(new RegExp(n + '\\s*=\\s*([^;]+);'));
    return m ? Function('return ' + m[1].replace(/UL|U|\b_\b/g, ''))() : NaN;
  };
  eq(konst('HIST_SLOTS') * konst('HIST_PERIOD_MS'), 3600000, 'the buffer spans exactly one hour');
  eq(konst('HIST_SLOTS') % konst('HIST_CHUNK'), 0, 'chunks divide the ring evenly');

  // The board loses power with the ignition, so RTC memory and the save on the way
  // into deep sleep both contribute nothing - this flush is the only thing that
  // keeps a trip's history, and its interval is what a power cut costs.
  ok(konst('HIST_SAVE_MS') <= konst('HIST_PERIOD_MS'),
     `history is flushed as often as it is recorded (${konst('HIST_SAVE_MS')} ms)`);

  // Flushing that often is only affordable because a flush writes the chunk that
  // moved rather than the whole ring. Rewriting all of it at this interval would
  // burn NVS endurance in a couple of years.
  const ring = konst('HIST_SLOTS') * 8, chunk = konst('HIST_CHUNK') * 8;
  ok(chunk * 8 <= ring,
     `a flush writes a small fraction of the ring (${chunk} of ${ring} bytes)`);
  // ...and each chunk still has to cover enough time that one flush rarely touches
  // two of them.
  ok(konst('HIST_CHUNK') * konst('HIST_PERIOD_MS') >= 60000,
     'a chunk spans at least a minute of data');

  // The board has no clock, so every page has to hand over the browser's time -
  // whichever one you happen to open is the only chance it gets.
  for (const f of ['../NexonOBD/dashboard_html.h', '../NexonOBD/scan_html.h',
                   '../NexonOBD/ota_html.h', '../NexonOBD/mon_html.h']) {
    const html = pageSource(f);
    ok(/fetch\('\/time\?ms='\+Date\.now\(\)/.test(html),
       `${f.split('/').pop()}: sends the browser clock to the board`);
  }

  // PSRAM is off by default on this board; the scan hit list depends on it being on.
  const build = readFileSync(join(here, '../build.sh'), 'utf8');
  ok(/PSRAM=opi/.test(build), 'build.sh asks for the board with PSRAM enabled');
  ok(/FW_VERSION/.test(build) && /NexonOBD-v\$VERSION\.bin/.test(build),
     'build.sh names the image from the same FW_VERSION');
}

// ---------------------------------------------------------------- tab switching
//
// Switching from Live to another tab felt like a page load rather than a page swap.
// Two causes, and this suite pins both fixes to the source.
//
//  1. The web server got exactly one turn per bus exchange, and an exchange on BLE
//     is up to 1.2 s. A tab switch is three requests - the document, /time, and the
//     page's first poll - so it could wait several seconds. The transports now
//     serve HTTP while they wait on the car, and the loop drains what is queued
//     instead of taking one request per turn.
//  2. All five pages inlined an identical ~7 KB stylesheet and carried no cache
//     headers, so every switch re-sent the whole document. The stylesheet is now
//     served once per build from an immutable URL, and the pages revalidate.
console.log('\ntab switching');
{
  const v = fwVersion();
  const ALL = ['../NexonOBD/dashboard_html.h', '../NexonOBD/scan_html.h',
               '../NexonOBD/ota_html.h', '../NexonOBD/mon_html.h',
               '../NexonOBD/trip_html.h'];

  for (const f of ALL) {
    const html = pageSource(f);
    const name = f.split('/').pop();
    ok(html.includes(`<link rel="stylesheet" href="/ui.css?v=${v}">`),
       `${name}: links the shared stylesheet, version-stamped`);
    // The palette only exists in ui.css. If it turns up in a page, the shared sheet
    // has been inlined again and every tab switch is re-sending it.
    ok(!html.includes('--plane:'), `${name}: does not inline the shared stylesheet`);
  }
  ok(uiCss().includes('--plane:'), 'ui.css carries the palette');

  const ino = readFileSync(join(here, '../NexonOBD/NexonOBD.ino'), 'utf8');

  // Caching. A version-stamped immutable URL means the stylesheet is fetched once
  // per build; an ETag on the pages turns a re-visit into a 304 with no body.
  ok(/server\.on\("\/ui\.css",\s*handleUiCss\)/.test(ino), 'ui.css has a route');
  ok(/max-age=31536000,\s*immutable/.test(ino), 'ui.css is served immutable');
  ok(/collectHeaders/.test(ino) && /If-None-Match/.test(ino),
     'the revalidation header is collected, or server.header() would always be empty');
  ok(/server\.send\(304,/.test(ino), 'a matching ETag answers 304');
  // Every page route has to go through sendPage, or it ships without the ETag.
  const rawPage = [...ino.matchAll(/send_P\(200,\s*"text\/html",\s*(\w*_HTML)\)/g)].map(m => m[1]);
  ok(rawPage.length === 0,
     `no page bypasses sendPage()${rawPage.length ? ` (${rawPage.join(', ')})` : ''}`);

  // Fairness. Both transports have to yield, or the fix only covers one of them.
  ok(/twai_receive\([\s\S]*?!=\s*ESP_OK\)\s*\{\s*busWaitYield/.test(ino),
     'the CAN wait loop serves HTTP while the bus is quiet');
  const elm = readFileSync(join(here, '../NexonOBD/elm_ble.h'), 'utf8');
  ok(/busWaitYield\(deadline,\s*extended\)/.test(elm),
     'the ELM327 wait loop serves HTTP while the adapter thinks');

  // Re-entering handleClient() from a handler would corrupt WebServer's single
  // current client, and starting a second bus exchange under a half-finished one
  // would interleave frames. Both guards have to exist.
  ok(/if \(g_inHandler\) return 0;/.test(ino),
     'webYield refuses to re-enter the server from inside a handler');
  ok(/if \(g_busBusy\) \{/.test(ino),
     'the one handler that touches the bus stands down while an exchange is live');

  const drain = Number((ino.match(/HTTP_DRAIN\s*=\s*(\d+)/) || [, 0])[1]);
  ok(drain >= 3, `the loop drains a whole page load per turn (${drain} requests)`);

  // handleDtc runs inside handleClient() and therefore cannot yield, so its
  // timeouts are the one place a request can still hold the board. They have to
  // clear ATST (400 ms) but stay well short of the eight seconds they once totalled.
  const dtc = ino.slice(ino.indexOf('static void handleDtc()'));
  const tmos = [...dtc.slice(0, 1200).matchAll(/TR_BLE \? (\d+) : (\d+)/g)].map(m => Number(m[1]));
  ok(tmos.length === 2, `handleDtc has both of its timeouts (${tmos.join(', ')})`);
  ok(tmos.every(t => t > 400), 'each clears the adapter\'s own ATST window');
  ok(tmos.reduce((a, b) => a + b, 0) * 2 <= 5000,
     `both ECUs, request and retry, stay under five seconds (${tmos.reduce((a, b) => a + b, 0) * 2} ms)`);
}

// ---------------------------------------------------------------- syntax
//
// The firmware pages are JavaScript inside C++ raw string literals, so nothing in
// the normal build ever parses them - a typo ships and shows up as a dead
// dashboard on the car. Compile each page's script without running it.
console.log('syntax');
for (const f of ['../NexonOBD/dashboard_html.h', '../NexonOBD/scan_html.h',
                 '../NexonOBD/ota_html.h', '../NexonOBD/mon_html.h',
                 '../../tools/dashboard.html']) {
  const blocks = scriptsOf(pageSource(f));
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
  suiteHold(label, load(file));
}

// Hysteresis and seeding are firmware-page behaviour; the laptop dashboard is
// served by a different tool and has its own polling loop.
await suiteStatus('firmware dashboard (dashboard_html.h)', '../NexonOBD/dashboard_html.h');
await suiteVisibility('firmware dashboard (dashboard_html.h)', '../NexonOBD/dashboard_html.h');
await suiteScanBanner('firmware dashboard (dashboard_html.h)', '../NexonOBD/dashboard_html.h');
await suiteSeed('firmware dashboard (dashboard_html.h)', '../NexonOBD/dashboard_html.h');

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

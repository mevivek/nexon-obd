// Render the served pages headless and screenshot them, so a UI change can be
// looked at without flashing the board and sitting in the car.
//
// The pages are PROGMEM string literals inside .h files; this pulls the HTML back
// out, serves it alongside a mock /data, and drives the real polling loop. The
// partial-poll scenario is the one worth staring at - it is the state that used to
// blank the dashboard, and now shows dimmed held values instead.
//
//   NODE_PATH=/opt/node22/lib/node_modules node firmware/test/shots.mjs [outdir]

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { pageSource, uiCss } from './pagesrc.mjs';
import { loadPlaywright } from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { chromium } = loadPlaywright();

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, 'shots');
mkdirSync(outDir, { recursive: true });


// A full sample, mid-drive.
const CRUISING = {
  rpm: 2150, speed: 58, map: 92, baro: 100, throttle: 18.4, load: 34.5,
  coolant: 89, oil: 96, iat: 34, ambient: 34, volt: 14.32, stft: 2.3,
  ltft: -1.6, lambda: 0.998, cat: 642.5, timing: 18.5, fuelRate: 4.85,
  fuel: 100, runtime: 1284,
  // Accumulated by the board over the drive, not sampled: 23.6 km on 1.66 L.
  tripKm: 23.62, tripL: 1.661,
};

const SCENARIOS = {
  // Everything answering.
  cruising: CRUISING,
  // The b2 batch timed out: oil, iat, volt, both trims and fuel rate are missing.
  // Those gauges should hold their last reading, dimmed, not blank.
  'partial-poll': { ...CRUISING, oil: null, iat: null, volt: null, stft: null,
                    ltft: null, fuelRate: null },
  // Genuine warnings, so the alert styling is visible.
  overheating: { ...CRUISING, coolant: 116, oil: 128, lambda: 1.21, cat: 915,
                 rpm: 5720, volt: 11.9 },
  // Ignition off / nothing ever received.
  'no-data': Object.fromEntries(Object.keys(CRUISING).map(k => [k, null])),
  // A DID sweep has the bus; live values are paused, and the Live page has to say so.
  scanning: CRUISING,
};

const PAGES = [
  ['dashboard', '../NexonOBD/dashboard_html.h'],
  ['scan', '../NexonOBD/scan_html.h'],
  ['update', '../NexonOBD/ota_html.h'],
  ['monitors', '../NexonOBD/mon_html.h'],
  ['trips', '../NexonOBD/trip_html.h'],
  ['watch', '../NexonOBD/watch_html.h'],
];

const WIDTHS = [[390, 'phone'], [768, 'tablet']];

let sample = CRUISING;
let ok = true;
let scanning = false;
let seq = 0;

const html = Object.fromEntries(PAGES.map(([name, f]) => [name, pageSource(f)]));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // The pages link the shared stylesheet rather than inlining it, so the shots are
  // only representative if this route works - an unstyled screenshot would be a
  // very loud failure, but a silent 404 here would look like a CSS regression.
  if (url === '/ui.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(uiCss());
  }
  if (url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (scanning) {
      // The board keeps sampling slowly during a scan, so the shot shows the state
      // that actually persists: live values present, banner up, progress moving.
      return res.end(JSON.stringify({ ok: true, fw: 'test', tr: 'ble', seq: ++seq,
        age: 1800, scan: true, scanPct: 12.5, scanTried: 8192, scanTotal: 65536,
        scanEcu: 'ECM', v: sample }));
    }
    return res.end(JSON.stringify(ok
      ? { ok: true, fw: 'test', tr: 'can', seq: ++seq, age: 40, scan: false, v: sample }
      : { ok: false, scan: false, error: 'no response from ECU (ignition off?)' }));
  }
  if (url === '/history') {
    // Stands in for the board's stored hour, so the shots show charts with the
    // shape they have on a page that has only just loaded.
    const n = 600, h = { period: 6, n, rpm: [], speed: [], boost: [], coolant: [] };
    for (let i = 0; i < n; i++) {
      const t = i / n;
      h.rpm.push(Math.round(1500 + 850 * Math.sin(t * 7.1) + 260 * Math.sin(t * 23)));
      h.speed.push(Math.round(36 + 22 * Math.sin(t * 4.3) + 5 * Math.sin(t * 17)));
      h.boost.push(+(-0.22 + 0.48 * Math.sin(t * 6.4) + 0.07 * Math.sin(t * 19)).toFixed(2));
      h.coolant.push(Math.round(74 + 15 * t + 1.2 * Math.sin(t * 9)));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(h));
  }
  if (url.startsWith('/time')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ set: true, epoch: 1755000000000 }));
  }
  if (url === '/trips/list') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ fs: true, used: 486539, total: 1572864,
      live: '/t0007.csv', trips: [
        { name: '/t0007.csv', size: 128400 },
        { name: '/t0006.csv', size: 291733 },
        { name: '/t0005.csv', size: 66406 },
      ] }));
  }
  if (url === '/mon') {
    // Two O2 monitors, which is what this car's support mask implies: one comfortably
    // inside its window, one close enough to a limit to be worth seeing.
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ready: true, ids: 2, recs: [
      { mid: '01', tid: '01', uas: '0B', v: 560, lo: 200, hi: 900 },
      { mid: '01', tid: '02', uas: '0B', v: 143, lo: 120, hi: 700 },
      { mid: '02', tid: '01', uas: '03', v: 4100, lo: 1000, hi: 8000 },
      { mid: '02', tid: '81', uas: '01', v: 12, lo: 0, hi: 40 },
    ] }));
  }
  if (url === '/watch/list') {
    // Three identifiers from the 10xx block the sweep turned up, in the states that
    // matter: answering, answering with a single byte, and gone quiet.
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ max: 8, period: 1000, cycle: 3000, scanning: false,
      dids: [
        { name: 'E1002', did: '1002', ecu: 'ECM', len: 2, fresh: true,
          val: 5455 + (seq % 40), hex: '154F', age: 320 },
        { name: 'E1000', did: '1000', ecu: 'ECM', len: 1, fresh: true,
          val: 145, hex: '91', age: 1180 },
        { name: 'T0140', did: '0140', ecu: 'TCM', len: 2, fresh: false,
          val: 4200, hex: '1068', age: 21400 },
      ],
      v: { rpm: 2150, speed: 58, coolant: 89, iat: 34, load: 34.5, throttle: 18.4 } }));
  }
  if (url === '/watch/set') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, n: 3, period: 1000, changed: true }));
  }
  if (url === '/dtc') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ecus: [{ name: 'ECM', codes: [] }, { name: 'TCM', codes: [] }] }));
  }
  if (url.startsWith('/scan/status')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      running: true, ecu: 'ECM', cur: 'F1A4', tried: 420, total: 65536,
      negatives: 415, elapsed: 37,
      hits: [
        { did: 'F18A', ecu: 'ECM', len: 13, hex: '424F534348204C494D49544544', ascii: 'BOSCH LIMITED' },
        { did: 'F190', ecu: 'ECM', len: 17, hex: '4D4154313233343536373839303132333435', ascii: 'MAT12345678901234' },
        { did: 'F197', ecu: 'ECM', len: 8, hex: '4D45443137392E33', ascii: 'MED179.3' },
      ],
    }));
  }
  const page = url === '/' ? 'dashboard' : url.replace(/^\//, '').replace(/\/$/, '');
  if (html[page]) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html[page]);
  }
  res.writeHead(404).end('nope');
});

await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const shots = [];

for (const [width, wname] of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 },
                                         deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  for (const [sname, s] of Object.entries(SCENARIOS)) {
    // Warm up on a full sample first, so the hold-last-value path has something to
    // hold - a cold page would just show em-dashes.
    ok = true; scanning = false; sample = CRUISING;
    await page.goto(`${base}/`);
    await page.waitForTimeout(700);

    if (sname === 'no-data') ok = false;
    else if (sname === 'scanning') scanning = true;
    else sample = s;
    // The status only flips after five consecutive failures, so the no-data shot
    // needs longer than one poll interval to actually reach that state.
    await page.waitForTimeout(sname === 'no-data' ? 1600 : 700);

    const f = join(outDir, `dashboard-${wname}-${sname}.png`);
    await page.screenshot({ path: f, fullPage: true });
    shots.push(f);
  }

  ok = true; scanning = false; sample = CRUISING;
  for (const p of ['scan', 'update', 'monitors', 'trips', 'watch']) {
    await page.goto(`${base}/${p}`);
    await page.waitForTimeout(500);
    const f = join(outDir, `${p}-${wname}.png`);
    await page.screenshot({ path: f, fullPage: true });
    shots.push(f);
  }

  await ctx.close();
}

await browser.close();
server.close();
console.log(shots.join('\n'));

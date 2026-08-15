// Render the served pages headless and screenshot them, so a UI change can be
// looked at without flashing the board and sitting in the car.
//
// The pages are PROGMEM string literals inside .h files; this pulls the HTML back
// out, serves it alongside a mock /data, and drives the real polling loop. The
// partial-poll scenario is the one worth staring at - it is the state that used to
// blank the dashboard, and now shows dimmed held values instead.
//
//   NODE_PATH=/opt/node22/lib/node_modules node firmware/test/shots.mjs [outdir]

import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { pageSource } from './pagesrc.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ESM resolution ignores NODE_PATH, and playwright is usually installed globally
// rather than into this repo. createRequire does honour it, so fall back to the
// well-known global location when a bare specifier does not resolve.
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright',
                      '/usr/lib/node_modules/playwright']) {
    try { return require(spec); } catch { /* try the next one */ }
  }
  console.error('playwright not found - npm i -g playwright, or set NODE_PATH');
  process.exit(1);
}
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
];

const WIDTHS = [[390, 'phone'], [768, 'tablet']];

let sample = CRUISING;
let ok = true;
let scanning = false;
let seq = 0;

const html = Object.fromEntries(PAGES.map(([name, f]) => [name, pageSource(f)]));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (scanning) {
      return res.end(JSON.stringify({ ok: false, scan: true,
                                      error: 'paused - DID scan running' }));
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
  for (const p of ['scan', 'update']) {
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

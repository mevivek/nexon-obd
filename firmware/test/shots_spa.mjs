// Screenshot the built frontend bundle, the same way shots.mjs screenshots the
// firmware's own pages.
//
// This is the check that the port did not drift. The unit tests cover the
// arithmetic behind each page; nothing covers whether the rendered page still looks
// like the one that was iterated on in a moving car. Running both harnesses against
// the same mock data puts the two side by side.
//
// Serves web/dist exactly as the board does - gzipped assets with Content-Encoding,
// unknown paths falling back to index.html - so what is photographed is what the
// firmware will hand out.
//
//   npm --prefix web run build
//   NODE_PATH=/opt/node22/lib/node_modules node firmware/test/shots_spa.mjs [outdir]

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPlaywright } from './browser.mjs';

const { chromium } = loadPlaywright();
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../../web/dist');
const outDir = process.argv[2] || join(here, 'shots-spa');
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(dist, 'index.html'))) {
  console.error('no build found - run: npm --prefix web run build');
  process.exit(1);
}

// Same sample the firmware-page harness uses, so the two sets are comparable.
const CRUISING = {
  rpm: 2150, speed: 58, map: 92, baro: 100, throttle: 18.4, load: 34.5,
  coolant: 89, oil: 96, iat: 34, ambient: 34, volt: 14.32, stft: 2.3,
  ltft: -1.6, lambda: 0.998, cat: 642.5, timing: 18.5, fuelRate: 4.85,
  fuel: 100, runtime: 1284, absLoad: 41.2, pedalD: 22.7, pedalE: 22.4,
  cmdThrottle: 19.1, torqDem: 34, torqAct: 33, torqRef: 200,
  tripKm: 23.62, tripL: 1.661,
};
// The b2 batch timed out: those gauges must hold their last reading, dimmed.
const PARTIAL = { ...CRUISING, oil: null, iat: null, volt: null, stft: null,
                  ltft: null, fuelRate: null };

let sample = CRUISING, ok = true, scanning = false, seq = 0;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };

  if (url === '/data') {
    if (scanning) {
      return json({ ok: true, fw: '1.10.1', tr: 'ble', seq: ++seq, age: 1800,
        scan: true, scanPct: 12.5, scanTried: 8192, scanTotal: 65536,
        scanEcu: 'ECM', v: sample });
    }
    return json(ok
      ? { ok: true, fw: '1.10.1', tr: 'can', seq: ++seq, age: 40, scan: false, v: sample }
      : { ok: false, fw: '1.10.1', tr: 'can', scan: false,
          error: 'no response from ECU (ignition off?)' });
  }
  if (url === '/history') {
    const n = 600, h = { period: 6, n, rpm: [], speed: [], boost: [], coolant: [] };
    for (let i = 0; i < n; i++) {
      const t = i / n;
      h.rpm.push(Math.round(1500 + 850 * Math.sin(t * 7.1) + 260 * Math.sin(t * 23)));
      h.speed.push(Math.round(36 + 22 * Math.sin(t * 4.3) + 5 * Math.sin(t * 17)));
      h.boost.push(+(-0.22 + 0.48 * Math.sin(t * 6.4)).toFixed(2));
      h.coolant.push(Math.round(74 + 15 * t));
    }
    return json(h);
  }
  if (url.startsWith('/time')) return json({ set: true, epoch: 1755000000000 });
  if (url === '/mon') {
    return json({ ready: true, ids: 2, recs: [
      { mid: '01', tid: '01', uas: '0B', v: 560, lo: 200, hi: 900 },
      { mid: '01', tid: '02', uas: '0B', v: 143, lo: 120, hi: 700 },
      { mid: '21', tid: '01', uas: '03', v: 4100, lo: 1000, hi: 8000 },
    ] });
  }
  if (url === '/trips/list') {
    return json({ fs: true, used: 486539, total: 1572864, live: '/t0007.csv',
      trips: [{ name: '/t0007.csv', size: 128400 },
              { name: '/t0006.csv', size: 291733 },
              { name: '/t0005.csv', size: 66406 }] });
  }
  if (url.startsWith('/scan/status')) {
    return json({ running: true, ecu: 'ECM', cur: '233F', tried: 9023, total: 65536,
      negatives: 1, elapsed: 1513, stalled: false, cap: 4000, hits: [
        { did: '1000', ecu: 'ECM', len: 1, hex: '91', ascii: '.' },
        { did: '1002', ecu: 'ECM', len: 2, hex: '154F', ascii: '.O' },
        { did: 'F18A', ecu: 'ECM', len: 13,
          hex: '424F534348204C494D49544544', ascii: 'BOSCH LIMITED' },
      ] });
  }
  if (url === '/watch/list') {
    return json({ max: 8, period: 1000, cycle: 3000, scanning: false, dids: [
      { name: 'E1002', did: '1002', ecu: 'ECM', len: 2, fresh: true,
        val: 5455 + (seq % 40), hex: '154F', age: 320 },
      { name: 'E1000', did: '1000', ecu: 'ECM', len: 1, fresh: true,
        val: 145, hex: '91', age: 1180 },
      { name: 'T0140', did: '0140', ecu: 'TCM', len: 2, fresh: false,
        val: 4200, hex: '1068', age: 21400 },
    ], v: { rpm: 2150, speed: 58, coolant: 89, iat: 34, load: 34.5, throttle: 18.4 } });
  }
  if (url === '/ui/manifest') {
    return json({ installed: true, bytes: 14200, max: 307200, free: 1000000,
      files: [{ name: 'index.html.gz', size: 260 }, { name: 'app.js.gz', size: 11800 },
              { name: 'app.css.gz', size: 2140 }] });
  }

  // Static, the way the board serves it: gzipped copy first, then the SPA fallback.
  let p = url === '/' ? '/index.html' : url;
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
  if (idx) {
    const head = { 'content-type': 'text/html' };
    if (idx.endsWith('.gz')) head['content-encoding'] = 'gzip';
    res.writeHead(200, head);
    return res.end(readFileSync(idx));
  }
  res.writeHead(404).end('nope');
});

await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const shots = [];

// Route, hash, and the state to put the mock in first.
const VIEWS = [
  ['live', '#/', () => { ok = true; scanning = false; sample = CRUISING; }],
  ['live-partial', '#/', () => { ok = true; scanning = false; sample = PARTIAL; }],
  ['live-scanning', '#/', () => { ok = true; scanning = true; sample = CRUISING; }],
  ['live-nodata', '#/', () => { ok = false; scanning = false; }],
  ['monitors', '#/monitors', () => { ok = true; scanning = false; sample = CRUISING; }],
  ['trips', '#/trips', () => {}],
  ['watch', '#/watch', () => {}],
  ['scanner', '#/scan', () => {}],
  ['firmware', '#/update', () => {}],
];

for (const [width, wname] of [[390, 'phone'], [768, 'tablet']]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 },
                                         deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  for (const [name, hash, setup] of VIEWS) {
    setup();
    await page.goto(`${base}/${hash}`);
    // no-data has to miss five polls before it admits the ECU is gone.
    await page.waitForTimeout(name === 'live-nodata' ? 1800 : 900);
    const f = join(outDir, `${name}-${wname}.png`);
    await page.screenshot({ path: f, fullPage: true });
    shots.push(f);
  }

  if (errors.length) {
    console.error(`\nconsole errors at ${wname}:`);
    for (const e of [...new Set(errors)]) console.error('  ' + e);
    process.exitCode = 1;
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(shots.join('\n'));

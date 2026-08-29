// Render the pages still built into the firmware and screenshot them, so a UI change
// can be looked at without flashing the board and sitting in the car.
//
// THIS FILE COVERS THE FLASH PAGES ONLY. The dashboard, scanner, monitors, trips and
// watch pages moved into the Vite/Preact bundle under web/, and their screenshots -
// including the cruising, partial-poll, overheating, no-data and scanning states that
// used to live here - are taken by shots_spa.mjs, which serves web/dist the way the
// board does. Run both to see the whole UI.
//
// What is left is the three pages that must work when the bundle does not:
//
//   boot_html.h   /        the fallback served when no bundle is installed
//   ota_html.h    /update  OTA flashing, the recovery path of last resort
//   ui_html.h     /ui      bundle management
//
// The pages are PROGMEM string literals inside .h files; this pulls the HTML back
// out, serves it alongside the handful of endpoints they actually call, and drives
// their real polling loops.
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

// A full sample, mid-drive. The boot page shows four of these and nothing else - it
// is deliberately not the dashboard, and the shot is here to confirm that it reads
// like a working device rather than a stub.
const CRUISING = {
  rpm: 2150, speed: 58, map: 92, baro: 100, throttle: 18.4, load: 34.5,
  coolant: 89, oil: 96, iat: 34, ambient: 34, volt: 14.32, stft: 2.3,
  ltft: -1.6, lambda: 0.998, cat: 642.5, timing: 18.5, fuelRate: 4.85,
  fuel: 100, runtime: 1284, tripKm: 23.62, tripL: 1.661,
};

// url path -> page source. '/' is the boot fallback, as on the board.
const PAGES = [
  ['boot', '/', '../Obdurate/boot_html.h'],
  ['update', '/update', '../Obdurate/ota_html.h'],
  ['ui', '/ui', '../Obdurate/ui_html.h'],
];

const WIDTHS = [[390, 'phone'], [768, 'tablet']];

let ok = true;
let seq = 0;
// The /ui page is worth seeing in both of its states: a board with a bundle on it,
// and a board that has none and is therefore serving these pages for real.
let installed = true;

const html = Object.fromEntries(PAGES.map(([name, , f]) => [name, pageSource(f)]));
const byPath = Object.fromEntries(PAGES.map(([name, path]) => [path, name]));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  // The pages link the shared stylesheet rather than inlining it, so the shots are
  // only representative if this route works - an unstyled screenshot would be a
  // very loud failure, but a silent 404 here would look like a CSS regression.
  if (url === '/ui.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(uiCss());
  }
  if (url === '/data') {
    return json(ok
      ? { ok: true, fw: 'test', tr: 'can', seq: ++seq, age: 40, scan: false, v: CRUISING }
      : { ok: false, scan: false, error: 'no response from ECU (ignition off?)' });
  }
  if (url.startsWith('/time')) return json({ set: true, epoch: 1755000000000 });
  if (url === '/ui/manifest') {
    return json(installed
      ? { installed: true, bytes: 21600, max: 307200, free: 1000000,
          files: [{ name: 'index.html.gz', size: 260 },
                  { name: 'app.js.gz', size: 19200 },
                  { name: 'app.css.gz', size: 2140 }] }
      : { installed: false, bytes: 0, max: 307200, free: 1000000, files: [] });
  }
  const page = byPath[url];
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

// name, url, and the state to put the mock in first.
const VIEWS = [
  ['boot', '/', () => { ok = true; }],
  // The state the fallback exists for: no bundle, and nothing answering on the bus
  // either. It has to say so rather than sit blank. Five misses before it admits it.
  ['boot-nodata', '/', () => { ok = false; }],
  ['update', '/update', () => {}],
  ['ui', '/ui', () => { installed = true; }],
  ['ui-empty', '/ui', () => { installed = false; }],
];

for (const [width, wname] of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 },
                                         deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  for (const [name, url, setup] of VIEWS) {
    setup();
    await page.goto(`${base}${url}`);
    // The boot page only flips its status after five consecutive failures, so the
    // no-data shot needs longer than one poll interval to reach that state.
    await page.waitForTimeout(name === 'boot-nodata' ? 3200 : 700);

    const f = join(outDir, `${name}-${wname}.png`);
    await page.screenshot({ path: f, fullPage: true });
    shots.push(f);
  }

  await ctx.close();
}

await browser.close();
server.close();
console.log(shots.join('\n'));

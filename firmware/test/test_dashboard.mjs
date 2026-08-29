// Host-side checks on the firmware, everything that can be asserted without a board.
//
// This file used to be two things at once: a browser-behaviour suite for the five
// dashboard pages the board carried in flash, and a set of source assertions about
// the sketch. The frontend has moved out to web/ - a Vite/Preact bundle served off
// LittleFS - and with it went the pages and the browser half of this file. The
// hold-last-value merge, the warning-flag gating, the status hysteresis, the
// sparkline seeding, the mileage readouts and the scanner controls are now covered
// by Vitest in web/src/lib and web/src/pages, against the modules that implement
// them rather than against JavaScript scraped out of a C++ raw string literal.
//
// What is left here is the part Vitest structurally cannot see: the firmware source.
// Three pages stay in flash, and they stay precisely because they must work when the
// bundle does not - boot_html.h (/), ota_html.h (/update) and ui_html.h (/ui). Those
// are checked here, along with the /data contract the bundle reads, the routing and
// HTTP-fairness work, the DID watch wiring, the trip totals and the history ring.

import { pageSource, scriptsOf, fwVersion, uiCss } from './pagesrc.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Firmware source is read as text and sliced with indexOf('\n}\n') to find where a
// function ends. The blob in git is LF, but a Windows checkout with core.autocrlf
// on has a CRLF working tree, where that marker never matches: indexOf returns -1
// and slice(0, -1) does not fail, it quietly hands back the whole rest of the file.
// A check meant for one function then reads the entire sketch - which is how the
// /data contract test came to see six fields from handleWatchList() and call them
// duplicates of handleData()'s. Read source with the endings the checks assume.
const readSrc = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// Every page still built into flash, in one list, because these checks had already
// drifted apart once: the trips page was added in 1.7.0 and three of the four loops
// below never picked it up. A page missing from here is caught by the first test in
// the tab-switching suite, which compares this against what is on disk.
//
// These three are the ones that must not depend on the bundle: / is the fallback
// when no bundle is installed, /update is the recovery path of last resort, and /ui
// is how a bundle gets installed in the first place. /monitors, /trips, /watch and
// /scan are 302s into the bundle's hash routes and have no page of their own.
const FW_PAGES = ['../NexonOBD/boot_html.h', '../NexonOBD/ota_html.h',
                  '../NexonOBD/ui_html.h'];

let ran = 0, failed = 0;
function ok(cond, what) {
  ran++;
  if (cond) console.log(`  ok    ${what}`);
  else { failed++; console.log(`  FAIL  ${what}`); }
}
function eq(got, want, what) {
  ok(Object.is(got, want), `${what}${Object.is(got, want) ? '' : ` (got ${got}, want ${want})`}`);
}

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

  for (const f of FW_PAGES) {
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
  const hist = readSrc(join(here, '../NexonOBD/history.h'));
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
  for (const f of FW_PAGES) {
    const html = pageSource(f);
    ok(/fetch\('\/time\?ms='\+Date\.now\(\)/.test(html),
       `${f.split('/').pop()}: sends the browser clock to the board`);
  }

  // PSRAM is off by default on this board; the scan hit list depends on it being on.
  const build = readSrc(join(here, '../build.sh'));
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
  const ALL = FW_PAGES;

  // A page added to the firmware but not to FW_PAGES would silently skip every
  // check in this file. Compare the list against what is actually on disk.
  const onDisk = readdirSync(join(here, '../NexonOBD'))
    .filter(n => n.endsWith('_html.h')).sort();
  const listed = ALL.map(f => f.split('/').pop()).sort();
  ok(onDisk.join() === listed.join(),
     `FW_PAGES covers every served page${onDisk.join() === listed.join() ? ''
       : ` (on disk: ${onDisk.join(', ')})`}`);

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

  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));

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
  const elm = readSrc(join(here, '../NexonOBD/elm_ble.h'));
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

// ---------------------------------------------------------------- DID watch
//
// The sweep finds identifiers that answer; it cannot say what they hold. The watch
// reads a chosen few continuously and records them beside the live PIDs so they can
// be identified by correlation. The decoding and the CSV column pairing are covered
// properly in the C++ suite, which compiles didwatch.h directly; what is left here
// is the wiring - the parts that only exist as source and would fail silently.
//
// The page itself is now the bundle's #/watch route, and its behaviour is covered by
// Vitest in web/src/pages/watch. Everything below is firmware-side.
console.log('\nDID watch');
{
  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));
  const trip = readSrc(join(here, '../NexonOBD/triplog.h'));

  ok(/server\.on\("\/watch\/list",/.test(ino) && /server\.on\("\/watch\/set",/.test(ino),
     'the watch endpoints are routed');
  // /watch no longer serves a page, but it is a bookmark and it is what the nav on
  // the flash pages points at, so it has to land somewhere rather than 404.
  ok(/\{"\/monitors",\s*"\/trips",\s*"\/watch",\s*"\/scan"\}/.test(ino)
     && /server\.send\(302,/.test(ino),
     '/watch redirects into the bundle rather than 404ing');
  ok(/watchStep\(\);/.test(ino), 'the poller runs in loop()');

  // A sweep is already hours long and shares the bus with the sampler; a third
  // claimant would do both jobs badly, so the watch stands down while one runs.
  ok(/if \(!watchN \|\| scan\.running\) return;/.test(ino),
     'watching pauses while a sweep has the bus');

  // Filing bytes under the wrong identifier would poison a correlation without ever
  // looking wrong, which is the worst way for this to fail.
  ok(/!= w\.did\) return;/.test(ino), 'a reply about a different identifier is discarded');
  ok(/buf\[0\] != 0x62/.test(ino), 'only a positive ReadDataByIdentifier reply is filed');

  // Service 0x22 is a read. Only the identifier varies here, never the service, so
  // the read-only guarantee in the README still holds for a runtime-chosen request.
  ok(/uint8_t req\[3\] = \{0x22,/.test(ino), 'the watch only ever sends service 0x22');

  // The CSV gains a column pair per watched identifier. Both the header and the row
  // must walk the same list through the same helpers, or columns shift under rows.
  ok(/watchColNames\(watch\[i\], names, WATCH_COLS_PER_DID\)/.test(trip),
     'the CSV header is built from the watch set');
  ok(/watchColCells\(watch\[i\], now, cells, WATCH_COLS_PER_DID\)/.test(trip),
     'and the rows are built by its counterpart');
  ok(/tripWatchGen != watchGen/.test(trip),
     'a changed watch set rotates the file rather than shifting its columns');

  // Readings are restored as choices, not values - the set is loaded before the
  // trip log opens, or the first file of a drive would miss its watch columns.
  ok(ino.indexOf('watchLoad();') < ino.indexOf('tripBegin();'),
     'the watch set is loaded before the first trip file is opened');

  // The browser can load a did_hits.csv exported by an older build back into the
  // picker, and that file never leaves the phone - which is only true while the
  // firmware has no route that would accept one. The parsing is checked in
  // web/src/pages/watch; the absence of an upload endpoint can only be checked here.
  ok(!/\/scan\/hits\/(set|import|upload)/.test(ino),
     'no endpoint was added that would make the browser a second source of hits');
}

// ---------------------------------------------------------------- trip columns
console.log('\ntrip totals');
{
  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));
  const trip = readSrc(join(here, '../NexonOBD/triplog.h'));
  const types = readSrc(join(here, '../NexonOBD/obd_types.h'));

  ok(/float tripKm = NAN, tripL = NAN;/.test(types),
     'the totals ride on Live, so /data and the CSV both get them for free');
  ok(/\{"trip_km",\s+&Live::tripKm/.test(trip) && /\{"trip_l",\s+&Live::tripL/.test(trip),
     'and appear as CSV columns through the same table as every other column');
  ok(/jsonNum\(s, "tripKm"/.test(ino) && /jsonNum\(s, "tripL"/.test(ino),
     'and in /data');

  // The integration must see the merged, staleness-checked sample - not the raw
  // batch - or a held fuel rate would be integrated as though it had just arrived.
  ok(/if \(any\) tripIntegrate\(pub\.speed, pub\.fuelRate, millis\(\)\);/.test(ino),
     'integration runs on the published sample, after staleness has been applied');

  // A power cut ends a drive; a deep-sleep wake does not. On the permanently live
  // pin 16 the board wakes through setup() every SLEEP_WAKE_US, so plain statics
  // reset the drive's totals mid-drive - and the mileage tile, the "right now"
  // figure and the trip_km/trip_l columns all read from them.
  ok(/RTC_DATA_ATTR static float\s+g_tripKm;/.test(ino) &&
     /RTC_DATA_ATTR static float\s+g_tripL;/.test(ino),
     'the totals survive a deep-sleep wake');
  ok(/RTC_DATA_ATTR static uint32_t tripIntMagic;/.test(ino) &&
     /tripIntMagic == TRIPINT_MAGIC/.test(ino),
     'guarded by a magic, because RTC memory is garbage on a cold boot');
  ok(/tripIntBegin\(\);/.test(ino.slice(ino.indexOf('void setup()'))),
     'and are initialised from setup(), before tripBegin opens a file');

  // Deliberately NOT in RTC memory: it is the timestamp the next interval is
  // measured from, and a sleep is exactly the gap TRIP_INT_MAX_MS refuses to
  // integrate across. Carrying it over would close an interval spanning the sleep.
  ok(/\nstatic uint32_t tripIntAt = 0;/.test(ino),
     'but the interval clock is not, so a wake starts a fresh interval');
}

// ---------------------------------------------------------------- read-only
//
// The README's safety section promises this firmware never sends a service that
// writes ECU memory, moves an actuator, resets a module or changes session state.
// Until now that promise was a paragraph. It is the strongest claim the project
// makes - it is what makes leaving the board plugged into a car defensible - and a
// paragraph is not what a claim like that should rest on.
//
// So the service byte of every request handed to a transport is collected from the
// source and checked against the list of reads. The day someone adds 0x2E to try a
// coding feature, this fails and names it.
console.log('\nread-only, structurally');
{
  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));

  // Reads, and only reads. 0x22 is ReadDataByIdentifier, which the ECUs on this car
  // answer in the default session with no security access - it is still a read.
  const READS = new Set(['0x01', '0x02', '0x03', '0x06', '0x07', '0x09', '0x0A', '0x22']);
  // The five the README names, plus the transfer services. Listed rather than
  // inferred so the failure message can say what was attempted.
  const WRITES = {
    '0x10': 'DiagnosticSessionControl', '0x11': 'ECUReset',
    '0x14': 'ClearDiagnosticInformation', '0x27': 'SecurityAccess',
    '0x2E': 'WriteDataByIdentifier', '0x31': 'RoutineControl',
    '0x34': 'RequestDownload', '0x36': 'TransferData',
  };

  // The payload is the third argument, so the names of every request buffer in the
  // firmware come from the call sites rather than from a naming convention.
  const calls = [...ino.matchAll(/\b(?:obd|can|ble)IsoTp\(\s*[^,]+,\s*[^,]+,\s*(\w+)\s*,/g)]
    .map(m => m[1]);
  // obdIsoTp forwards its own parameter to the two transports; those two calls carry
  // no service byte of their own and are not request sites. Anything declared as a
  // pointer parameter is a forward, not a buffer.
  const isParam = (nm) => new RegExp(`const uint8_t \\*${nm}\\b`).test(ino);
  const sites = calls.filter(nm => !isParam(nm));
  const names = [...new Set(sites)];
  ok(sites.length >= 8 && names.length >= 3,
     `found the request buffers from their call sites (${sites.length} sites, ${names.join(', ')})`);
  ok(calls.length - sites.length === 2,
     'the only unresolved payloads are the dispatcher forwarding to its two transports');

  let checked = 0;
  for (const nm of names) {
    // Both shapes the firmware uses: an initialiser, and a declaration whose first
    // byte is assigned separately (the mode 01 batch builds its PID list at runtime).
    const bytes = [
      ...[...ino.matchAll(new RegExp(`\\buint8_t\\s+${nm}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{\\s*(0x[0-9A-Fa-f]{2})`, 'g'))],
      ...[...ino.matchAll(new RegExp(`\\b${nm}\\[0\\]\\s*=\\s*(0x[0-9A-Fa-f]{2})\\s*;`, 'g'))],
    ].map(m => m[1].toUpperCase().replace('0X', '0x'));

    // An unresolved buffer must fail rather than pass by finding nothing to object
    // to - that is the difference between this check and a decoration.
    ok(bytes.length > 0, `${nm}: its service byte is visible in the source`);
    for (const b of bytes) {
      checked++;
      const bad = WRITES[b];
      ok(READS.has(b) && !bad,
         `${nm}: service ${b} is a read${bad ? ` - ${b} is ${bad}` : ''}`);
    }
  }
  ok(checked >= 6, `every request's service byte was checked (${checked})`);

  // And the negative, stated directly. Only for the services whose byte cannot also
  // be a mode 01 PID: 0x34 is RequestDownload as a service and wide-range lambda as
  // a PID, and PID_B3 legitimately opens with it - a sweep that cannot tell those
  // apart reports the firmware's own sampler as an attempted download. The positive
  // check above is the rigorous one; this is the backstop for a request buffer built
  // in a shape the call-site scan cannot resolve.
  const NO_PID_COLLISION = ['0x2E', '0x31', '0x27', '0x11', '0x10', '0x14'];
  for (const b of NO_PID_COLLISION) {
    const re = new RegExp(`\\{\\s*${b}\\s*,|\\[0\\]\\s*=\\s*${b}\\s*;`, 'i');
    ok(!re.test(ino), `never sends ${b} (${WRITES[b]})`);
  }
}

// ---------------------------------------------------------------- periodic tasks
//
// The one that would have caught it. tripTick() was written, reviewed, documented
// in the README and given CSV columns, a rotation policy, a space guard and a
// watch-set generation check - and never called. Not once, on any board. The whole
// per-drive log, and with it the DID-correlation workflow the README calls the route
// to decoding the 10xx block, was dead code from the day it was added: /trips/list
// returned [] permanently and every test went green, because every test asserted
// what the code says rather than whether anything runs it.
//
// That is the same failure the /data contract exists to prevent - a green bench and
// a blank feature in the car - one layer further out. The contract checks that two
// sides agree about a field; this checks that the code producing it is reached at
// all. A periodic task nobody calls is indistinguishable from a working one in
// every other check in this file.
console.log('\nperiodic tasks');
{
  const files = ['../NexonOBD/NexonOBD.ino',
                 ...readdirSync(join(here, '../NexonOBD'))
                   .filter(f => f.endsWith('.h'))
                   .map(f => `../NexonOBD/${f}`)];
  const src = new Map(files.map(f => [f, readSrc(join(here, f))]));
  const all = [...src.values()].join('\n');

  // Named by convention: a *Tick or *Step is something loop() has to come back to.
  // The convention is the whole reason this check can be mechanical, so a task added
  // under a different name escapes it - which is worth knowing rather than pretending
  // otherwise.
  const DEF = /^static\s+[A-Za-z_][A-Za-z0-9_\s\*&:<>]*?\b(\w+(?:Tick|Step))\s*\(/gm;
  const tasks = [];
  for (const [f, text] of src)
    for (const m of text.matchAll(DEF)) tasks.push({ name: m[1], file: f });

  ok(tasks.length >= 6, `found the periodic tasks to check (${tasks.length})`);
  ok(tasks.some(t => t.name === 'tripTick'), 'tripTick is among them');

  for (const { name, file } of tasks) {
    // Definition plus at least one call. Counting uses rather than searching for a
    // call site keeps this independent of which function does the calling, which is
    // the part that legitimately moves.
    const uses = [...all.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length;
    ok(uses >= 2, `${name} (${file.split('/').pop()}) is called, not just defined`);
  }
}

// Where the two recorders are called from is itself load-bearing, so it is pinned
// rather than left to the check above.
//
// g_live keeps its last good sample, with ok still set, once the ECU stops
// answering - freshness is carried by g_liveMs, which these do not read. Called from
// loop(), tripTick would therefore write a row a second of carried-forward values
// for as long as the car was silent, and a held reading recorded as a measurement is
// the one thing the log must never contain. The published-sample branch is the only
// place a fresh sample exists.
console.log('\nrecorders run on published samples');
{
  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));

  const sampler = ino.slice(ino.indexOf('static void samplerStep'));
  const body = sampler.slice(0, sampler.indexOf('\n}\n'));
  ok(body.length > 0 && body.length < ino.length,
     'samplerStep body isolated (the \\n}\\n marker matched)');

  // if (any) is the last block in samplerStep, so everything past it is the branch
  // that runs only when a sample was actually published.
  const branch = body.slice(body.indexOf('if (any) {'));
  ok(/\bhistTick\(g_live\);/.test(branch), 'histTick runs on a published sample');
  ok(/\btripTick\(g_live\);/.test(branch), 'tripTick runs on a published sample');

  const loop = ino.slice(ino.indexOf('\nvoid loop() {'));
  ok(!/\btripTick\s*\(/.test(loop.slice(0, loop.indexOf('\n}\n'))),
     'and not from loop(), where the sample may be stale');
}

// ---------------------------------------------------------------- trip log safety
//
// A full partition is the ordinary end state of a device left in a car, not an edge
// case, and it used to fail silently in a way that could not recover: tripEnsureSpace
// returned void and gave up the first time a delete failed, tripTick checked no write
// return, and a file opened on a partition that could not take it produced rows that
// went nowhere. Because a failed write leaves size() where it was, the TRIP_MAX_BYTES
// rotation never fired again either, so logging stopped for the rest of the drive
// with nothing in the serial log and nothing on the page.
console.log('\ntrip log survives a full partition');
{
  const trip = readSrc(join(here, '../NexonOBD/triplog.h'));

  ok(/static bool tripEnsureSpace\(\)/.test(trip),
     'tripEnsureSpace reports whether it met the floor');
  ok(/if \(!tripEnsureSpace\(\)\)/.test(trip),
     'and tripOpenNew refuses to open a file when it did not');

  const ensure = trip.slice(trip.indexOf('static bool tripEnsureSpace'));
  const eb = ensure.slice(0, ensure.indexOf('\n}\n'));
  ok(/return true;/.test(eb) && /return false;/.test(eb),
     'it distinguishes met-the-floor from nothing-left-to-delete');

  const tick = trip.slice(trip.indexOf('static void tripTick'));
  const tb = tick.slice(0, tick.indexOf('\n}\n'));
  ok(/if \(tripFile\.print\('\\n'\) == 0\)/.test(tb),
     'the row terminator is checked, so a failed write is seen');
  ok(/tripClose\(\);/.test(tb.slice(tb.indexOf("print('\\n')"))),
     'and closes the file rather than writing into one that cannot take rows');
}

// ---------------------------------------------------------------- bundle serving
//
// The firmware's own serving path has no runtime coverage: the browser suites serve
// web/dist through their own static handler that imitates the board, so nothing
// exercises uiTrySend() short of flashing. That is how a double Content-Encoding
// header reached the car in 1.11.0 - streamFile() adds it for any name ending .gz,
// WebServer::sendHeader appends without deduplicating, and the browser rendered the
// compressed bytes as text.
//
// These are source assertions, which is weak, but they pin the specific mistakes so
// they cannot come back silently.
console.log('\nbundle serving');
{
  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));
  const send = ino.slice(ino.indexOf('static bool uiTrySend'));
  const body = send.slice(0, send.indexOf('\n}\n'));

  ok(/streamFile\(/.test(body), 'the bundle is streamed rather than read into a String');
  ok(!/sendHeader\("Content-Encoding"/.test(body),
     'and Content-Encoding is left to streamFile, which already sets it for .gz');

  // The entry point must never be cached forever: it is the whole bundle now, so a
  // deploy that is not picked up is a deploy that did nothing.
  ok(/uiImmutable\(path\)/.test(body), 'cache policy is decided per asset');
  ok(/"no-cache"/.test(body), 'and the entry point revalidates');

  // Names come off the wire; the board decides what it stores.
  ok(/uiStoreName\(up\.filename\.c_str\(\)/.test(ino),
     'uploads are stored under a name the firmware chooses');
}

// ---------------------------------------------------------------- /data contract
//
// The firmware emits these names; the frontend reads them. While both lived in one
// build a rename broke loudly, so nothing checked them. The frontend is moving to
// its own build and its own deploy, which makes a rename silent: a blank gauge in
// the car and a green suite on the bench.
//
// contract/data.json is the declaration both sides are checked against. This end
// checks it against handleData() in BOTH directions - a field the firmware stopped
// sending is as much a break as one the contract never knew about.
console.log('\n/data contract');
{
  const contract = JSON.parse(readFileSync(join(here, '../../contract/data.json'), 'utf8'));
  const ino = readSrc(join(here, '../NexonOBD/NexonOBD.ino'));

  const body = ino.slice(ino.indexOf('static void handleData()'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  // jsonNum(s, "name", ...) is how every value field is emitted.
  const emitted = [...fn.matchAll(/jsonNum\(s,\s*"([a-zA-Z_]+)"/g)].map(m => m[1]);

  const declared = contract.v;
  const missingFromContract = emitted.filter(f => !declared.includes(f));
  const missingFromFirmware = declared.filter(f => !emitted.includes(f));

  ok(missingFromContract.length === 0,
     `every field handleData sends is declared${missingFromContract.length
        ? ` — undeclared: ${missingFromContract.join(', ')}` : ` (${emitted.length} fields)`}`);
  ok(missingFromFirmware.length === 0,
     `every declared field is still sent${missingFromFirmware.length
        ? ` — no longer emitted: ${missingFromFirmware.join(', ')}` : ''}`);

  // Duplicates would mean the same key twice in one JSON object, where the last
  // one silently wins.
  eq(new Set(emitted).size, emitted.length, 'no field is emitted twice');
  eq(new Set(declared).size, declared.length, 'no field is declared twice');

  // The scan block is emitted from jsonScan(), on both the fresh and stale paths.
  const scanFn = ino.slice(ino.indexOf('static void jsonScan'));
  const scanKeys = [...scanFn.slice(0, scanFn.indexOf('\n}\n'))
    .matchAll(/\\"([a-zA-Z]+)\\":/g)].map(m => m[1]);
  for (const k of Object.keys(contract.scan)) {
    ok(scanKeys.includes(k), `scan field ${k} is emitted`);
  }

  // The quality block, checked in both directions like v rather than one like scan.
  // It is new, it is the only place the board reports on itself, and a field that
  // quietly stopped being sent would show up as a rate readout that is simply absent
  // - which looks identical to a board that is not sampling.
  const qFn = ino.slice(ino.indexOf('static void jsonQuality'));
  const qKeys = [...qFn.slice(0, qFn.indexOf('\n}\n'))
    .matchAll(/\\"([a-zA-Z]+)\\":/g)].map(m => m[1])
    .filter(k => k !== 'q');            // the wrapper, not a field
  const qDeclared = Object.keys(contract.q);

  const qUndeclared = qKeys.filter(k => !qDeclared.includes(k));
  const qUnsent = qDeclared.filter(k => !qKeys.includes(k));
  ok(qUndeclared.length === 0,
     `every q field is declared${qUndeclared.length
        ? ` — undeclared: ${qUndeclared.join(', ')}` : ` (${qKeys.length} fields)`}`);
  ok(qUnsent.length === 0,
     `every declared q field is still sent${qUnsent.length
        ? ` — no longer emitted: ${qUnsent.join(', ')}` : ''}`);
  eq(new Set(qKeys).size, qKeys.length, 'no q field is emitted twice');

  // q is a sibling of v, never a member of it: v is what the car reported, q is the
  // board's account of how well it read it. A quality number inside v would go
  // through the hold-last-value merge and the warning gating with the readings.
  ok(!declared.some(f => qDeclared.includes(f)),
     'q and v share no field names');
  ok(/jsonScan\(s\);\s*\n\s*jsonQuality\(s\);/.test(fn),
     'q is emitted on the fresh path, outside v');

  const stale = ino.slice(ino.indexOf('static void handleData()'));
  ok(/if \(!fresh\) \{[\s\S]*?jsonQuality\(s\);[\s\S]*?return;/.test(stale),
     'and on the stale path, where the rate is just as interesting');
}

// ---------------------------------------------------------------- syntax
//
// The firmware pages are JavaScript inside C++ raw string literals, so nothing in
// the normal build ever parses them - a typo ships and shows up as a dead
// dashboard on the car. Compile each page's script without running it.
console.log('syntax');
for (const f of [...FW_PAGES, '../../tools/dashboard.html']) {
  const blocks = scriptsOf(pageSource(f));
  ok(blocks.length > 0, `${f}: has a script block`);
  for (const js of blocks) {
    try { new Function(js); ok(true, `${f}: script parses`); }
    catch (e) { ok(false, `${f}: script parses (${e.message})`); }
  }
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

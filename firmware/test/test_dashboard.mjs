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
import { unbalancedQuotes, firmwareSources } from './quotes.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
const FW_PAGES = ['../Obdurate/boot_html.h', '../Obdurate/ota_html.h',
                  '../Obdurate/ui_html.h'];

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
  const hist = readSrc(join(here, '../Obdurate/history.h'));
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

  // And CI must ask for the same board. It did not: ci/build.yml compiled
  // esp32:esp32:XIAO_ESP32S3 with no PSRAM while build.sh compiled it with, so the
  // artifact anyone downloaded from CI got the 400-entry heap fallback for the scan
  // hit list instead of the 4000-entry PSRAM one. Nothing compared them, because
  // nothing ran - the file is parked outside .github/workflows/. An artifact built
  // for a different board configuration than the one developed against is worse
  // than no artifact, so the two are pinned to each other here.
  const ci = readSrc(join(here, '../../ci/build.yml'));
  const bFqbn = (build.match(/FQBN="([^"]+)"/) || [, ''])[1];
  const cFqbn = (ci.match(/--fqbn\s+(\S+)/) || [, ''])[1];
  ok(bFqbn.length > 0, `build.sh names an FQBN (${bFqbn})`);
  eq(cFqbn, bFqbn, 'ci/build.yml compiles the same board as build.sh');

  // The frontend versions and deploys independently, which is precisely why its
  // suite and its budget gate have to run here rather than only on a laptop.
  ok(/npm --prefix web test/.test(ci), 'CI runs the frontend suite');
  ok(/npm --prefix web run build/.test(ci), 'and the bundle budget gate');
  ok(/'web\/\*\*'/.test(ci), 'and watches web/ for changes');
  ok(/'contract\/\*\*'/.test(ci), 'and contract/, which both ends are checked against');
  ok(/FW_VERSION/.test(build) && /Obdurate-v\$VERSION\.bin/.test(build),
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
  const onDisk = readdirSync(join(here, '../Obdurate'))
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

  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));

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
  const elm = readSrc(join(here, '../Obdurate/elm_ble.h'));
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
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const trip = readSrc(join(here, '../Obdurate/triplog.h'));

  ok(/server\.on\("\/watch\/list",/.test(ino) && /server\.on\("\/watch\/set",/.test(ino),
     'the watch endpoints are routed');
  // /watch no longer serves a page and no longer has a tab either - sweep and watch
  // merged into Discover - but it is still a bookmark, it is in the nav of any older
  // bundle sitting on a LittleFS somewhere, and it may be on a QR code stuck to a
  // board. So it lands on the merged screen rather than 404ing.
  ok(/server\.on\("\/watch", \[\]\(\) \{[\s\S]{0,200}?"Location", "\/#\/scan"/.test(ino),
     '/watch redirects to the screen that absorbed it rather than 404ing');
  ok(/\{"\/monitors",\s*"\/trips",\s*"\/scan"\}/.test(ino),
     'and the other flash routes still redirect into the bundle');
  ok(/watchStep\(\);/.test(ino), 'the poller runs in loop()');

  // A sweep is already hours long and shares the bus with the sampler; a third
  // claimant would do both jobs badly, so the watch stands down while one runs.
  //
  // Triage joins that list for the same reason and a stronger one: it takes the bus
  // in 250 ms bites and is over in minutes, while watching is open-ended. Whichever
  // finishes is the one worth letting finish.
  ok(/if \(!watchN \|\| scan\.running \|\| triageOn\) return;/.test(ino),
     'watching pauses while a sweep or a triage run has the bus');

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
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const trip = readSrc(join(here, '../Obdurate/triplog.h'));
  const types = readSrc(join(here, '../Obdurate/obd_types.h'));

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

// ---------------------------------------------------------------- triage
//
// Triage is what makes watching affordable: 214 identifiers against eight watch
// slots is 27 drives, and most of those would be spent on values that never move.
// Re-reading the lot is about 36 seconds over BLE, so it partitions the list before
// a single slot is spent. The verdict rules are host-tested against the extracted
// source; these pin the wiring, which is where the last three bugs lived.
console.log('\ntriage and the DID register');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const map = readSrc(join(here, '../Obdurate/didmap.h'));
  const paths = readSrc(join(here, '../Obdurate/ui_paths.h'));

  const fn = ino.slice(ino.indexOf('static void triageStep()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(body.length > 0 && body.length < ino.length, 'triageStep body isolated');

  // A sweep is hours and owns the bus; triage is minutes and can wait for it.
  ok(/scan\.running \|\| activeTransport == TR_NONE/.test(body),
     'triage stands down for a sweep and for a dead transport');
  // And watching stands down for triage, or the two halve each other.
  ok(/!watchN \|\| scan\.running \|\| triageOn/.test(ino),
     'watching stands down for triage');

  // The one that would quietly corrupt the result: this adapter drops replies, so
  // counting silence as an unchanged read walks an identifier toward `constant` on
  // the strength of the adapter being unreliable.
  const skip = body.indexOf('continue;');
  const observe = body.indexOf('didObserve');
  ok(skip >= 0 && observe > skip, 'a missed reply is skipped, never observed');
  ok(/if \(len < 4 \|\| buf\[0\] != 0x62\) continue;/.test(body),
     'only a positive 0x62 reply counts');
  ok(/!= r\.did\) continue;/.test(body),
     'and only one about the identifier that was asked for');

  // Time-boxed, not counted - the reason scanStep is. A fixed count behaves
  // completely differently on the two transports.
  ok(/TRIAGE_BUDGET_MS/.test(ino) && /until - millis\(\)/.test(body),
     'the turn is time-boxed, so the board never looks hung');

  // Saving once per pass, not once per record: the file is rewritten whole.
  ok(/didMapDirty\) didMapSave\(\);/.test(body), 'saved when a verdict moved');
  ok((body.match(/didMapSave\(\)/g) || []).length === 1,
     'once per pass, not once per identifier');

  // Its own file. /scanhits.csv is the sweep's record, its reader is deliberately
  // loose, and it is the one thing here that cannot be regenerated without hours
  // of bus time - so the register must not share it.
  ok(/DIDMAP_FILE = "\/didmap\.csv"/.test(map), 'the register has its own file');
  // Checked against the string literal, not the prose: the header comment explains
  // at length why the sweep's record is left alone, and matching that would be a
  // check that fails on its own explanation.
  ok(!/"\/scanhits/.test(map), "and never opens the sweep's own record");

  // Seeded after scanBegin, which is what restores the hits it is seeded from.
  const setup = ino.slice(ino.indexOf('void setup()'));
  const sb = setup.indexOf('scanBegin();');
  const db = setup.indexOf('didMapBegin(');
  const ds = setup.indexOf('didMapSeed(');
  ok(sb >= 0 && db > sb && ds > db,
     'the register is built and seeded after the hits are restored');


  // Arming is not running. With the ignition off triage is armed and reads
  // nothing, and a bare ok:true cannot be told apart from a run in progress -
  // which is exactly the reply someone gets standing on the driveway.
  const start = ino.slice(ino.indexOf('static void handleTriageStart'));
  const sbody = start.slice(0, start.indexOf('\n}\n'));
  ok(sbody.length > 0 && sbody.length < ino.length, 'handleTriageStart body isolated');
  // Escaped, because these are quotes inside a C++ string literal - the same shape
  // the /data contract checks match against.
  ok(/\\"armed\\"/.test(sbody), 'the reply says whether it is armed');
  ok(/\\"total\\"/.test(sbody), 'and how many identifiers are queued');
  ok(/lastEcuOkMs/.test(sbody), 'and whether the ECU is actually answering');
  ok(/scan\.running/.test(sbody), 'and whether a sweep is holding the bus');
  ok(/no identifiers - run a sweep first/.test(sbody),
     'and refuses outright when there is nothing to triage');

  // The ignition going off is a power cycle, and a triage run is meant to span a
  // drive. Without this the board comes up in the car with the register loaded and
  // triage quietly off, and every restart mid-drive stops it without saying so.
  ok(/triagePrefs\.begin\("nexontriage"/.test(ino),
     'the armed flag is persisted, so a run survives the ignition');
  ok(/getBool\("run", false\)/.test(setup) && /triageOn = true;/.test(setup),
     'and is restored at boot');
  ok(/didMapN && triagePrefs\.begin/.test(setup),
     'but only when there is a register to resume into');
  // Written on change, not periodically - NVS erase budget is already spoken for.
  ok(/if \(triageOn == on\) return;/.test(ino),
     'and written only when it actually changes');
  // The namespace keeps the pre-rename prefix like every other one, and fits NVS's
  // 15-character cap.
  ok('nexontriage'.length <= 15, 'the namespace fits NVS');
  for (const r of ['/triage/start', '/triage/stop', '/didmap']) {
    ok(ino.includes(`server.on("${r}"`), `${r} is a route`);
  }
  ok(/"\/triage"/.test(paths) && /"\/didmap"/.test(paths),
     'both are API paths, so a typo 404s rather than returning the SPA');
}
// ---------------------------------------------------------------- mode 06
//
// A timeout and a refusal mean opposite things. The sweep has always known that -
// it is why 25 consecutive timeouts hold position instead of recording thousands of
// identifiers as "no response" - but mode 06 discovery did not.
//
// It latched monDiscovered with monMidCount at zero whenever the first request went
// unanswered, and since the poll returns immediately on an empty list, the page then
// stayed empty for the whole boot however long the car ran afterwards. Opening
// Monitors once with the ignition off was enough, which is exactly what someone
// checking the dashboard on the driveway does.
console.log('\nmode 06 does not conclude from silence');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const fn = ino.slice(ino.indexOf('static void monStep()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(body.length > 0 && body.length < ino.length, 'monStep body isolated');

  const disc = body.indexOf('if (!monDiscovered)');
  const guard = body.search(/if \(len == -1 \|\| len == -3\)/);
  const latch = body.indexOf('monDiscovered = true');
  ok(guard >= 0, 'a timeout is handled apart from an answer');
  ok(disc >= 0 && guard > disc && guard < latch,
     'and handled before anything is concluded and latched');

  // -2 is the ECU refusing, which IS an answer: mode 06 unsupported means no
  // monitors, and that conclusion is correct. Only -1 and -3 must be held.
  ok(!/len == -2/.test(body.slice(0, latch)),
     'a negative response still counts as an answer, not a retry');

  // The retry must actually be able to succeed later: leaving monDiscBase part-way
  // up the mask chain would resume a walk whose earlier masks were never read.
  const held = body.slice(guard, guard + 400);
  ok(/monDiscBase = 0x00;/.test(held), 'the mask walk restarts from the base');
  ok(/return;/.test(held), 'and nothing downstream runs on a silent bus');
}

// ---------------------------------------------------------------- vehicle
//
// The same rule as mode 06, applied to the newest thing on the bus. Discovery walks
// twelve questions once and then stops for the life of the boot, so a conclusion
// drawn from silence is not a wrong answer for a moment - it is a wrong answer that
// nothing will ever revisit, sitting behind a page that says the walk is done.
//
// The parsers themselves are compiled and exercised by the C++ suite. What is
// checked here is the wiring around them, which the host cannot see.
console.log('\nvehicle discovery is honest about what it did not learn');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const veh = readSrc(join(here, '../Obdurate/vehicle.h'));
  const files = readSrc(join(here, '../Obdurate/datafiles.h'));

  const fn = ino.slice(ino.indexOf('static void vehicleStep()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(body.length > 0 && body.length < ino.length, 'vehicleStep body isolated');

  // A negative response is an answer and advances. A timeout is not, and returns.
  ok(/if \(len == -2\)[\s\S]{0,80}advance/.test(body),
     'a refusal advances the walk - the ECU answered');
  ok(/if \(len < 0\) return;/.test(body),
     'and anything else negative returns without advancing');
  ok(!/if \(len == -1\)[\s\S]{0,120}advance\(/.test(body),
     'a timeout never advances past the question it failed to answer');
  ok(/tlen == -1 \|\| tlen == -3/.test(body),
     'the second ECU is probed with the same distinction');

  // It must not run on a bench board with nothing attached: unlike mode 06, which
  // only runs while a page is open, this is in loop() unconditionally.
  ok(/millis\(\) - lastEcuOkMs > 3000\) return;/.test(body),
     'the walk does not start while the ECU is silent');
  ok(/if \(vehDone\) return;/.test(body), 'and stops for good once it is done');

  // A question that is neither answered nor refused has to end somewhere, or the
  // page shows a walk stuck at step 3 with no way to read it.
  ok(/vehTries > VEH_MAX_TRIES/.test(body), 'an unanswerable question is abandoned');

  // Absent data breaks the rule. handleVehicle must be able to say "unknown", and
  // the bitmaps are the only thing that can distinguish it from "no".
  const h = ino.slice(ino.indexOf('static void handleVehicle()'));
  const hb = h.slice(0, h.indexOf('\n}\n'));
  ok(hb.length > 0 && hb.length < ino.length, 'handleVehicle body isolated');
  ok(/unknown \? "unknown"/.test(hb),
     'an unread block reports unknown, never a car that cannot');
  ok(/sampleBatchPids/.test(hb),
     'the polled list comes from the sampler, not a second copy of it');

  // The identity is what a backup keys on. A stale one is worse than none: it is
  // the case where a register from the wrong car passes the check.
  ok(/RESET_NVS\[\][\s\S]{0,200}"nexonveh"/.test(files),
     'a reset forgets the car along with the conclusions drawn about it');
  ok(/vehVinOk\(g_veh\.vin\)\) g_veh\.vin\[0\] = 0;/.test(ino),
     'a VIN restored from NVS passes the same check a fresh one does');
  ok(/if \(!haveVin && !haveCal\) return;/.test(veh),
     'and a board that has never seen a car keys to nothing at all');

  // HEX is a macro in the Arduino core (Print.h, `#define HEX 16`). The host shims
  // do not define it, so a local named HEX compiles clean under g++ and fails only
  // at arduino-cli - which is the slowest place in this project to find a typo.
  ok(!/\bstatic const char HEX\b/.test(veh),
     'no local named HEX - the Arduino core has already taken that name');
}

// ---------------------------------------------------------------- one car
//
// The rule: this board belongs to one vehicle, and in any other one it records
// nothing. Mixing two cars' data produces no detectable error - a hit is a DID and
// some bytes, with no vehicle in the record - so the only place this can be
// enforced is at the moment of writing, and it has to be enforced at EVERY such
// moment. One ungated recorder is the whole rule gone.
console.log('\nnothing is recorded in a car this board is not bound to');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const bind = readSrc(join(here, '../Obdurate/carbind.h'));

  // Every path that writes a conclusion or a sample to flash, named rather than
  // inferred: a recorder added later without a gate is the failure this catches.
  for (const [what, re] of [
    ['the trend ring',  /if \(g_mayRecord\) histTick\(/],
    ['the trip log',    /if \(g_mayRecord\) tripTick\(/],
    ['the sweep',       /static void scanStep\(uint32_t budgetMs\) \{[\s\S]{0,300}?if \(!g_mayRecord\) return;/],
    ['triage',          /static void triageStep\(\) \{[\s\S]{0,300}?if \(!g_mayRecord\) return;/],
    ['the fitting',     /static void corrTick\(const Live &L\) \{\s*\n\s*if \(!carMayRecordNow\(\)\) return;/],
  ]) ok(re.test(ino), `${what} is gated on the binding`);

  // And the live path is NOT. A board showing a blank screen in the wrong car
  // would be worse than useless at the moment somebody wants a temperature.
  const pub = ino.slice(ino.indexOf('  if (any) {'));
  const body = pub.slice(0, pub.indexOf('\n}\n'));
  ok(/g_live\s+= pub;/.test(body) && !/if \(g_mayRecord\)[\s\S]{0,40}g_live\s+= pub;/.test(body),
     'publishing the live sample is not gated - the dashboard works in any car');

  // The one that would be invisible: deciding the binding once at boot. Discovery
  // finishes seconds after startup, so a state settled before it ran says "new
  // car" for the first ten seconds of every drive with every recorder open behind
  // it.
  ok(/millis\(\) - carAt > 1000\) \{ carAt = millis\(\); carRefresh\(\); \}/.test(ino),
     'the binding is recomputed while running, not decided once at boot');

  // Absence must never read as a mismatch. This is the direction that fails
  // silently: it would switch off recording on every car that declines mode 09,
  // and the symptom is a board that runs and quietly never writes a trip log.
  ok(/if \(!haveSeen\)\s+return CAR_UNKNOWN;/.test(bind),
     'no key seen is unknown, never foreign');
  ok(/return state != CAR_FOREIGN;/.test(bind),
     'and only a proven mismatch stops recording');

  // Adopting is destructive and must not be a bare GET that a link preloader or a
  // second tap can fire.
  const ad = ino.slice(ino.indexOf('static void handleCarAdopt()'));
  const adopt = ad.slice(0, ad.indexOf('\n}\n'));
  ok(/server\.arg\("confirm"\) != "yes"/.test(adopt), 'adopting a car needs a confirmation');
  ok(/if \(!seen\[0\]\)/.test(adopt),
     'and refuses before the new car has identified itself, or it would bind to nothing');
  ok(adopt.indexOf('vehSave();') > adopt.indexOf('RESET_NVS'),
     'the new identity is written after the wipe, not before it');
}

// ---------------------------------------------------------------- autopilot
//
// A pipeline measured in drives. The failure modes are all "looks stuck": a phase
// that cannot advance, a rotation that never happens, a fit lost to the ignition.
console.log('\nthe autopilot survives the ignition');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const auto = readSrc(join(here, '../Obdurate/autopilot.h'));

  ok(/autoPrefs\.putUChar\("phase"/.test(ino), 'the phase is kept in NVS');
  ok(/g_autoPhase\s+= autoPrefs\.getUChar\("phase"/.test(ino), 'and read back on boot');
  ok(/if \(g_autoPhase > AUTO_PHASE_MAX\) g_autoPhase = AUTO_OFF;/.test(ino),
     'a phase NVS does not recognise falls back to off rather than to an index');
  // The stored numbers are assigned, not positional. Inserting a phase in pipeline
  // order would renumber every one after it, and a board that lost power mid-run
  // would come back in a different phase than it left.
  ok(/AUTO_SWEEP2 = 5/.test(auto) && /AUTO_TRIAGE = 2/.test(auto),
     'phase numbers are pinned, so a new one cannot renumber a stored run');

  // Rotation at boot and nowhere else. Mid-drive it would bump watchGen, which
  // rotates the trip log, and one drive would become a pile of short files.
  const rot = [...ino.matchAll(/autoRotate\(\)/g)].length;
  ok(rot >= 2, 'autoRotate has a call site');
  ok(!/void loop\(\)[\s\S]*autoRotate\(\)/.test(ino),
     'and it is never called from loop() - that would rotate the trip log mid-drive');

  // A drive's fits must not live only in RAM: the ignition is a power cut, not a
  // shutdown.
  ok(/millis\(\) - lastCommit > 300000UL/.test(ino),
     'fits are committed periodically, not only when the set rotates');
  ok(/const int delta = \(int\)stored - \(int\)rec->corrR100;/.test(ino),
     'and only when the answer actually moved, so a converged set stops writing');

  // The two conclusions that must not become loops.
  ok(/return f\.records \? AUTO_TRIAGE : AUTO_DONE;/.test(auto),
     'a sweep that found nothing is a conclusion, not a retry');
  ok(/if \(!f\.mayRecord\) return phase;/.test(auto),
     'a foreign car holds the pipeline rather than ending it');
  ok(/if \(phase == AUTO_OFF \|\| phase == AUTO_DONE\) return phase;/.test(auto),
     'and neither off nor done restarts itself');

  // A correlation is not an identification, and nothing may present it as one.
  const corr = readSrc(join(here, '../Obdurate/correlate.h'));
  ok(/tracks/.test(corr) && /never/.test(corr),
     'correlate.h states the tracks-not-is rule');
  ok(/if \(isnan\(x\) \|\| isnan\(y\)/.test(corr),
     'an absent reading forms no pair - a gap is not a zero');
  ok(/if \(vx <= 0 \|\| vy <= 0\) return NAN;/.test(corr),
     'a column that never moved reports nothing, not an r of zero');
}

// ---------------------------------------------------------------- scan hits
//
// A sweep's results are the point of running one, and they outlive it: /watch offers
// them as checkboxes so nobody has to copy hex between pages, and that is the whole
// documented route from "this identifier answers" to "this identifier is coolant".
//
// scanLoadHits() used to sit AFTER scanBegin()'s early return, so hits came back from
// flash only while a sweep was mid-run. A sweep that finished, or was stopped - which
// is how most of them end - left /scanhits.csv on the filesystem with nothing ever
// reading it, and the picker was empty on a board holding thousands of results.
//
// The same shape as the tripTick bug: reachable code on a path nobody takes.
console.log('\nscan hits outlive the sweep');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const fn = ino.slice(ino.indexOf('static void scanBegin()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(body.length > 0 && body.length < ino.length, 'scanBegin body isolated');

  const load = body.indexOf('scanLoadHits();');
  const bail = body.search(/if \(!wasRunning\b/);
  const prefs = body.indexOf('scanPrefs.begin(');

  ok(load >= 0, 'scanBegin restores the hits');
  ok(bail >= 0 && load < bail,
     'and does it before the not-resuming early return, not after');
  // Also before the NVS read, which has its own `return` when the namespace will
  // not open - a second path that would silently skip the restore.
  ok(prefs >= 0 && load < prefs,
     'and before the NVS read, which can also return early');
  eq((body.match(/scanLoadHits\(\)/g) || []).length, 1,
     'restored exactly once, so resuming does not double-load the list');
}

// ---------------------------------------------------------------- home screen
//
// The manifest and icon are served from flash rather than shipped in the bundle, so
// the board keeps a name and an icon with no bundle installed - and so the bundle
// stays one file. That split means three separate things have to agree, and none of
// them fails loudly: a launcher that cannot fetch the manifest just quietly makes an
// ugly shortcut.
console.log('\nhome-screen install');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const pwa = readSrc(join(here, '../Obdurate/pwa.h'));
  const paths = readSrc(join(here, '../Obdurate/ui_paths.h'));
  const page = readFileSync(join(here, '../../web/index.html'), 'utf8');

  // The manifest is JSON compiled into a raw string literal, and nothing in the
  // build parses it - the same hole that shipped broken JavaScript before the
  // frontend moved out. Parse it here.
  const body = (pwa.match(/PWA_MANIFEST\[\] PROGMEM = R"JSON\(([\s\S]*?)\)JSON"/) || [, ''])[1];
  let manifest = null;
  try { manifest = JSON.parse(body); ok(true, 'the manifest is valid JSON'); }
  catch (e) { ok(false, `the manifest is valid JSON (${e.message})`); }

  if (manifest) {
    eq(manifest.start_url, '/', 'it launches on the live gauges');
    eq(manifest.display, 'standalone', 'without browser chrome');
    // The colours are the page's own. A launcher paints the splash and the task
    // switcher with these, and a mismatch reads as a different app.
    const css = readSrc(join(here, '../Obdurate/ui_css.h'));
    ok(css.includes(manifest.background_color), 'the splash colour is the page background');
    ok(page.includes(`content="${manifest.theme_color}"`), 'and theme-color agrees with the document');

    // Every icon has to be a path the firmware actually serves.
    for (const i of manifest.icons || []) {
      ok(new RegExp(`server\\.on\\("${i.src}"`).test(ino), `${i.src} is a route`);
    }
    // A maskable icon is cropped to a circle by some launchers; without one
    // declared they letterbox the square instead.
    ok((manifest.icons || []).some(i => (i.purpose || '').includes('maskable')),
       'a maskable icon is declared');
  }

  ok(/<svg[\s\S]*<\/svg>/.test(pwa), 'the icon is an inline SVG');
  ok(/server\.on\("\/manifest\.webmanifest"/.test(ino), 'the manifest is a route');
  ok(/application\/manifest\+json/.test(ino), 'served with the manifest content type');
  ok(/image\/svg\+xml/.test(ino), 'and the icon as SVG');

  // Both are in API[], so a dropped handler 404s instead of answering a launcher
  // with the bundle's HTML and a 200.
  ok(/"\/manifest\.webmanifest"/.test(paths) && /"\/icon\.svg"/.test(paths),
     'both are API paths, so neither can fall through to the SPA');

  // iOS ignores the manifest for Add to Home Screen; these tags are the whole
  // mechanism there, and they are the reason this works without HTTPS at all.
  ok(/apple-mobile-web-app-capable"\s+content="yes"/.test(page), 'iOS launches standalone');
  ok(/apple-touch-icon/.test(page), 'and has an icon to use');
  ok(/viewport-fit=cover/.test(page) && /black-translucent/.test(page),
     'the status bar overlay and the viewport agree');
  ok(!/Nexon/.test(page), 'the document title survived the rename');

  // No service worker anywhere: it cannot register over http on a private address,
  // and shipping a registration that silently never runs would be worse than none.
  const web = readdirSync(join(here, '../../web/src'));
  ok(!web.some(f => /service-?worker|\bsw\.js/i.test(f)), 'no service worker is shipped');
  ok(!/serviceWorker/.test(page), 'and none is registered');
}

// ---------------------------------------------------------------- web flasher
//
// docs/flash/ is the front door: a stranger with a XIAO and a USB cable flashes from
// Chrome without arduino-cli or a six-gigabyte core download. Everything about it is
// a name that has to agree with something else - the asset build.sh writes, the
// version in version.h, the chip the FQBN compiles for - and none of those agreements
// is visible from the page, which just fails to flash and says nothing useful.
console.log('\nweb flasher');
{
  const manifest = JSON.parse(readFileSync(join(here, '../../docs/flash/manifest.json'), 'utf8'));
  const build = readSrc(join(here, '../build.sh'));
  const page = readFileSync(join(here, '../../docs/flash/index.html'), 'utf8');

  eq(manifest.version, fwVersion(), 'the manifest names the version in version.h');

  const parts = (manifest.builds || []).flatMap(b => b.parts || []);
  eq(parts.length, 1, 'one part: a merged image written at offset 0');
  eq(parts[0].offset, 0, 'at offset 0, which is what a full-flash image needs');

  // The manifest points at releases/latest/download/<asset> so the Install button
  // keeps working across releases without a manifest bump. That only holds while the
  // asset is named the same every time, which is build.sh's job.
  const asset = parts[0].path.split('/').pop();
  ok(build.includes(asset),
     `build.sh produces the asset the manifest asks for (${asset})`);
  ok(/releases\/latest\/download/.test(parts[0].path),
     'and points at the latest release rather than a pinned one');

  // The board is an ESP32-S3. A manifest naming a different family fails at the
  // moment of flashing, on someone else's desk.
  const fams = (manifest.builds || []).map(b => b.chipFamily);
  ok(fams.includes('ESP32-S3'), `the manifest targets ESP32-S3 (${fams.join(', ')})`);
  ok(/XIAO_ESP32S3/.test(build), 'which is the board build.sh compiles for');

  // The page states the AP credentials. They are in the sketch, and a page that
  // tells a stranger the wrong network name is a support request with no clue in it.
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const ssid = (ino.match(/AP_SSID\s*=\s*"([^"]+)"/) || [, ''])[1];
  const pass = (ino.match(/AP_PASS\s*=\s*"([^"]+)"/) || [, ''])[1];
  ok(page.includes(ssid), `the page names the real AP SSID (${ssid})`);
  ok(page.includes(pass), 'and the real placeholder password');
  ok(pass.length >= 8, 'which is long enough for WPA2');
  ok(/Change it/i.test(page), 'and tells them to change it');
}

// ---------------------------------------------------------------- stored state
//
// The NVS namespaces did not follow the rename to Obdurate, and must not. They are
// storage keys that nothing displays, and renaming one orphans what a board already
// holds - including scanSaveState()'s position, which is the resume point of a sweep
// that runs for over half an hour on CAN and the better part of a day over BLE. A
// board mid-sweep would come up believing it had never started, and the trend
// history and trip sequence would go the same way on the first boot after an update.
//
// So this is pinned. A future tidy-up that "finishes the rename" fails here with the
// reason attached, rather than costing somebody a day of scanning.
console.log('\nstored state survives the rename');
{
  const files = ['../Obdurate/Obdurate.ino', '../Obdurate/triplog.h', '../Obdurate/history.h'];
  const all = files.map(f => readSrc(join(here, f))).join('\n');
  const spaces = [...all.matchAll(/\.begin\("([a-z0-9_]+)"/g)].map(m => m[1]);

  ok(spaces.length >= 4, `found the NVS namespaces (${[...new Set(spaces)].join(', ')})`);
  for (const ns of new Set(spaces)) {
    ok(ns.startsWith('nexon'),
       `${ns} keeps its pre-rename name - renaming it orphans a resumable sweep`);
    // NVS caps a namespace at 15 characters, and a name that silently overruns is
    // a begin() that fails and a feature that stops persisting with no error.
    ok(ns.length <= 15, `${ns} is within the 15-character NVS limit`);
  }
}

// ---------------------------------------------------------------- built-in UI
//
// The dashboard is compiled into the firmware so that flashing is the whole
// install. ui_bundle.h is generated from web/dist by web/scripts/embed.mjs and is
// committed, because firmware/build.sh must work for someone who only wants to
// flash - requiring npm to compile the firmware would put a Node toolchain between
// a stranger and a working board.
//
// Committing a generated file earns exactly one obligation: it must not go stale.
// A header left behind after a UI change would ship the previous dashboard inside
// the new firmware, and the only symptom is a page that looks slightly old.
console.log('\nbuilt-in dashboard');
{
  const bundle = readSrc(join(here, '../Obdurate/ui_bundle.h'));
  const declared = Number((bundle.match(/UI_BUNDLE_GZ_LEN = (\d+);/) || [, 0])[1]);
  ok(declared > 10000, `a dashboard is compiled in (${declared} B gzipped)`);

  // The array has to match the length beside it, or send_P walks off the end of it.
  const bytes = (bundle.match(/0x[0-9a-f]{2}/g) || []).length;
  eq(bytes, declared, 'the byte array is exactly as long as it claims');

  // Well inside app0. The point of this check is not the ceiling, it is noticing
  // the day the bundle stops being small enough for this to be a free choice.
  ok(declared < 200 * 1024, 'and small enough to compile in without thinking about it');

  // Against the build output, when there is one. A header left stale after a UI
  // change is the whole risk of committing a generated file.
  const dist = join(here, '../../web/dist/index.html.gz');
  if (existsSync(dist)) {
    eq(declared, statSync(dist).size,
       'ui_bundle.h matches the current web/dist - regenerate with npm --prefix web run build');
  } else {
    ok(true, 'no web/dist to compare against (skipped)');
  }

  // The order the firmware serves them in: an uploaded bundle wins, the compiled-in
  // one is the floor. Reversing it would make web/deploy.sh silently do nothing.
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const fn = ino.slice(ino.indexOf('static bool sendDashboard()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(body.indexOf('uiTrySend') < body.indexOf('sendBuiltInUi'),
     'an uploaded bundle takes precedence over the compiled-in one');

  // send_P is not streamFile and does not add the encoding header itself - the
  // mirror of the double-header trap in uiTrySend that shipped in 1.11.0.
  const send = ino.slice(ino.indexOf('static void sendBuiltInUi()'));
  ok(/Content-Encoding", "gzip"/.test(send.slice(0, 400)),
     'the compiled-in copy is served with its encoding, since send_P adds none');
}
// ---------------------------------------------------------------- syntax lint
//
// Nothing in this suite parses the sketch as C++. extract.py pulls named functions
// and compiles those; everything outside that list - setup(), the handlers, the
// periodic tasks - is only ever read as text. So a broken string literal there
// passes every check in this file and surfaces at arduino-cli, which needs a 6 GB
// toolchain and is the slowest possible place to find it. That happened twice in
// one afternoon, and one of the two was committed and pushed.
//
// A line whose double quotes do not balance is the whole class, and it costs
// milliseconds to check.
console.log('\nsyntax lint');
{
  const files = firmwareSources(join(here, '../Obdurate'));
  ok(files.length >= 15, `linting the firmware sources (${files.length} files)`);

  let flagged = 0;
  for (const { name, src } of files) {
    for (const h of unbalancedQuotes(src)) {
      flagged++;
      ok(false, `${name}:${h.line} unterminated string: ${h.text.slice(0, 60)}`);
    }
  }
  ok(flagged === 0, 'every string literal in the firmware closes on its own line');

  // The guard checked against itself. A lint that quietly stopped matching would
  // look exactly like a clean tree, which is the failure it exists to prevent.
  const Q = String.fromCharCode(34), NL = String.fromCharCode(10),
        BS = String.fromCharCode(92);
  const broken = 'Serial.printf(' + Q + '[triage] resuming, %u ids' + NL + Q + ', n);';
  const intact = 'Serial.printf(' + Q + '[trip] fs %u bytes' + BS + 'n' + Q + ', n);';
  // Both halves of a split literal are unbalanced, so it reports two lines - which
  // is what you want when locating it, not one.
  ok(unbalancedQuotes(broken).length >= 1, 'it catches the shape that shipped twice');
  ok(unbalancedQuotes(intact).length === 0, 'and leaves an intact escape alone');
  // The idioms this file is full of, which must not trip it.
  ok(unbalancedQuotes('// the ' + Q + 'sub' + Q + ' span').length === 0, 'quotes in comments');
  ok(unbalancedQuotes('s += ' + Q + BS + Q + 'ok' + BS + Q + Q + ';').length === 0,
     'escaped quotes in a JSON string');
  ok(unbalancedQuotes('X = R' + Q + 'J({' + NL + Q + 'a' + Q + NL + '})J' + Q + ';').length === 0,
     'a raw string spanning lines');
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
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));

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
  const files = ['../Obdurate/Obdurate.ino',
                 ...readdirSync(join(here, '../Obdurate'))
                   .filter(f => f.endsWith('.h'))
                   .map(f => `../Obdurate/${f}`)];
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
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));

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
  const trip = readSrc(join(here, '../Obdurate/triplog.h'));

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
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
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
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));

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

  // Boot forensics, same treatment. A board that has quietly panicked and restarted
  // forty times looks identical from the page to one that has been up all week.
  const bootFn = ino.slice(ino.indexOf('static void jsonBoot'));
  const bootKeys = [...bootFn.slice(0, bootFn.indexOf('\n}\n'))
    .matchAll(/\\"([a-zA-Z]+)\\":/g)].map(m => m[1]).filter(k => k !== 'boot');
  const bootDeclared = Object.keys(contract.boot);
  ok(bootKeys.filter(k => !bootDeclared.includes(k)).length === 0,
     `every boot field is declared (${bootKeys.length} fields)`);
  ok(bootDeclared.filter(k => !bootKeys.includes(k)).length === 0,
     'every declared boot field is still sent');
  ok(/if \(!fresh\) \{[\s\S]*?jsonBoot\(s\);[\s\S]*?return;/.test(stale),
     'boot is reported on the stale path too - a silent board is when it matters most');
}

// ---------------------------------------------------------------- power
//
// The idle timer answers "the car is off". It does not answer "the battery is going
// flat", and the two come apart exactly where it matters: an ECU that keeps
// answering with the engine stopped resets lastEcuOkMs on every reply, so the
// ten-minute guard never arms and the board keeps drawing from a battery nothing is
// charging.
console.log('\npower');
{
  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));

  // One exit, because there is now more than one reason to take it and the
  // expensive mistake is a path that forgets tripClose() - the trip file is
  // buffered, so a sleep that skips it drops up to TRIP_FLUSH_MS of the drive that
  // was just recorded.
  const down = ino.slice(ino.indexOf('static void powerDown('));
  const db = down.slice(0, down.indexOf('\n}\n'));
  for (const step of ['histSave();', 'tripClose();', 'twai_stop();',
                      'esp_deep_sleep_start();']) {
    ok(db.includes(step), `powerDown does ${step}`);
  }

  const loop = ino.slice(ino.indexOf('\nvoid loop() {'));
  const lb = loop.slice(0, loop.indexOf('\n}\n'));
  const sleeps = [...lb.matchAll(/esp_deep_sleep_start\(\)/g)].length;
  eq(sleeps, 0, 'loop() never sleeps directly - it goes through powerDown');
  eq([...lb.matchAll(/powerDown\(/g)].length, 2,
     'and has exactly two reasons to: the idle timer and the battery floor');

  // The guard must never read a carried-forward sample. g_live keeps its last
  // values once the ECU stops answering, and a voltage from ten minutes ago must
  // not switch the board off now.
  ok(/freshSample \? g_live\.volt : NAN/.test(lb) && /freshSample \? g_live\.rpm : NAN/.test(lb),
     'the battery guard is fed NAN rather than a stale reading');
  ok(/g_seq && \(millis\(\) - g_liveMs < 4000\)/.test(lb),
     'and freshness is the same test /data uses');

  // The rule itself is host-tested against the extracted function; these pin the
  // constants, which are the part a well-meaning edit would move.
  const step = ino.slice(ino.indexOf('static uint32_t battLowStep('));
  const sb = step.slice(0, step.indexOf('\n}\n'));
  ok(/if \(isnan\(volt\) \|\| isnan\(rpm\)\) return 0;/.test(sb),
     'absent readings break the run before anything else is considered');
  ok(sb.indexOf('isnan') < sb.indexOf('BATT_SLEEP_V'),
     'and are checked before the threshold, not after');
  ok(/BATT_SLEEP_HOLD_MS = 30000/.test(ino),
     'the hold is long enough to sit out a crank');
}

// ---------------------------------------------------------------- syntax
//
// The firmware pages are JavaScript inside C++ raw string literals, so nothing in
// the normal build ever parses them - a typo ships and shows up as a dead
// dashboard on the car. Compile each page's script without running it.
console.log('syntax');
for (const f of FW_PAGES) {
  const blocks = scriptsOf(pageSource(f));
  ok(blocks.length > 0, `${f}: has a script block`);
  for (const js of blocks) {
    try { new Function(js); ok(true, `${f}: script parses`); }
    catch (e) { ok(false, `${f}: script parses (${e.message})`); }
  }
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

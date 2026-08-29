// The DID scanner's framework-free half, lifted out of the <script> block in
// firmware/Obdurate/scan_html.h so it can be asserted against directly.
//
// Everything here is a pure function of the /scan/status payload. The component
// does the fetching, the timers and the anchor click; this module decides what a
// number *reads* as, which is the part that was refined against a real car and the
// part a refactor is most likely to quietly change.

import { DASH } from '../../lib/format.js';

/** The file name the Watch page's loader expects. Do not rename in isolation. */
export const CSV_NAME = 'did_hits.csv';

/**
 * The ECUs a sweep can be pointed at.
 *
 * `id` is what goes into `?ecu=` and is the firmware's index into its own request/
 * response address pair, so these are not labels that can be reordered freely — the
 * position is the protocol. Named here rather than inline in the page so the ids
 * can be asserted, because getting them the wrong way round would sweep the
 * transmission while telling you it was sweeping the engine.
 */
export const ECUS = [
  { id: '0', name: 'ECM', addr: '7E0 / 7E8', of: 'engine' },
  { id: '1', name: 'TCM', addr: '7E1 / 7E9', of: 'transmission' },
];

/**
 * Coarse duration, ported verbatim from `hms()`.
 *
 * Deliberately one unit past the first: a sweep that has 14 hours left is 14 hours
 * left whether or not there are 37 minutes on the end of it, and past two days the
 * only honest answer is a number of days.
 */
export function hms(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 48 ? Math.round(h / 24) + 'd' : h ? h + 'h ' + m + 'm' : m ? m + 'm' : s + 's';
}

/** Identifiers per second so far. Zero before the first whole second elapses. */
export function ratePerSec(tried, elapsed) {
  return elapsed > 0 ? tried / elapsed : 0;
}

/**
 * The rate readout. One decimal while it is slow enough for one to matter, none
 * once it is not — `4.3/s` and `120/s` are both the useful precision at their end
 * of the range. A rate of nothing is a gap, not a reading of zero.
 */
export function rateText(rps) {
  return rps ? rps.toFixed(rps < 10 ? 1 : 0) : DASH;
}

/**
 * Time left. A full sweep is 65,536 requests and on BLE that is the better part of
 * a day, which is worth knowing before walking away rather than after. Withheld
 * until there is a rate to extrapolate from, because an ETA computed from no
 * samples is a guess wearing a number's clothes.
 */
export function etaText(rps, tried, total) {
  return (rps > 0 && total > tried) ? hms((total - tried) / rps) : DASH;
}

/** Bar width, as the firmware wrote it: one decimal, clamped by the caller's data. */
export function percent(tried, total) {
  return (total ? 100 * tried / total : 0).toFixed(1);
}

/**
 * Progress in words, counts first.
 *
 * A percentage on its own is useless here: over a 65,536-identifier sweep the first
 * 650 requests all round to 0.0–1.0%, so the page reads as stuck for the ten minutes
 * where a driver is most likely to conclude it is broken and press Start again —
 * which wipes the run. The counts move on every single request; the percentage is
 * there for the shape of the remaining work, not for progress.
 */
export function progressText(tried, total) {
  const a = tried || 0, b = total || 0;
  return a + ' / ' + b + ' · ' + percent(a, b) + '%';
}

/**
 * The header pill: what the sweep is doing, in the firmware page's own words.
 *
 * Stalled is neither idle nor scanning. The sweep is alive and holding position
 * because the ECU stopped answering, and saying "scanning" would imply progress
 * that is deliberately not happening — the distinction matters because the honest
 * response to a stalled sweep is to switch the ignition on, and the response to a
 * stuck one is to press Stop.
 */
export function scanStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'ESP32 unreachable' };
  if (!j) return { dot: 'dot', text: 'idle' };
  if (j.stalled) return { dot: 'dot stale', text: 'waiting for ECU' };
  return j.running ? { dot: 'dot live', text: 'scanning' } : { dot: 'dot', text: 'idle' };
}

/** `1A2B3C` -> `1A 2B 3C`, so a payload can be read a byte at a time. */
export function spacedHex(hex) {
  return String(hex == null ? '' : hex).replace(/(..)/g, '$1 ').trim();
}

/**
 * The export, byte for byte as the firmware wrote it: `ecu,did,len,hex,ascii`
 * with the ascii column quoted because a decoded payload can contain a comma.
 *
 * This format is not free to change. The Watch page's file loader parses exactly
 * these five columns out of a did_hits.csv that may have been exported by an
 * *older firmware*, so the reader and the writer are versioned apart and the
 * column order is the only contract between them. Any quote inside the payload is
 * dropped rather than escaped — same as the firmware, and the reason the loader
 * can get away with never reading past the fourth column.
 */
export function hitsCsv(hits) {
  const rows = [['ecu', 'did', 'len', 'hex', 'ascii'].join(',')];
  for (const h of hits || []) {
    rows.push([
      h.ecu,
      h.did,
      h.len,
      h.hex,
      '"' + String(h.ascii == null ? '' : h.ascii).replace(/"/g, '') + '"',
    ].join(','));
  }
  return rows.join('\n');
}

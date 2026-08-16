// The scanner's readouts and its export.
//
// The export is the load-bearing one: did_hits.csv is written here and read by the
// Watch page's file loader, possibly across a firmware version. The column format
// is the only contract between the two, so it is pinned here rather than left to be
// noticed on a phone in a car park.

import { describe, it, expect } from 'vitest';
import {
  hms, ratePerSec, rateText, etaText, percent, progressText, scanStatus, spacedHex,
  hitsCsv, CSV_NAME,
} from './scan.js';
import { parseCsv } from '../watch/hits.js';
import { DASH } from '../../lib/format.js';

describe('durations', () => {
  it('shows one unit, coarsening as it grows', () => {
    expect(hms(9)).toBe('9s');
    expect(hms(90)).toBe('1m');
    expect(hms(3600)).toBe('1h 0m');
    expect(hms(3600 * 4 + 60 * 7)).toBe('4h 7m');
  });

  it('collapses to days past two of them', () => {
    // A sweep with 60 hours left is "3d". Minutes on the end of that would be
    // precision the estimate does not have.
    expect(hms(3600 * 60)).toBe('3d');
    expect(hms(3600 * 48)).toBe('48h 0m');   // still hours at the boundary
    expect(hms(3600 * 49)).toBe('2d');
  });
});

describe('rate and estimate', () => {
  it('withholds a rate until a second has elapsed', () => {
    // Not zero. Nothing has been measured yet, and 0/s reads as a stalled bus.
    expect(rateText(ratePerSec(120, 0))).toBe(DASH);
    expect(ratePerSec(120, 0)).toBe(0);
  });

  it('carries a decimal only while one matters', () => {
    expect(rateText(ratePerSec(43, 10))).toBe('4.3');
    expect(rateText(ratePerSec(1200, 10))).toBe('120');
    expect(rateText(ratePerSec(99, 10))).toBe('9.9');
    expect(rateText(ratePerSec(100, 10))).toBe('10');
  });

  it('estimates the time left from the rate so far', () => {
    // 65,536 requests at 6/s — the BLE budget — is the better part of a day, which
    // is the fact the readout exists to deliver before someone walks away.
    const rps = ratePerSec(600, 100);
    expect(rps).toBe(6);
    expect(etaText(rps, 600, 65536)).toBe('3h 0m');
  });

  it('withholds the estimate with no rate or nothing left', () => {
    expect(etaText(0, 0, 65536)).toBe(DASH);
    expect(etaText(6, 65536, 65536)).toBe(DASH);
    expect(etaText(6, 70000, 65536)).toBe(DASH);
  });
});

describe('progress', () => {
  it('leads with counts, because the percentage sits at zero for ages', () => {
    // The bug this is here for: 300 requests into a full sweep the bar has moved
    // half a pixel and "0.5%" has not changed in ten minutes, so the page reads as
    // stuck — and the instinctive fix is to press Start, which wipes the run.
    expect(percent(300, 65536)).toBe('0.5');
    expect(progressText(300, 65536)).toBe('300 / 65536 · 0.5%');
    expect(progressText(301, 65536)).toBe('301 / 65536 · 0.5%');   // counts moved, % did not
  });

  it('survives a status that has not arrived yet', () => {
    expect(progressText(0, 0)).toBe('0 / 0 · 0.0%');
    expect(progressText(undefined, undefined)).toBe('0 / 0 · 0.0%');
  });
});

describe('what the header says', () => {
  it('separates a stalled sweep from a running one', () => {
    // The distinction the state exists for: a stalled sweep is alive and holding
    // its place because the ECU stopped answering — ignition off, most likely. It
    // must not say "scanning", because the honest response to it is to switch the
    // ignition on, while the response to a genuinely stuck one is to press Stop.
    expect(scanStatus({ running: true, stalled: true }, false))
      .toEqual({ dot: 'dot stale', text: 'waiting for ECU' });
    expect(scanStatus({ running: true, stalled: false }, false))
      .toEqual({ dot: 'dot live', text: 'scanning' });
    expect(scanStatus({ running: false, stalled: false }, false))
      .toEqual({ dot: 'dot', text: 'idle' });
  });

  it('a stalled sweep that is somehow not running still reads as waiting', () => {
    // Stalled outranks running either way — it is the state that explains itself.
    expect(scanStatus({ running: false, stalled: true }, false).text).toBe('waiting for ECU');
  });

  it('reports an unreachable board over anything it last knew', () => {
    expect(scanStatus({ running: true }, true))
      .toEqual({ dot: 'dot dead', text: 'ESP32 unreachable' });
  });

  it('is idle before the first status arrives', () => {
    expect(scanStatus(null, false)).toEqual({ dot: 'dot', text: 'idle' });
  });
});

describe('payload hex', () => {
  it('spaces bytes so a payload can be read one at a time', () => {
    expect(spacedHex('1A2B3C')).toBe('1A 2B 3C');
    expect(spacedHex('')).toBe('');
    expect(spacedHex(null)).toBe('');
    // An odd nibble count cannot come off the wire, but must not lose the tail.
    expect(spacedHex('1A2')).toBe('1A 2');
  });
});

describe('did_hits.csv', () => {
  const hits = [
    { ecu: 'ECM', did: '1002', len: 4, hex: '00001A2B', ascii: '...+' },
    { ecu: 'TCM', did: '0140', len: 2, hex: '0F3C', ascii: '.<' },
  ];

  it('writes the exact five columns, ascii quoted', () => {
    expect(hitsCsv(hits)).toBe(
      'ecu,did,len,hex,ascii\n' +
      'ECM,1002,4,00001A2B,"...+"\n' +
      'TCM,0140,2,0F3C,".<"'
    );
  });

  it('is named what the Watch page loader expects', () => {
    expect(CSV_NAME).toBe('did_hits.csv');
  });

  it('drops quotes inside a payload rather than escaping them', () => {
    // Which is why the loader can stop reading at the fourth column: the quoted
    // tail can never contain a quote of its own to confuse a naive split.
    const row = hitsCsv([{ ecu: 'ECM', did: '1234', len: 2, hex: '2222', ascii: '""' }]);
    expect(row.split('\n')[1]).toBe('ECM,1234,2,2222,""');
  });

  it('round-trips through the Watch page parser', () => {
    // The actual contract. Export here, load there — the two are versioned apart,
    // so this pair is the only thing keeping the column order honest.
    const back = parseCsv(hitsCsv(hits));
    expect(back).toEqual([
      { ecu: 'ECM', did: '1002', len: 4, hex: '00001A2B' },
      { ecu: 'TCM', did: '0140', len: 2, hex: '0F3C' },
    ]);
  });

  it('is a header and nothing else when there is nothing to export', () => {
    expect(hitsCsv([])).toBe('ecu,did,len,hex,ascii');
    expect(parseCsv(hitsCsv([]))).toEqual([]);
  });
});

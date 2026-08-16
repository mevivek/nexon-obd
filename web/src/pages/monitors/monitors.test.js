// Mode 06 decoding.
//
// The page's promise is that a driver can read pass and headroom without knowing
// what the units are, and that nothing is named or converted unless the firmware can
// actually vouch for it. Those two promises are what is pinned here.

import { describe, it, expect } from 'vitest';
import { DASH } from '../../lib/format.js';
import { monFmt, monName, monNote, monStatus, monWindow, MON_POLL_MS } from './monitors.js';

describe('monitor names', () => {
  it('names only the ids J1979 pins down', () => {
    expect(monName('01')).toBe('O2 sensor B1S1');
    expect(monName('21')).toBe('Catalyst bank 1');
    expect(monName('A4')).toBe('Misfire cylinder 4');
  });

  it('an unknown id keeps its raw id rather than a label that might be wrong', () => {
    expect(monName('5C')).toBe('Monitor 5C');
    expect(monName('00')).toBe('Monitor 00');
  });
});

describe('monitor values', () => {
  it('decodes the plain decimal multipliers, with decimals to match', () => {
    expect(monFmt(1234, '01')).toBe('1234');     // x1, no decimals
    expect(monFmt(1234, '02')).toBe('123.4');    // x0.1
    expect(monFmt(1234, '03')).toBe('12.34');    // x0.01 — two places, not three
    expect(monFmt(1234, '04')).toBe('1.234');    // x0.001
  });

  it('says so rather than converting a scaling it does not decode', () => {
    // The rest of the unit-and-scaling table is long and only partly documented, so
    // the raw count is shown and labelled raw. Inventing units here would be a
    // number on a screen that means nothing.
    expect(monFmt(1234, '0B')).toBe('1234 raw');
    expect(monFmt(0, '')).toBe('0 raw');
  });

  it('an absent value is an em-dash, not "NaN raw"', () => {
    expect(monFmt(null, '02')).toBe(DASH);
    expect(monFmt(undefined, '0B')).toBe(DASH);
    expect(monFmt(NaN, '01')).toBe(DASH);
    expect(monFmt(0, '02')).toBe('0.0');         // ...but zero is a reading
  });
});

describe('the window a monitor is judged against', () => {
  it('passes when the value sits inside its own limits, inclusive', () => {
    expect(monWindow({ v: 50, lo: 0, hi: 100 }).pass).toBe(true);
    expect(monWindow({ v: 0, lo: 0, hi: 100 }).pass).toBe(true);
    expect(monWindow({ v: 100, lo: 0, hi: 100 }).pass).toBe(true);
    expect(monWindow({ v: 101, lo: 0, hi: 100 }).pass).toBe(false);
    expect(monWindow({ v: -1, lo: 0, hi: 100 }).pass).toBe(false);
  });

  it('places the marker across the window, unit-free', () => {
    expect(monWindow({ v: 50, lo: 0, hi: 100 }).pos).toBe(50);
    expect(monWindow({ v: 25, lo: 0, hi: 100 }).pos).toBe(25);
    // Works just as well on a window that does not start at zero — which is the
    // point of showing position rather than the raw number.
    expect(monWindow({ v: 300, lo: 200, hi: 600 }).pos).toBe(25);
  });

  it('clamps the marker so a failing value cannot draw outside the bar', () => {
    expect(monWindow({ v: 500, lo: 0, hi: 100 }).pos).toBe(100);
    expect(monWindow({ v: -500, lo: 0, hi: 100 }).pos).toBe(0);
  });

  it('headroom is the distance to the *nearest* limit', () => {
    // A pass with almost no headroom is what this page exists to show, and it is
    // near-failure at either end that matters — not just the top one.
    expect(monWindow({ v: 50, lo: 0, hi: 100 }).head).toBe(50);
    expect(monWindow({ v: 98, lo: 0, hi: 100 }).head).toBeCloseTo(2, 10);
    expect(monWindow({ v: 2, lo: 0, hi: 100 }).head).toBeCloseTo(2, 10);
    // A failing value has no headroom at all rather than a negative one.
    expect(monWindow({ v: 150, lo: 0, hi: 100 }).head).toBe(0);
  });

  it('a degenerate window still reports the ECU\'s verdict, without dividing by zero', () => {
    const eq = monWindow({ v: 5, lo: 5, hi: 5 });
    expect(eq.pass).toBe(true);
    expect(eq.pos).toBe(50);            // parked mid-bar; there is nowhere else
    expect(eq.head).toBe(0);
    expect(monNote({ v: 5, lo: 5, hi: 5 })).toBe('no usable limits reported');

    const inverted = monWindow({ v: 5, lo: 100, hi: 0 });
    expect(inverted.pass).toBe(false);
    expect(inverted.pos).toBe(0);
    expect(Number.isFinite(inverted.head)).toBe(true);
  });

  it('states headroom as a whole percent of the window', () => {
    expect(monNote({ v: 98, lo: 0, hi: 100 }))
      .toBe('2% of the window from the nearest limit');
  });
});

describe('status line', () => {
  it('reads before the first poll lands', () => {
    expect(monStatus(null, false)).toEqual({ dot: 'dot', text: 'reading…' });
  });

  it('discovery is not a failure', () => {
    // The board finds which monitors exist before it can read any, so an empty list
    // in the first few seconds is the normal path — it must not go red.
    expect(monStatus({ ready: false, recs: [] }, false))
      .toEqual({ dot: 'dot', text: 'discovering…' });
  });

  it('distinguishes "found none" from "not looked yet"', () => {
    expect(monStatus({ ready: true, recs: [] }, false).text).toBe('no monitors reported');
  });

  it('counts results once they are in', () => {
    expect(monStatus({ ready: true, recs: [{}, {}, {}] }, false))
      .toEqual({ dot: 'dot live', text: '3 results' });
  });

  it('an unreachable board outranks whatever was last shown', () => {
    expect(monStatus({ ready: true, recs: [{}] }, true))
      .toEqual({ dot: 'dot dead', text: 'ESP32 unreachable' });
  });
});

describe('polling', () => {
  it('re-reads on the firmware page\'s interval', () => {
    // /mon arms the board for MON_WANTED_MS (30 s) per request, so the page has to
    // keep asking well inside that or discovery stops mid-sweep.
    expect(MON_POLL_MS).toBe(2000);
  });
});

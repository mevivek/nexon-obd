// Formatting and derived values.
//
// The firmware suite exercised these only through render(), so the assertions here
// are the ones its DOM checks implied: '1.250' for a lambda, '115' for a coolant
// reading, an em-dash for anything absent, and never a zero standing in for a gap.

import { describe, it, expect } from 'vitest';
import { n, round, signed, boostText, hhmmss, DASH } from './format.js';
import { boost, torqueNm } from './derive.js';

describe('number formatting', () => {
  it('formats to a fixed number of decimals', () => {
    expect(n(1.25, 3)).toBe('1.250');       // as asserted on the lambda gauge
    expect(n(6, 2)).toBe('6.00');
    expect(n(12.345)).toBe('12.3');
  });

  it('an absent value is an em-dash, never a zero', () => {
    // The distinction the whole dashboard turns on. README, "Trip logs": a gap is a
    // gap, not a reading of nought.
    expect(n(null)).toBe(DASH);
    expect(n(undefined)).toBe(DASH);
    expect(n(NaN)).toBe(DASH);
    expect(round(null)).toBe(DASH);
    expect(hhmmss(null)).toBe(DASH);
    expect(n(0)).toBe('0.0');               // ...but zero itself is a reading
    expect(round(0)).toBe('0');
  });

  it('rounds whole-number gauges', () => {
    expect(round(115)).toBe('115');
    expect(round(114.6)).toBe('115');
    expect(round(-0.4)).toBe('-0');         // as Math.round gives it; rpm never
                                            // goes negative, so this is only here
                                            // so a change to it is deliberate.
  });

  it('carries the sign on fuel trims', () => {
    // +8 and -8 differ by one glyph at arm's length, so the plus is explicit.
    expect(signed(8)).toBe('+8.0');
    expect(signed(-8)).toBe('-8.0');
    expect(signed(0)).toBe('0.0');
    expect(signed(null)).toBe(DASH);
  });

  it('boost states which side of atmospheric the manifold is on', () => {
    expect(boostText(0.42)).toBe('+0.42');
    expect(boostText(0)).toBe('+0.00');
    expect(boostText(-0.31)).toBe('-0.31');
    expect(boostText(null)).toBe(DASH);
  });

  it('formats run time', () => {
    expect(hhmmss(0)).toBe('0m 00s');
    expect(hhmmss(65)).toBe('1m 05s');
    expect(hhmmss(3845)).toBe('1h 4m 05s');
  });
});

describe('derived values', () => {
  it('boost is manifold pressure against ambient', () => {
    expect(boost({ map: 142, baro: 100 }, {}).bar).toBeCloseTo(0.42, 10);
    expect(boost({ map: 40, baro: 100 }, {}).bar).toBeCloseTo(-0.6, 10);
  });

  it('boost needs both inputs', () => {
    expect(boost({ map: 142, baro: null }, {}).bar).toBe(null);
    expect(boost({ map: null, baro: 100 }, {}).bar).toBe(null);
  });

  it('boost is only as fresh as the staler of its two inputs', () => {
    // The derived value inherits staleness from both, or a fresh MAP against a held
    // barometric would present a boost figure the car never made.
    expect(boost({ map: 142, baro: 100 }, { map: 0, baro: 1 }).stale).toBe(true);
    expect(boost({ map: 142, baro: 100 }, { map: 1, baro: 0 }).stale).toBe(true);
    expect(boost({ map: 142, baro: 100 }, { map: 0, baro: 0 }).stale).toBe(false);
  });

  it('torque in newton-metres needs the reference torque', () => {
    // PIDs 61/62 are a percentage of PID 63, so without 63 there is no figure —
    // and an empty note, not a zero.
    expect(torqueNm(50, 240, 0)).toBe('120 N·m');
    expect(torqueNm(50, null, 0)).toBe('');
    expect(torqueNm(null, 240, 0)).toBe('');
    // A held percentage produces no note at all rather than a stale N·m figure.
    expect(torqueNm(50, 240, 1)).toBe('');
  });
});

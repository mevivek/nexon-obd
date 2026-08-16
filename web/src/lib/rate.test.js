// Ported from suiteRate in firmware/test/test_dashboard.mjs.
//
// Trailing window, not a lifetime average: a slow patch has to wash out of the
// reading once polling recovers, which the old cumulative average never did.

import { describe, it, expect } from 'vitest';
import { hz, rateHz, pushSample, RATE_WINDOW } from './rate.js';

describe('rate readout', () => {
  it('hz() returns a string', () => {
    // The original suite's only assertion here — the readout goes into textContent,
    // so it must never be undefined or a number.
    expect(typeof hz([])).toBe('string');
    expect(typeof hz([1000, 2000])).toBe('string');
  });

  it('says nothing until there is an interval to divide by', () => {
    expect(hz([])).toBe('');
    expect(hz([1000])).toBe('');
    // Two samples in the same millisecond is a division by zero, not an infinite
    // refresh rate.
    expect(hz([1000, 1000])).toBe('');
  });

  it('counts intervals, not samples', () => {
    // Eleven timestamps one second apart is ten intervals over ten seconds: 1 Hz.
    // Dividing by the sample count instead would report 1.1 Hz, which is the kind
    // of quietly-wrong number nobody ever checks.
    const rate = [];
    for (let i = 0; i < 11; i++) rate.push(1000 + i * 1000);
    expect(hz(rate)).toBe('· 1.0 Hz');
    expect(rateHz(rate)).toBe(1);
  });

  it('a slow patch washes out of the reading', () => {
    // This is the whole point of the trailing window. A five-second stall followed
    // by a recovery must not leave the readout depressed for the rest of the drive.
    const rate = [];
    pushSample(rate, 0);
    pushSample(rate, 5000);                       // the stall
    for (let i = 1; i <= 30; i++) pushSample(rate, 5000 + i * 100);
    expect(rate.length).toBe(RATE_WINDOW);        // the stall has fallen off the end
    expect(rateHz(rate)).toBeCloseTo(10, 5);
  });

  it('the window is bounded', () => {
    const rate = [];
    for (let i = 0; i < RATE_WINDOW * 3; i++) pushSample(rate, i * 100);
    expect(rate.length).toBe(RATE_WINDOW);
    // ...and it drops the oldest, not the newest.
    expect(rate[rate.length - 1]).toBe((RATE_WINDOW * 3 - 1) * 100);
  });
});

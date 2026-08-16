// Ported from suiteMerge and suiteHold in firmware/test/test_dashboard.mjs.
//
// The comments are carried over deliberately: each one records a bug that was seen
// on the car, and the assertion is only meaningful with the reason attached.

import { describe, it, expect } from 'vitest';
import { createHold, holdWindowMs, HOLD_FLOOR_MS, HOLD_CEIL_MS } from './hold.js';

// ------------------------------------------------------------ suiteMerge
//
// The firmware suite drives one long-lived merger through a sequence of samples,
// because what is being tested is exactly the memory between them.
describe('hold-last-value', () => {
  const m = createHold();

  it('fresh value passes through', () => {
    const [v, q, held] = m.merge({ rpm: 820, coolant: 88 });
    expect(v.rpm).toBe(820);
    // 'fresh value is not marked held'
    expect(q.rpm).toBeFalsy();
    // 'nothing held on a complete sample'
    expect(held).toBe(0);
  });

  it('held value re-shown instead of null', () => {
    const [v, q, held] = m.merge({ rpm: null, coolant: null });
    expect(v.rpm).toBe(820);
    // 'held value is marked so it renders dimmed'
    expect(q.rpm).toBeTruthy();
    // 'header reports how many are being held'
    expect(held).toBe(2);
  });

  it('fresh value supersedes the held one', () => {
    const [v, q] = m.merge({ rpm: 1500, coolant: null });
    expect(v.rpm).toBe(1500);
    // 'mark cleared'
    expect(q.rpm).toBeFalsy();
    // 'the still-missing field stays marked'
    expect(q.coolant).toBeTruthy();
  });

  it('a field never seen has nothing to hold', () => {
    const [v, q] = m.merge({ neverSeen: null });
    expect(v.neverSeen).toBe(null);
    // 'and is marked'
    expect(q.neverSeen).toBeTruthy();
  });

  it('NaN falls back to the held value', () => {
    // Not redundant with the null case: a timed-out batch can publish either, and
    // NaN slips past a `!= null` check on its own.
    m.merge({ oil: 95 });
    const [v, q] = m.merge({ oil: NaN });
    expect(v.oil).toBe(95);
    // 'and is marked'
    expect(q.oil).toBeTruthy();
  });

  it('zero passes through as a fresh reading', () => {
    m.merge({ speed: 42 });
    const [v, q] = m.merge({ speed: 0 });
    expect(v.speed).toBe(0);
    // 'zero is not treated as absent' — a stationary car reads 0 km/h, and holding
    // 42 through a red light would be a lie about the car, not about the link.
    expect(q.speed).toBeFalsy();
  });

  it('a value older than the hold window reverts to nothing', () => {
    // The firmware suite tried to age the clock by calling merge({}) six thousand
    // times, which is a no-op — an empty sample has no keys to walk. Injecting the
    // clock lets the expiry actually be tested, which is the half of the contract
    // that keeps a dead field from looking alive.
    let t = 1_000_000;
    const h = createHold({ now: () => t });
    h.merge({ coolant: 88 });
    t += HOLD_FLOOR_MS;                      // exactly on the boundary: still held
    expect(h.merge({ coolant: null })[0].coolant).toBe(88);
    t += 1;                                  // one millisecond past it
    const [v, q] = h.merge({ coolant: null });
    expect(v.coolant).toBe(null);
    expect(q.coolant).toBeTruthy();
  });
});

// ------------------------------------------------------------ suiteHold
describe('hold window follows the sample rate', () => {
  it('holdMs is exported', () => {
    expect(typeof holdWindowMs).toBe('function');
    expect(typeof createHold().holdMs).toBe('function');
  });

  it('falls back to the floor before a rate is known', () => {
    expect(holdWindowMs([])).toBe(2500);
    expect(HOLD_FLOOR_MS).toBe(2500);
  });

  it('a fast link keeps the floor', () => {
    // Samples 100 ms apart. Four of them is 400 ms, which is not long enough to be
    // worth holding for; the floor still applies.
    const rate = [];
    for (let i = 0; i < 10; i++) rate.push(1000 + i * 100);
    expect(holdWindowMs(rate)).toBe(2500);
  });

  it('a slow link holds for several samples', () => {
    // Slow BLE link: samples 2 s apart. A fixed 2.5 s window is barely one sample,
    // so a field that simply has not come round yet blinks to an em-dash — which is
    // exactly what made the All values table flicker.
    const rate = [];
    for (let i = 0; i < 10; i++) rate.push(1000 + i * 2000);
    expect(holdWindowMs(rate)).toBe(8000);
  });

  it('and is capped', () => {
    // ...but never so long that a genuinely dead field looks alive.
    const rate = [];
    for (let i = 0; i < 10; i++) rate.push(1000 + i * 60000);
    expect(holdWindowMs(rate)).toBe(15000);
    expect(HOLD_CEIL_MS).toBe(15000);
  });

  it('the merger reads the same rate array the Hz readout fills', () => {
    // Shared by reference on purpose: the hold window has to track the *observed*
    // sample interval, and the only thing that observes it is the poll loop.
    const rate = [];
    const h = createHold({ rate });
    expect(h.holdMs()).toBe(2500);
    for (let i = 0; i < 10; i++) rate.push(1000 + i * 2000);
    expect(h.holdMs()).toBe(8000);
  });
});

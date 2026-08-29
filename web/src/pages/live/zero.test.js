import { describe, it, expect } from 'vitest';
import { boostBar, BOOST_MIN, BOOST_MAX, ZERO_AT } from './zero.js';

describe('boost bar', () => {
  it('draws nothing at all for a missing reading', () => {
    // Absent and "exactly atmospheric" are different states. A zero-width bar
    // sitting on the zero mark is what a real 0.00 bar looks like, so returning one
    // for a missing value would draw a reading the ECU never sent — the same class
    // of bug as null coercing to 0 in flags.js.
    expect(boostBar(null)).toBe(null);
    expect(boostBar(undefined)).toBe(null);
    expect(boostBar(NaN)).toBe(null);
  });

  it('puts atmospheric on the zero mark with no width', () => {
    const b = boostBar(0);
    expect(b.left).toBeCloseTo(ZERO_AT * 100, 6);
    expect(b.width).toBeCloseTo(0, 6);
  });

  it('grows right under boost and left under vacuum', () => {
    // The whole point of the control: the direction has to be readable before the
    // digits are.
    const up = boostBar(0.5);
    const down = boostBar(-0.5);
    expect(up.left).toBeCloseTo(ZERO_AT * 100, 6);
    expect(up.width).toBeGreaterThan(0);
    expect(down.left).toBeLessThan(ZERO_AT * 100);
    expect(down.left + down.width).toBeCloseTo(ZERO_AT * 100, 6);
  });

  it('never returns a negative width', () => {
    for (const v of [-2, -1, -0.3, 0, 0.3, 1, 5]) {
      expect(boostBar(v).width).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps beyond the scale instead of overflowing the track', () => {
    // An overboost or a sensor fault must not draw past the end of the bar.
    const over = boostBar(BOOST_MAX + 3);
    expect(over.left + over.width).toBeCloseTo(100, 6);
    const under = boostBar(BOOST_MIN - 3);
    expect(under.left).toBeCloseTo(0, 6);
    expect(under.left + under.width).toBeCloseTo(ZERO_AT * 100, 6);
  });

  it('the floor is the physical one', () => {
    // Boost is (MAP − barometric)/100, so a manifold at a perfect vacuum reads −1.0
    // at sea level. A scale that went lower would leave dead track nothing can
    // reach; one that stopped higher would clip a real reading on the overrun.
    expect(BOOST_MIN).toBe(-1.0);
    expect(BOOST_MAX).toBeGreaterThan(1.0);
    expect(ZERO_AT).toBeGreaterThan(0);
    expect(ZERO_AT).toBeLessThan(1);
  });
});

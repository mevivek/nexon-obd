import { describe, it, expect } from 'vitest';
import { arc, dialPaths, rpmFraction, DIAL, RPM_FULL } from './dial.js';

const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

describe('rpm dial', () => {
  it('the track is always drawn', () => {
    // Whatever the reading, the empty dial has to be visible: a gauge that vanishes
    // reads as a broken page rather than a missing value.
    for (const f of [null, undefined, NaN, 0, 0.5, 9]) {
      expect(dialPaths(f).track).toBe(dialPaths(0.5).track);
      expect(dialPaths(f).track).toMatch(/^M /);
    }
  });

  it('a missing rpm does not poison the path with NaN', () => {
    // null/6500 is 0, but undefined/6500 is NaN, and Math.min(1,NaN) is NaN — one
    // NaN in the d attribute makes the browser drop the whole path.
    const p = dialPaths(undefined / RPM_FULL);
    expect(p.value).toBe('');
    expect(p.track).not.toMatch(/NaN/);
  });

  it('draws nothing at rest', () => {
    // The round line-cap alone is a visible blob on a dial reading zero.
    expect(dialPaths(0).value).toBe('');
    expect(dialPaths(0.0005).value).toBe('');
    expect(dialPaths(0.01).value).not.toBe('');
  });

  it('clamps over-range readings to a full sweep', () => {
    expect(dialPaths(4).value).toBe(dialPaths(1).value);
    expect(dialPaths(-3).value).toBe('');
  });

  it('a full sweep ends where the track ends', () => {
    const full = dialPaths(1);
    expect(full.value).toBe(full.track);
  });

  it('sets the large-arc flag only past half sweep', () => {
    // Below 180° the short way round is correct; above it the long way. Getting this
    // backwards draws the complement of the reading, which looks plausible.
    const short = arc(64, 64, 52, 135, 135 + 179);
    const long = arc(64, 64, 52, 135, 135 + 181);
    // M x0 y0 A r r rot largeArc sweep x1 y1
    expect(short.split(' ')[7]).toBe('0');
    expect(long.split(' ')[7]).toBe('1');
  });

  it('starts at the bottom left of the box', () => {
    const [x0, y0] = nums(arc(64, 64, 52, DIAL.start, DIAL.start + DIAL.sweep));
    expect(x0).toBeLessThan(64);
    expect(y0).toBeGreaterThan(64);
  });

  it('half scale ends at the top of the dial', () => {
    // 135° + 135° = 270°, straight up in SVG's y-down space.
    const p = dialPaths(0.5).value;
    const n = nums(p);
    const [x1, y1] = [n[n.length - 2], n[n.length - 1]];
    expect(x1).toBeCloseTo(DIAL.cx, 1);
    expect(y1).toBeCloseTo(DIAL.cy - DIAL.r, 1);
  });

  it('full scale is above the redline flag', () => {
    // The dial must not top out before the warning that matters lights (flags.js
    // raises "approaching redline" at 5500).
    expect(RPM_FULL).toBeGreaterThan(5500);
    expect(rpmFraction(5500)).toBeLessThan(1);
    expect(rpmFraction(null)).toBe(0);
  });
});

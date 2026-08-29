import { describe, it, expect } from 'vitest';
import { arc, dialPaths, rpmFraction, DIAL, VIEW, RPM_FULL, REDLINE_FRACTION } from './dial.js';
import { T } from '../../lib/flags.js';

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

  it('starts due left of the centre and ends due right of it', () => {
    // The 270° dial started below the centre, at bottom-left. The sweep is a half
    // turn, so both ends sit on the centre line with the arc over the top — and the
    // whole gauge lives in the top half of its box, which is what lets the speed
    // numeral sit inside it without fouling the stroke.
    const n = nums(arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.start, DIAL.start + DIAL.sweep));
    const [x0, y0] = [n[0], n[1]];
    const [x1, y1] = [n[n.length - 2], n[n.length - 1]];
    expect(x0).toBeCloseTo(DIAL.cx - DIAL.r, 1);
    expect(y0).toBeCloseTo(DIAL.cy, 1);
    expect(x1).toBeCloseTo(DIAL.cx + DIAL.r, 1);
    expect(y1).toBeCloseTo(DIAL.cy, 1);
  });

  it('fits the viewBox it is drawn for', () => {
    // The arc's top is cy - r; anything above the box would be clipped, and any
    // slack below the ends is dead space under the numeral.
    expect(DIAL.cy - DIAL.r).toBeGreaterThanOrEqual(0);
    expect(DIAL.cx + DIAL.r).toBeLessThanOrEqual(VIEW.w);
    expect(DIAL.cy).toBeLessThanOrEqual(VIEW.h);
  });

  it('half scale ends at the top of the gauge', () => {
    // 180° + 90° = 270°, straight up in SVG's y-down space.
    const p = dialPaths(0.5).value;
    const n = nums(p);
    const [x1, y1] = [n[n.length - 2], n[n.length - 1]];
    expect(x1).toBeCloseTo(DIAL.cx, 1);
    expect(y1).toBeCloseTo(DIAL.cy - DIAL.r, 1);
  });

  it('the redline band covers exactly the top of the range', () => {
    // It has to start where flags.js starts warning, or the band and the warning
    // disagree about where the redline is — and the band is the one you see first.
    expect(REDLINE_FRACTION).toBeCloseTo(T.RPM_REDLINE / RPM_FULL, 6);
    const band = dialPaths(0).redline;
    const full = dialPaths(1);
    const bn = nums(band), fn = nums(full.value);
    // Ends with the track, starts short of it.
    expect(bn[bn.length - 2]).toBeCloseTo(fn[fn.length - 2], 1);
    expect(bn[bn.length - 1]).toBeCloseTo(fn[fn.length - 1], 1);
    expect(bn[0]).toBeGreaterThan(DIAL.cx);
    // Drawn whatever the reading is, including none: it is the scale, not a value.
    expect(dialPaths(null).redline).toBe(band);
  });

  it('full scale is above the redline flag', () => {
    // The dial must not top out before the warning that matters lights (flags.js
    // raises "approaching redline" at 5500).
    expect(RPM_FULL).toBeGreaterThan(5500);
    expect(rpmFraction(5500)).toBeLessThan(1);
    expect(rpmFraction(null)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { sparkPath, SPARK_W, SPARK_H, SPARK_PAD } from './spark.js';

const ys = (p) => p.points.split(' ').map((s) => Number(s.split(',')[1]));
const xs = (p) => p.points.split(' ').map((s) => Number(s.split(',')[0]));

describe('sparkline geometry', () => {
  it('draws nothing from a single point', () => {
    // One reading is not a trend, and a one-point polyline is an invisible dot.
    expect(sparkPath([5], false)).toBeNull();
    expect(sparkPath([], false)).toBeNull();
  });

  it('spans the full width regardless of sample count', () => {
    for (const len of [2, 7, 600]) {
      const p = sparkPath(Array.from({ length: len }, (_, i) => i), false);
      const x = xs(p);
      expect(x[0]).toBe(0);
      expect(x[x.length - 1]).toBeCloseTo(SPARK_W, 1);
    }
  });

  it('y is inverted — the maximum sits at the top', () => {
    const p = sparkPath([0, 10], false);
    const y = ys(p);
    expect(y[0]).toBe(SPARK_H - SPARK_PAD);
    expect(y[1]).toBe(SPARK_PAD);
  });

  it('keeps peaks inside the tile', () => {
    const p = sparkPath([-40, 0, 999], false);
    for (const y of ys(p)) {
      expect(y).toBeGreaterThanOrEqual(SPARK_PAD);
      expect(y).toBeLessThanOrEqual(SPARK_H - SPARK_PAD);
    }
  });

  it('a flat run draws a flat line, not a NaN', () => {
    // hi-lo is zero here; without the epsilon guard every point divides by nothing
    // and the browser drops the polyline entirely.
    const p = sparkPath([88, 88, 88], false);
    for (const y of ys(p)) expect(Number.isFinite(y)).toBe(true);
    expect(new Set(ys(p)).size).toBe(1);
  });

  it('zero-based scaling flattens an idling engine', () => {
    // 780-810 rpm is a car sitting still. Auto-scaled it is a mountain range; pinned
    // to zero it is the flat line the driver expects to see.
    const auto = ys(sparkPath([780, 810], false));
    const zero = ys(sparkPath([780, 810], true));
    expect(Math.abs(auto[0] - auto[1])).toBe(SPARK_H - 2 * SPARK_PAD);
    expect(Math.abs(zero[0] - zero[1])).toBeLessThan(1);
  });

  it('does not pin boost to zero — vacuum is half the gauge', () => {
    // Boost runs negative on a lifted throttle, so its floor has to follow the data.
    const p = sparkPath([-0.6, -0.2], false);
    expect(ys(p)[0]).toBe(SPARK_H - SPARK_PAD);
  });

  it('reports a viewBox matching the drawn space', () => {
    expect(sparkPath([1, 2], false).viewBox).toBe(`0 0 ${SPARK_W} ${SPARK_H}`);
  });
});

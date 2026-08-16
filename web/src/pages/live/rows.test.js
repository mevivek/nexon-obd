// The all-values table. The bug this guards against is the quiet one: a row that
// shows another PID's number. It looks like data, so nothing about the page says it
// is wrong — the firmware built the tbody by index and then wrote cells by index,
// and the two lists only had to drift by one.

import { describe, it, expect } from 'vitest';
import { ROWS, rowCells } from './rows.js';

describe('all-values table', () => {
  it('every row names a distinct PID field', () => {
    const keys = ROWS.map((r) => r[2]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rows come back in ROWS order, one per entry', () => {
    const cells = rowCells({}, {});
    expect(cells.length).toBe(ROWS.length);
    cells.forEach((c, i) => {
      expect(c.pid).toBe(ROWS[i][0]);
      expect(c.name).toBe(ROWS[i][1]);
      expect(c.unit).toBe(ROWS[i][3]);
    });
  });

  it('row i shows the value of the PID row i names', () => {
    // Each field gets a value only it could have, so a one-row shift is visible.
    const v = {};
    ROWS.forEach(([, , key], i) => { v[key] = i + 1; });
    const cells = rowCells(v, {});
    cells.forEach((c, i) => {
      expect(Number(c.text)).toBe(i + 1);
    });
  });

  it('uses each parameter\'s own precision', () => {
    const v = { rpm: 2143.7, lambda: 0.9876, volt: 14.123, boost: 0.456, load: 33.33 };
    const by = Object.fromEntries(rowCells(v, {}).map((c) => [c.key, c.text]));
    expect(by.rpm).toBe('2144');       // whole rpm; a tenth of an rpm is noise
    expect(by.lambda).toBe('0.988');   // three places; the interesting digits are small
    expect(by.volt).toBe('14.12');
    expect(by.boost).toBe('0.46');
    expect(by.load).toBe('33.3');
  });

  it('a missing value is an em-dash, never a zero', () => {
    const by = Object.fromEntries(rowCells({ rpm: null, speed: undefined }, {}).map((c) => [c.key, c.text]));
    expect(by.rpm).toBe('—');
    expect(by.speed).toBe('—');
    expect(by.cat).toBe('—');
  });

  it('the value cell carries num, and num stale when held', () => {
    const cells = rowCells({ rpm: 800, speed: 0 }, { rpm: 1 });
    const by = Object.fromEntries(cells.map((c) => [c.key, c.cls]));
    expect(by.rpm).toBe('num stale');
    expect(by.speed).toBe('num');
  });

  it('lists derived boost with no PID of its own', () => {
    // It is MAP against barometric, not something the ECU reports, and the table has
    // to say so rather than invent an identifier for it.
    const boost = ROWS.find((r) => r[2] === 'boost');
    expect(boost[0]).toBe('—');
    expect(boost[1]).toBe('Boost (derived)');
  });

  it('reports run time in raw seconds here', () => {
    // The tile above formats it as 1h 4m 07s; this table is the diagnostic view and
    // shows the number the ECU actually returned.
    const c = rowCells({ runtime: 3847 }, {}).find((x) => x.key === 'runtime');
    expect(c.text).toBe('3847');
    expect(c.unit).toBe('s');
  });
});

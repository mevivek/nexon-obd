// One point per reading, and where the line goes.

import { describe, it, expect } from 'vitest';
import { pushReadings, sparkPoints, MAX_PTS } from './series.js';

const d = (name, val, age, extra) => ({ name, val, age, len: 2, fresh: true, ...extra });

describe('pushing readings', () => {
  it('takes a point per reading, not per poll', () => {
    // The whole reason this function exists. The page polls at 700 ms; an
    // identifier read once a second is reported by three or four consecutive polls
    // with a *rising* age. Pushing on each of those draws a staircase whose steps
    // are a fact about the polling interval, not about the car.
    const hist = {}, age = {};
    pushReadings(hist, age, [d('E1002', 10, 120)]);
    pushReadings(hist, age, [d('E1002', 10, 820)]);   // same reading, older
    pushReadings(hist, age, [d('E1002', 10, 1520)]);  // still the same reading
    pushReadings(hist, age, [d('E1002', 11, 90)]);    // age dropped: a new reply
    expect(hist.E1002).toEqual([10, 11]);
  });

  it('starts a trace on the first reading, with no previous age to compare', () => {
    const hist = {}, age = {};
    pushReadings(hist, age, [d('E1002', 7, 300)]);
    expect(hist.E1002).toEqual([7]);
  });

  it('records a repeated value when it is genuinely re-read', () => {
    // A flat trace is a finding — this identifier does not move with the engine.
    // It has to be distinguishable from one that stopped answering.
    const hist = {}, age = {};
    pushReadings(hist, age, [d('E1002', 5, 400)]);
    pushReadings(hist, age, [d('E1002', 5, 100)]);
    expect(hist.E1002).toEqual([5, 5]);
  });

  it('ignores an identifier with no reply, and one gone stale', () => {
    const hist = {}, age = {};
    pushReadings(hist, age, [{ name: 'E1002', len: 0, fresh: false }]);
    pushReadings(hist, age, [d('E1003', 9, 100, { fresh: false })]);
    expect(hist.E1002).toBeUndefined();
    expect(hist.E1003).toBeUndefined();
  });

  it('still tracks age for a stale identifier, so its first fresh reply lands', () => {
    const hist = {}, age = {};
    pushReadings(hist, age, [d('E1002', 9, 5000, { fresh: false })]);
    pushReadings(hist, age, [d('E1002', 9, 100)]);
    expect(hist.E1002).toEqual([9]);
  });

  it('keeps the traces of several identifiers apart', () => {
    const hist = {}, age = {};
    pushReadings(hist, age, [d('E1002', 1, 400), d('T0140', 100, 400)]);
    pushReadings(hist, age, [d('E1002', 2, 100), d('T0140', 100, 900)]);
    expect(hist.E1002).toEqual([1, 2]);
    expect(hist.T0140).toEqual([100]);
  });

  it('drops the oldest point past the window', () => {
    const hist = { E1002: [] }, age = {};
    for (let i = 0; i < MAX_PTS + 5; i++) pushReadings(hist, age, [d('E1002', i, 1000 - i)]);
    expect(hist.E1002).toHaveLength(MAX_PTS);
    expect(hist.E1002[0]).toBe(5);
    expect(hist.E1002[MAX_PTS - 1]).toBe(MAX_PTS + 4);
  });

  it('survives an empty or absent list', () => {
    expect(pushReadings({}, {}, [])).toEqual({});
    expect(pushReadings({}, {}, undefined)).toEqual({});
  });
});

describe('sparkline geometry', () => {
  it('draws nothing until there are two points to join', () => {
    expect(sparkPoints([])).toBe('');
    expect(sparkPoints([5])).toBe('');
    expect(sparkPoints(undefined)).toBe('');
  });

  it('scales to the series own range, top to bottom, inside the padding', () => {
    // Auto-scaled because nobody knows what range an unknown identifier lives in;
    // a fixed axis would flatten most of them to a straight line.
    expect(sparkPoints([0, 10], 100, 26, 3)).toBe('0.0,23.0 100.0,3.0');
  });

  it('lays points out evenly across the width', () => {
    expect(sparkPoints([0, 5, 10], 100, 26, 3)).toBe('0.0,23.0 50.0,13.0 100.0,3.0');
  });

  it('draws a flat series along the bottom rather than dividing by zero', () => {
    // The honest picture of a value that is not moving — and not a NaN path, which
    // renders as nothing at all and looks like a broken page.
    expect(sparkPoints([4, 4, 4], 100, 26, 3)).toBe('0.0,23.0 50.0,23.0 100.0,23.0');
  });
});

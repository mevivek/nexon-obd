// Three pollers, one pill.
//
// The ordering is not cosmetic. Only one of these can hold the bus at a time, and
// the two that are not holding it are showing values that stopped updating when the
// third took over - so a pill that picks the wrong one describes stale data as
// current, which is the failure this whole project keeps coming back to.

import { describe, it, expect } from 'vitest';
import { discoverPill } from './pill.js';

const OFF     = { dot: 'dot', text: 'not running' };
const RUNNING = { dot: 'dot live', text: 'sweep', extra: '31%' };
const HOLDING = { dot: 'dot stale', text: 'holding', extra: 'triage' };
const IDLE    = { dot: 'dot', text: 'idle' };
const SCANNING = { dot: 'dot live', text: 'scanning' };
const WATCHED = { dot: 'dot live', text: '3 watched' };
const DEAD    = { dot: 'dot dead', text: 'ESP32 unreachable' };

describe('discoverPill', () => {
  it('reports the autopilot while it is running', () => {
    // It subsumes the other two - the sweep IS the autopilot's sweep - and saying
    // both would describe one activity twice in two vocabularies.
    expect(discoverPill(RUNNING, SCANNING, WATCHED)).toBe(RUNNING);
    expect(discoverPill(HOLDING, IDLE, WATCHED)).toBe(HOLDING);
  });

  it('falls through to a manual sweep when the autopilot is off', () => {
    expect(discoverPill(OFF, SCANNING, WATCHED)).toBe(SCANNING);
    expect(discoverPill(OFF, { dot: 'dot stale', text: 'waiting for ECU' }, WATCHED).text)
      .toBe('waiting for ECU');
  });

  it('prefers a sweep over the watch, because a sweep stops the watch dead', () => {
    // The values on the watch cards are the last ones read and can sit there for
    // the hours a full sweep takes.
    expect(discoverPill(OFF, SCANNING, WATCHED)).toBe(SCANNING);
  });

  it('reports the watch once nothing else is running', () => {
    expect(discoverPill(OFF, IDLE, WATCHED)).toBe(WATCHED);
  });

  it('falls back to idle rather than to nothing', () => {
    expect(discoverPill(OFF, IDLE, IDLE)).toBe(IDLE);
    expect(discoverPill(null, null, null)).toBe(null);
  });

  it('lets an unreachable board through from whichever poll noticed', () => {
    // The one that must outrank everything: a cached "3 watched" beside a board
    // that has stopped answering is a lie the page tells with a green dot.
    expect(discoverPill(RUNNING, IDLE, DEAD)).toBe(DEAD);
    expect(discoverPill(OFF, DEAD, WATCHED)).toBe(DEAD);
    expect(discoverPill(DEAD, SCANNING, WATCHED)).toBe(DEAD);
  });

  it('does not mistake a first poll for activity', () => {
    const reading = { dot: 'dot', text: 'reading' };
    expect(discoverPill(reading, IDLE, IDLE)).toBe(IDLE);
    expect(discoverPill(OFF, IDLE, { dot: 'dot', text: 'reading…' })).toBe(IDLE);
  });
});

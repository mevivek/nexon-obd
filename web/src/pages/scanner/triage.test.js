// The triage panel's arithmetic.
//
// The rule underneath most of these: the panel may state what was observed and must
// not imply a conclusion the run has not earned. "Varies" is proof; "constant" is
// the absence of proof and is always qualified; an estimate that is known to be
// optimistic says so rather than being quoted as a time.

import { describe, it, expect } from 'vitest';
import {
  readRate, readProgress, readsEta, tallyText, triageStatus, CONDITIONS_NOTE,
} from './triage.js';

/** A run part-way through, shaped like /didmap's head. */
const RUN = {
  on: true, passes: 7, reads: 730, turn: 30, needed: 10, elapsed: 300,
  total: 214, unknown: 76, constant: 0, varies: 138, identified: 0,
};

describe('readRate', () => {
  it('is reads per second', () => {
    expect(readRate(600, 300)).toBeCloseTo(2);
  });

  it('says nothing before there is an interval to divide by', () => {
    expect(readRate(10, 0)).toBe(0);
    expect(readRate(0, 0)).toBe(0);
    expect(readRate(10, undefined)).toBe(0);
    expect(readRate('x', 5)).toBe(0);
  });
});

describe('readProgress', () => {
  it('measures reads against the reads actually needed', () => {
    // 214 identifiers needing 10 reads each is 2140, and 730 of those is ~34%.
    expect(readProgress(730, 214, 10)).toBeCloseTo(730 / 2140);
  });

  it('does not measure passes, because passes overstate the work done', () => {
    // Roughly half the identifiers fail to answer on any given pass - this adapter
    // drops replies - so "7 passes of 10" is far more optimistic than the truth.
    // Seven passes here is a third of the reads, not seven tenths.
    expect(readProgress(RUN.reads, RUN.total, RUN.needed)).toBeLessThan(0.4);
  });

  it('is clamped, and safe on nonsense', () => {
    expect(readProgress(9999, 10, 1)).toBe(1);
    expect(readProgress(-5, 10, 1)).toBe(0);
    expect(readProgress(5, 0, 10)).toBe(0);
    expect(readProgress(5, 10, 0)).toBe(0);
  });
});

describe('readsEta', () => {
  it('is quoted as a floor, never as a time', () => {
    // The estimate assumes every identifier keeps answering at the average rate, and
    // the ones that answer rarely are exactly the ones still short when the average
    // says done. Quoting it as "12:00 remaining" would be a number nobody can trust.
    const t = readsEta(730, 214, 10, 300);
    expect(t).toMatch(/^at least /);
    expect(t).toMatch(/more$/);
  });

  it('says nothing when it cannot know', () => {
    expect(readsEta(0, 214, 10, 0)).toBe('');
    expect(readsEta(730, 0, 10, 300)).toBe('');
  });

  it('says nothing once the reads are in', () => {
    expect(readsEta(2140, 214, 10, 300)).toBe('');
    expect(readsEta(9999, 214, 10, 300)).toBe('');
  });
});

describe('tallyText', () => {
  it('leads with what is proven', () => {
    // One observed change is proof and does not weaken. It goes first.
    expect(tallyText(RUN)).toMatch(/^138 vary/);
    expect(tallyText(RUN)).toContain('76 undecided of 214');
  });

  it('never calls an unchanged reading constant', () => {
    // "constant" would be a claim about the car. What was actually observed is that
    // it has not changed yet, under whatever conditions happened to apply.
    const t = tallyText({ ...RUN, constant: 40, unknown: 36 });
    expect(t).toContain('40 unchanged so far');
    expect(t).not.toMatch(/\bconstant\b/);
  });

  it('omits the counts that are zero rather than printing noise', () => {
    expect(tallyText(RUN)).not.toContain('identified');
    expect(tallyText(RUN)).not.toContain('unchanged');
  });

  it('says what is wrong when there is nothing to triage', () => {
    expect(tallyText({ total: 0 })).toBe('nothing to triage - run a sweep first');
    expect(tallyText(null)).toBe('');
  });
});

describe('triageStatus', () => {
  it('tells armed apart from running', () => {
    // Both are ordinary states - starting before turning the key is reasonable - but
    // a run doing nothing must not look like one that is working.
    expect(triageStatus({ ...RUN, reads: 0 }, false).text).toMatch(/armed/);
    expect(triageStatus({ ...RUN, reads: 0 }, false).dot).toBe('dot stale');
    expect(triageStatus(RUN, false).text).toBe('triage · pass 7');
    expect(triageStatus(RUN, false).dot).toBe('dot live');
  });

  it('reports idle and unreachable differently', () => {
    expect(triageStatus({ ...RUN, on: false }, false).text).toBe('triage idle');
    expect(triageStatus(RUN, true).dot).toBe('dot dead');
  });

  it('reports nothing before the first reply', () => {
    expect(triageStatus(null, false)).toBe(null);
  });
});

describe('the conditions caveat', () => {
  it('names the thing that decides what the result is worth', () => {
    // The run's conditions cannot be recovered from the numbers afterwards, so the
    // warning has to be in front of someone while it is still running.
    expect(CONDITIONS_NOTE).toMatch(/idling/i);
    expect(CONDITIONS_NOTE).toMatch(/load|throttle|speed/i);
  });
});

// What the discovery panel is allowed to say.
//
// The firmware keeps three states for every question - yes, no, and not asked -
// and the only thing that can waste that is a page that renders the last two the
// same. "Your car cannot report this" and "nothing has come back yet" send somebody
// to completely different places: one is a fact to accept, the other is a reason to
// go and start the engine.

import { describe, it, expect } from 'vitest';
import {
  discoveryStatus, identityRows, pidTally, pidText, unsupportedPids,
  tcmText, blocksText,
} from './vehicle.js';

const DONE = {
  ok: true, done: true, step: 13, steps: 13, ecu: 'answering',
  vin: 'MAT625123ABC12345', cal: 'SW1234', cvn: '12AB00FF', key: '1f3c9a20',
  vinRefused: false, calRefused: false, tcm: 'answering',
  blocks: [{ base: 0, known: true, mask: 'BE3EA813' }, { base: 32, known: true, mask: '80000000' },
           { base: 64, known: false, mask: '' }],
  polled: [
    { pid: '0C', state: 'yes' }, { pid: '0D', state: 'yes' },
    { pid: '5C', state: 'no' }, { pid: '61', state: 'unknown' },
  ],
};

describe('discoveryStatus', () => {
  it('separates a finished walk from one that has not started', () => {
    expect(discoveryStatus(DONE).text).toBe('discovered');
    expect(discoveryStatus({ ...DONE, done: false }).text).toBe('asking');
  });

  it('says what it is waiting for rather than looking stuck', () => {
    const s = discoveryStatus({ ...DONE, done: false, ecu: 'silent', step: 3 });
    expect(s.text).toBe('waiting for the car');
    expect(s.extra).toBe('3/13');
  });

  it('distinguishes no answer from no data', () => {
    expect(discoveryStatus(null, 'boom').text).toBe('no answer');
    expect(discoveryStatus(null).text).toBe('reading');
  });
});

describe('identityRows', () => {
  it('shows what was found', () => {
    const r = identityRows(DONE);
    expect(r.find((x) => x.label === 'VIN').value).toBe('MAT625123ABC12345');
    expect(r.find((x) => x.label === 'Backup key').value).toBe('1f3c9a20');
  });

  it('reads a refusal as a fact about the car', () => {
    const r = identityRows({ ...DONE, vin: '', vinRefused: true });
    const vin = r.find((x) => x.label === 'VIN');
    expect(vin.value).toBe('—');
    expect(vin.note).toContain('does not report');
  });

  it('reads silence as a fact about the last few seconds', () => {
    const asked = identityRows({ ...DONE, vin: '', vinRefused: false });
    expect(asked.find((x) => x.label === 'VIN').note).toBe('asked, but nothing came back');

    const notYet = identityRows({ ...DONE, done: false, vin: '', vinRefused: false });
    expect(notYet.find((x) => x.label === 'VIN').note).toBe('not asked yet');
  });

  it('explains a missing key in terms of what it is for', () => {
    const r = identityRows({ ...DONE, vin: '', cal: '', key: '' });
    expect(r.find((x) => x.label === 'Backup key').note).toContain('cannot be checked against');
  });

  it('renders nothing before there is anything to render', () => {
    expect(identityRows(null)).toEqual([]);
  });
});

describe('pidTally and pidText', () => {
  it('counts the three states separately', () => {
    expect(pidTally(DONE)).toEqual({ yes: 2, no: 1, unknown: 1, total: 4 });
  });

  it('says what an unsupported PID means for the dashboard', () => {
    const t = pidText(pidTally(DONE));
    expect(t).toContain('2 of 4 supported');
    expect(t).toContain('that is the car, not a fault');
    expect(t).toContain('1 still unknown');
  });

  it('never turns "not asked" into "your car cannot"', () => {
    const all = { polled: [{ pid: '0C', state: 'unknown' }, { pid: '0D', state: 'unknown' }] };
    const t = pidText(pidTally(all));
    expect(t).toContain('have not arrived yet');
    expect(t).not.toContain('not supported');
  });

  it('lists the blank tiles rather than only counting them', () => {
    expect(unsupportedPids(DONE)).toEqual(['5C']);
    expect(unsupportedPids(null)).toEqual([]);
  });
});

describe('tcmText', () => {
  it('reports a second ECU that answered', () => {
    expect(tcmText(DONE)).toContain('answers at 0x7E9');
  });

  it('never calls silence an absent module', () => {
    // Nothing on a CAN bus distinguishes a module that is not fitted from one that
    // is not awake, so the page must not claim to.
    const t = tcmText({ ...DONE, tcm: 'silent' });
    expect(t).toContain('cannot tell those apart');
    expect(t).not.toMatch(/not fitted\.|no second ECU\./);
  });

  it('says when it has not asked', () => {
    expect(tcmText({ ...DONE, tcm: 'unasked' })).toContain('not been asked');
  });
});

describe('blocksText', () => {
  it('counts how far the walk got', () => {
    expect(blocksText(DONE)).toBe('2 of 3 mode 01 support blocks read.');
  });

  it('says nothing was read rather than reporting zero of eight as progress', () => {
    expect(blocksText({ blocks: [{ known: false }] })).toBe('No support bitmaps read yet.');
    expect(blocksText(null)).toBe('No support bitmaps read yet.');
  });
});

// The identifier list behind the picker.
//
// Two rules, both of them things that went wrong on the car: a file exported by an
// older firmware still has to load, and loading one must not cost the board its own
// hits.

import { describe, it, expect } from 'vitest';
import { parseCsv, mergeHits, hitKey, watchName, HITS_STORE_MAX } from './hits.js';

describe('parsing did_hits.csv', () => {
  const csv = [
    'ecu,did,len,hex,ascii',
    'ECM,1002,4,00001A2B,"...+"',
    'TCM,0140,2,0F3C,".<"',
  ].join('\n');

  it('reads the first four columns and ignores the quoted tail', () => {
    expect(parseCsv(csv)).toEqual([
      { ecu: 'ECM', did: '1002', len: 4, hex: '00001A2B' },
      { ecu: 'TCM', did: '0140', len: 2, hex: '0F3C' },
    ]);
  });

  it('skips the header with no special case for it', () => {
    // The ECU check does the work: "ecu" is neither ECM nor TCM. A file with no
    // header, or with a different one, loads exactly the same way.
    expect(parseCsv('ECM,1002,4,00001A2B,"x"')).toHaveLength(1);
    expect(parseCsv('ecu,did,len,hex,ascii')).toEqual([]);
  });

  it('accepts CRLF, because the file may have been round-tripped through a PC', () => {
    expect(parseCsv('ECM,1002,4,00001A2B,"x"\r\nTCM,0140,2,0F3C,"y"\r\n')).toHaveLength(2);
  });

  it('is case- and whitespace-tolerant on the two fields it validates', () => {
    expect(parseCsv(' ecm , 1a2b ,2,0F3C,"x"')).toEqual([
      { ecu: 'ECM', did: '1A2B', len: 2, hex: '0F3C' },
    ]);
  });

  it('rejects a row that is not an identifier', () => {
    // A file from an older firmware is not trusted, only read: anything whose ECU
    // or DID does not survive validation is dropped rather than watched.
    expect(parseCsv('ECM,12,4,00,"x"')).toEqual([]);        // three-digit DID
    expect(parseCsv('ECM,12G4,4,00,"x"')).toEqual([]);      // not hex
    expect(parseCsv('PCM,1002,4,00,"x"')).toEqual([]);      // unknown responder
    expect(parseCsv('ECM,1002,4')).toEqual([]);             // truncated row
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv(null)).toEqual([]);
  });

  it('treats a missing length as zero rather than NaN', () => {
    expect(parseCsv('ECM,1002,,0F3C,"x"')[0].len).toBe(0);
  });
});

describe('merging', () => {
  const board = [{ ecu: 'ECM', did: '1002', len: 4, hex: 'AAAAAAAA' }];
  const file = [
    { ecu: 'ECM', did: '1002', len: 4, hex: 'BBBBBBBB' },
    { ecu: 'TCM', did: '0140', len: 2, hex: '0F3C' },
  ];

  it('adds what is new and keeps what was there', () => {
    // The bug: a board mid-sweep loses the identifiers it just found because
    // someone opened a file, or the other way round.
    const out = mergeHits(board, file);
    expect(out.map(hitKey)).toEqual(['ECM1002', 'TCM0140']);
  });

  it('lets the entry already in the list keep its payload', () => {
    expect(mergeHits(board, file)[0].hex).toBe('AAAAAAAA');
  });

  it('does not mutate its input', () => {
    const before = board.slice();
    mergeHits(board, file);
    expect(board).toEqual(before);
  });

  it('sorts by responder then identifier, so the picker does not reshuffle', () => {
    const out = mergeHits([], [
      { ecu: 'TCM', did: '0140' }, { ecu: 'ECM', did: 'F190' }, { ecu: 'ECM', did: '1002' },
    ]);
    expect(out.map(hitKey)).toEqual(['ECM1002', 'ECMF190', 'TCM0140']);
  });

  it('handles either side being absent', () => {
    expect(mergeHits(null, file)).toHaveLength(2);
    expect(mergeHits(board, null)).toHaveLength(1);
  });
});

describe('identifier naming', () => {
  it('names a hit the way the board names a watched column', () => {
    // E1002 / T0140 — responder and identifier, so the same DID on both ECUs stays
    // distinguishable. This has to match watchColName() in didwatch.h or the
    // checkbox does not tick when the board reports back what it is watching.
    expect(watchName({ ecu: 'ECM', did: '1002' })).toBe('E1002');
    expect(watchName({ ecu: 'TCM', did: '0140' })).toBe('T0140');
  });
});

describe('the remembered list', () => {
  it('is capped well under a full sweep', () => {
    expect(HITS_STORE_MAX).toBe(2000);
  });
});

// The restore gate.
//
// Most of these are about one failure. /didmap.csv is 214 verdicts about one
// engine, nothing inside it says which, and restored onto another car it does not
// error - it attaches. Every conclusion drawn from it afterwards is then about the
// wrong engine, and nothing ever says so.
//
// So the interesting cases are not "does a matching backup restore". They are the
// three ways this is allowed to be uncertain, and what it does with each.

import { describe, it, expect } from 'vitest';
import {
  MANIFEST, FORMAT, isDataFile, fileKind, summarise, buildManifest,
  backupName, restoreCheck, restorePlan, restoreResultText,
} from './backup.js';

describe('isDataFile', () => {
  it('accepts the three kinds the board produces', () => {
    expect(isDataFile('/didmap.csv')).toBe(true);
    expect(isDataFile('/scanhits.csv')).toBe(true);
    expect(isDataFile('/t0006.csv')).toBe(true);
    expect(isDataFile('t0006.csv')).toBe(true);       // as it appears inside the zip
  });

  it('refuses the bundle, which is the page you are standing on', () => {
    expect(isDataFile('/w/index.html.gz')).toBe(false);
    expect(isDataFile('w/index.html.gz')).toBe(false);
  });

  it('refuses a name that is a path rather than a file', () => {
    // An archive is a file somebody else may have made, so its names reach
    // /file/put the same way a URL argument would. The firmware checks this too;
    // this one exists so the page can say what it will not take before uploading.
    expect(isDataFile('../didmap.csv')).toBe(false);
    expect(isDataFile('/../didmap.csv')).toBe(false);
    expect(isDataFile('/a/../didmap.csv')).toBe(false);
    expect(isDataFile('\\didmap.csv')).toBe(false);
  });

  it('holds the trip name rule the firmware holds', () => {
    expect(isDataFile('/t123.csv')).toBe(false);       // fewer than four digits
    expect(isDataFile('/t12345678901.csv')).toBe(false);
    expect(isDataFile('/t0006.txt')).toBe(false);
    expect(isDataFile('/t00o6.csv')).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isDataFile('')).toBe(false);
    expect(isDataFile(null)).toBe(false);
    expect(isDataFile(undefined)).toBe(false);
    expect(isDataFile(42)).toBe(false);
  });
});

describe('summarise', () => {
  it('names what is in the archive', () => {
    expect(summarise(['/t0001.csv', '/t0002.csv', '/scanhits.csv', '/didmap.csv']))
      .toBe('2 trips, the sweep and the register');
    expect(summarise(['/t0001.csv'])).toBe('1 trip');
    expect(summarise(['/didmap.csv'])).toBe('the register');
    expect(summarise([])).toBe('nothing');
  });

  it('does not count the manifest as data', () => {
    expect(fileKind(MANIFEST)).toBe('other');
    expect(summarise([MANIFEST])).toBe('nothing');
  });
});

describe('buildManifest', () => {
  const veh = { key: '1f3c9a20', cal: 'SW1234', cvn: '12AB00FF', vin: 'MAT625123ABC12345' };

  it('carries the key, not the VIN', () => {
    // The key answers the only question the archive is asked as well as the VIN
    // would, and a backup is a file that gets copied to a phone and a laptop.
    const m = buildManifest(veh, { fw: '1.15.0', web: '0.1.0' }, ['/didmap.csv'], 'x');
    expect(m.key).toBe('1f3c9a20');
    expect(JSON.stringify(m)).not.toContain('MAT625123ABC12345');
    expect(m.vin).toBeUndefined();
  });

  it('is honest about a board that has identified nothing', () => {
    const m = buildManifest(null, null, [], 'x');
    expect(m.key).toBe('');
    expect(m.format).toBe(FORMAT);
  });
});

describe('backupName', () => {
  it('names the car and the moment', () => {
    expect(backupName('1f3c9a20', new Date(2026, 7, 29, 10, 42)))
      .toBe('obdurate-1f3c9a20-20260829-1042.zip');
  });

  it('says so when nothing identified the car', () => {
    expect(backupName('', new Date(2026, 7, 29, 10, 42)))
      .toBe('obdurate-nocar-20260829-1042.zip');
  });
});

describe('restoreCheck', () => {
  const board = { key: '1f3c9a20' };

  it('allows the same car outright', () => {
    const r = restoreCheck({ format: FORMAT, key: '1f3c9a20' }, board);
    expect(r.verdict).toBe('match');
    expect(r.ok).toBe(true);
    expect(r.needsConfirm).toBe(false);
  });

  it('refuses a different car, and does not offer a way past it', () => {
    // This is the failure the whole module exists for. An "are you sure" here is a
    // button people press, so there is not one.
    const r = restoreCheck({ format: FORMAT, key: 'deadbeef' }, board);
    expect(r.verdict).toBe('mismatch');
    expect(r.ok).toBe(false);
    expect(r.needsConfirm).toBe(false);
    expect(r.text).toContain('deadbeef');
    expect(r.text).toContain('1f3c9a20');
  });

  it('refuses an archive with nothing that says where it came from', () => {
    expect(restoreCheck(null, board).verdict).toBe('invalid');
    expect(restoreCheck({}, board).verdict).toBe('invalid');
    expect(restoreCheck('a string', board).verdict).toBe('invalid');
    expect(restoreCheck({ format: FORMAT + 1, key: '1f3c9a20' }, board).verdict).toBe('invalid');
    expect(restoreCheck(null, board).ok).toBe(false);
  });

  it('asks rather than decides when either end has no identity', () => {
    // Both of these are ordinary. A backup made before the first drive has no key;
    // a freshly reset board has no key. Neither is a reason to refuse, and neither
    // is a reason to proceed silently.
    const noArchive = restoreCheck({ format: FORMAT, key: '' }, board);
    expect(noArchive.verdict).toBe('unknown');
    expect(noArchive.ok).toBe(true);
    expect(noArchive.needsConfirm).toBe(true);
    expect(noArchive.text).toContain('before its board had identified');

    const noBoard = restoreCheck({ format: FORMAT, key: '1f3c9a20' }, { key: '' });
    expect(noBoard.verdict).toBe('unknown');
    expect(noBoard.needsConfirm).toBe(true);
    expect(noBoard.text).toContain('has not been in a running one');

    expect(restoreCheck({ format: FORMAT, key: '' }, {}).verdict).toBe('unknown');
    expect(restoreCheck({ format: FORMAT, key: '' }, null).verdict).toBe('unknown');
  });

  it('never reads a missing key as a match', () => {
    // Two blanks are not two of the same thing. If they compared equal, every
    // backup would restore onto every board.
    const r = restoreCheck({ format: FORMAT, key: '' }, { key: '' });
    expect(r.verdict).toBe('unknown');
    expect(r.needsConfirm).toBe(true);
  });
});

describe('restorePlan', () => {
  it('writes the data and leaves the manifest behind', () => {
    const p = restorePlan([MANIFEST, '/didmap.csv', '/t0006.csv']);
    expect(p.write).toEqual(['/didmap.csv', '/t0006.csv']);
    expect(p.skip).toEqual([]);
  });

  it('lists what this board will not take rather than dropping it', () => {
    // Usually means the archive came from a newer firmware, which is worth saying.
    const p = restorePlan([MANIFEST, '/didmap.csv', '/vehicle.json', 'w/index.html.gz']);
    expect(p.write).toEqual(['/didmap.csv']);
    expect(p.skip).toEqual(['/vehicle.json', 'w/index.html.gz']);
  });
});

describe('restoreResultText', () => {
  it('reports a clean restore and what has to happen next', () => {
    const t = restoreResultText([{ name: 'a', ok: true }, { name: 'b', ok: true }]);
    expect(t).toContain('Restored 2 files');
    expect(t).toContain('Reboot');
  });

  it('names the failures rather than rounding them off', () => {
    const t = restoreResultText([
      { name: '/didmap.csv', ok: false, error: 'partition full?' },
      { name: '/t0006.csv', ok: true },
    ]);
    expect(t).toContain('Restored 1 of 2');
    expect(t).toContain('/didmap.csv (partition full?)');
  });
});

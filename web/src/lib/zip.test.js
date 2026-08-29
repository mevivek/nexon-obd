// The archive has to open somewhere else.
//
// That is the whole point of a backup, and it is the one property a round-trip
// through this module's own reader cannot demonstrate: a writer and a reader that
// agree on the same wrong offsets pass every round-trip test there is. So these
// check the bytes against the format as well as against each other - the four
// signatures, the two sizes ZIP keeps for every entry, the offsets in the central
// directory, and a CRC-32 against a known value.

import { describe, it, expect } from 'vitest';
import { zipStored, unzipStored, crc32, dosTime, entryText, textBytes } from './zip.js';

const AT = new Date(2026, 7, 29, 10, 42, 30);   // 29 Aug 2026, 10:42:30 local
const u32 = (b, i) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, true);
const u16 = (b, i) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(i, true);

describe('crc32', () => {
  it('matches the known value for "123456789"', () => {
    // The check value every CRC-32 implementation is tested against.
    expect(crc32(textBytes('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for nothing', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('dosTime', () => {
  it('packs the two 16-bit fields', () => {
    const { time, date } = dosTime(AT);
    expect(time >> 11).toBe(10);              // hours
    expect((time >> 5) & 0x3f).toBe(42);      // minutes
    expect((time & 0x1f) * 2).toBe(30);       // seconds, in units of two
    expect(((date >> 9) & 0x7f) + 1980).toBe(2026);
    expect((date >> 5) & 0x0f).toBe(8);
    expect(date & 0x1f).toBe(29);
  });

  it('clamps a year the format cannot hold', () => {
    // The board has no clock until a page sets it, so 1970 is genuinely reachable.
    // Left alone it would wrap to a date an unzip tool rejects.
    const { date } = dosTime(new Date(1970, 0, 1));
    expect(((date >> 9) & 0x7f) + 1980).toBe(1980);
  });
});

describe('zipStored', () => {
  const files = [
    { name: 'didmap.csv', data: textBytes('1002,varies,42,7,00A1,00B4\n') },
    { name: 't0006.csv', data: textBytes('ms,rpm\n0,801\n1000,812\n') },
  ];
  const z = zipStored(files, AT);

  it('starts with a local file header', () => {
    expect(u32(z, 0)).toBe(0x04034b50);
  });

  it('stores, never deflates', () => {
    // Both the local header and the central directory carry the method, and an
    // unzip tool may read either.
    expect(u16(z, 8)).toBe(0);
    const eocd = z.length - 22;
    const cd = u32(z, eocd + 16);
    expect(u16(z, cd + 10)).toBe(0);
  });

  it('sets both sizes to the real one', () => {
    expect(u32(z, 18)).toBe(files[0].data.length);
    expect(u32(z, 22)).toBe(files[0].data.length);
  });

  it('carries a real CRC in the local header', () => {
    expect(u32(z, 14)).toBe(crc32(files[0].data));
  });

  it('ends with the directory record, counting every entry twice as the format wants', () => {
    const eocd = z.length - 22;
    expect(u32(z, eocd)).toBe(0x06054b50);
    expect(u16(z, eocd + 8)).toBe(2);
    expect(u16(z, eocd + 10)).toBe(2);
  });

  it('points the directory at the entries it describes', () => {
    const eocd = z.length - 22;
    const cd = u32(z, eocd + 16);
    expect(u32(z, cd)).toBe(0x02014b50);
    // The first entry's local header is at offset 0; the second is not, and
    // getting that wrong is the classic way to write an archive that opens here
    // and nowhere else.
    expect(u32(z, cd + 42)).toBe(0);
    const nameLen = u16(z, cd + 28);
    const cd2 = cd + 46 + nameLen;
    expect(u32(z, cd2)).toBe(0x02014b50);
    expect(u32(z, cd2 + 42)).toBeGreaterThan(0);
    expect(u32(z, u32(z, cd2 + 42))).toBe(0x04034b50);
  });

  it('is the same bytes for the same input', () => {
    // Nothing in here reads the clock, which is what makes any of this assertable.
    expect(zipStored(files, AT)).toEqual(z);
  });
});

describe('unzipStored', () => {
  const files = [
    { name: 'obdurate-backup.json', data: textBytes('{"format":1}') },
    { name: 'didmap.csv', data: textBytes('1002,varies,42,7,00A1,00B4\n') },
  ];

  it('reads back what was written', () => {
    const got = unzipStored(zipStored(files, AT));
    expect(got.map((e) => e.name)).toEqual(['obdurate-backup.json', 'didmap.csv']);
    expect(entryText(got[1])).toBe('1002,varies,42,7,00A1,00B4\n');
  });

  it('survives an empty archive', () => {
    expect(unzipStored(zipStored([], AT))).toEqual([]);
  });

  it('survives an empty file inside one', () => {
    const got = unzipStored(zipStored([{ name: 'empty.csv', data: new Uint8Array(0) }], AT));
    expect(got.length).toBe(1);
    expect(got[0].data.length).toBe(0);
  });

  // Everything below is a refusal. A backup that half-restores is worse than one
  // that will not open, so each of these has to throw and say why.
  it('refuses something that is not a zip', () => {
    expect(() => unzipStored(textBytes('this is a csv, actually'))).toThrow(/not a zip/);
    expect(() => unzipStored(new Uint8Array(4))).toThrow(/too short/);
  });

  it('refuses a damaged entry rather than restoring it', () => {
    const z = zipStored(files, AT);
    // Corrupt a byte of the register's payload. The CRC is what catches this, and
    // it is the only thing that would: the sizes and offsets are all still right.
    const at = z.length - 1;
    const cd = u32(z, at - 21 + 16);
    const local = u32(z, cd + 46 + u16(z, cd + 28) + 42);
    const dataAt = local + 30 + u16(z, local + 26) + u16(z, local + 28);
    z[dataAt] ^= 0xff;
    expect(() => unzipStored(z)).toThrow(/checksum/);
  });

  it('names a compressed entry instead of mis-reading it', () => {
    const z = zipStored(files, AT);
    const eocd = z.length - 22;
    const cd = u32(z, eocd + 16);
    new DataView(z.buffer).setUint16(cd + 10, 8, true);   // claim DEFLATE
    expect(() => unzipStored(z)).toThrow(/compressed \(method 8\)/);
  });

  it('refuses a directory that points outside the file', () => {
    const z = zipStored(files, AT);
    const eocd = z.length - 22;
    new DataView(z.buffer).setUint32(eocd + 16, z.length + 1000, true);
    expect(() => unzipStored(z)).toThrow(/outside the file/);
  });

  it('reads the data offset from the local header, not the directory', () => {
    // The extra field is allowed to differ between the two, and a reader that
    // assumes they match lands mid-payload on archives from other tools.
    const z = zipStored([files[1]], AT);
    const eocd = z.length - 22;
    const cd = u32(z, eocd + 16);
    // A central-directory extra field the local header does not have. Real archives
    // do this routinely; a reader that adds this length to the local offset lands
    // nine bytes into the payload and hands back a truncated file that still has a
    // plausible name.
    new DataView(z.buffer).setUint16(cd + 30, 9, true);
    const got = unzipStored(z);
    expect(entryText(got[0])).toBe('1002,varies,42,7,00A1,00B4\n');
  });
});

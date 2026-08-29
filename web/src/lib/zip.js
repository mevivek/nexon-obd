// A ZIP writer and reader, in the browser, with no dependency.
//
// The board has one core, 320 KB of heap and a car to poll while it serves you. It
// already refuses to assemble the DID export for the same reason, and a backup is
// that argument several hundred kilobytes louder: /files lists what is there, /file
// streams one, and the archive is built here.
//
// STORED, NOT DEFLATED
//
// Every entry is written uncompressed. That is deliberate and it is not laziness:
//
//   - The payload is CSV. CompressionStream would help a lot, and it is also the
//     one part of this that is not available everywhere - it landed in Safari in
//     16.4, and a phone in a car is exactly where the old browser turns up.
//   - Reading it back has to work on the same phone. STORED means the reader below
//     is a header walk and a slice; supporting DEFLATE would mean shipping an
//     inflater into a 300 KB budget to read a file this page wrote.
//   - Every unzip tool handles STORED. Nothing about the file is unusual - it opens
//     in Windows Explorer, in Finder, in unzip, in a phone's file manager.
//
// So a backup is roughly the size of the data. On a 1.5 MB partition that is a
// price worth paying to be certain the file opens.
//
// WHAT IS NOT HERE
//
// Zip64, encryption, multi-disk, and directory entries. A backup is a handful of
// files off a 1.5 MB filesystem; none of that can arise. The reader says so out
// loud rather than mis-parsing: an archive it cannot read is refused by name, not
// silently half-read.

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const enc = new TextEncoder();
const dec = new TextDecoder();

// CRC-32, the ordinary one, built once. A ZIP entry carries it in two places and
// every unzip tool checks it, so a wrong one is a corrupt archive rather than a
// cosmetic detail.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A Date as the two 16-bit fields ZIP has carried since 1989.
 *
 * MS-DOS time: seconds in units of two, and a year counted from 1980. Both ends of
 * that range are reachable by a board with no clock — Obdurate's own clock is set
 * by the browser and is 1970 until a page loads — so both are clamped rather than
 * allowed to wrap into a date an unzip tool would reject.
 */
export function dosTime(d) {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build a ZIP from `[{name, data}]`, where data is a Uint8Array.
 *
 * `at` is the timestamp stamped on every entry. Passed in rather than read here so
 * the same input always produces the same bytes, which is what makes this testable
 * at all.
 */
export function zipStored(entries, at = new Date()) {
  const { time, date } = dosTime(at);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);          // version needed: 2.0, which is STORED
    lv.setUint16(6, 0, true);           // no flags: no encryption, no data descriptor
    lv.setUint16(8, 0, true);           // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);          // no extra field
    local.set(name, 30);

    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CD_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);          // extra
    cv.setUint16(32, 0, true);          // comment
    cv.setUint16(34, 0, true);          // disk
    cv.setUint16(36, 0, true);          // internal attributes
    cv.setUint32(38, 0, true);          // external attributes
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at2 = 0;
  for (const p of all) { out.set(p, at2); at2 += p.length; }
  return out;
}

/**
 * Read a ZIP back, from the central directory rather than by scanning for local
 * headers.
 *
 * The central directory is the archive's own index and it is what every unzip tool
 * reads. Walking local headers instead would find deleted entries that a rewrite
 * left in place, which is precisely the sort of thing that restores a file the
 * person who made the archive had removed.
 *
 * Throws, with the reason, on anything it cannot read. A backup that half-restores
 * is worse than one that refuses.
 */
export function unzipStored(bytes) {
  if (!bytes || bytes.length < 22) throw new Error('not a zip file - too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The EOCD is last, but a trailing comment can push it back by up to 64 KB, so
  // it is searched for rather than assumed to be at the end.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (v.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file - no end-of-directory record');

  const count = v.getUint16(eocd + 10, true);
  const cdOff = v.getUint32(eocd + 16, true);
  if (cdOff > bytes.length) throw new Error('zip directory is outside the file');

  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== CD_SIG)
      throw new Error('zip directory entry ' + i + ' is malformed');

    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // Named, not guessed at. "This archive is compressed and this reader is not"
    // is a thing somebody can act on; a wrong-looking CSV is not.
    if (method !== 0)
      throw new Error(`"${name}" is compressed (method ${method}); this reader only handles stored entries`);

    if (local + 30 > bytes.length || v.getUint32(local, true) !== LOCAL_SIG)
      throw new Error(`"${name}" points at no file header`);
    // The local header carries its own name and extra lengths, and they are NOT
    // required to match the central directory's - the extra field routinely differs
    // between the two. Read the data offset from the local header itself.
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (dataAt + size > bytes.length) throw new Error(`"${name}" runs past the end of the file`);
    const data = bytes.subarray(dataAt, dataAt + size);

    if (crc32(data) !== crc) throw new Error(`"${name}" failed its checksum - the file is damaged`);

    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** An entry's bytes as text. Backups hold CSV and one JSON manifest, nothing else. */
export function entryText(e) {
  return dec.decode(e.data);
}

/** Text as an entry's bytes. */
export function textBytes(s) {
  return enc.encode(s);
}

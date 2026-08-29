// What goes in a backup, what comes back out, and when a restore has to refuse.
//
// The board accumulates things that took real time and cannot be regenerated on
// demand: a sweep of the identifier space is over half an hour on CAN and the
// better part of a day over BLE, the register behind it takes drives to build, and
// the trip logs are the drives themselves. All of it lives on a 1.5 MB partition
// inside a device that gets unplugged, reflashed and left in a hot car.
//
// THE ONE THING THIS FILE IS ACTUALLY FOR
//
// /didmap.csv is 214 verdicts about one specific engine. Restored onto a different
// car it would not fail - it would attach, silently, and every conclusion drawn
// from it afterwards would be about the wrong engine. Nothing in the CSV says
// which car it came from, so a backup has to carry that itself and a restore has
// to check it.
//
// So the archive holds a manifest, the manifest holds vehKey() - a hash over the
// VIN and calibration id, computed on the board - and restoreCheck() below is the
// gate. Three answers, not two: match, mismatch, and cannot-tell. Cannot-tell is
// the common case on a fresh board and it is not an error; it is a question that
// has to be put to somebody rather than answered on their behalf.

/** The manifest's name inside the archive. Not a data file, so the board never sees it. */
export const MANIFEST = 'obdurate-backup.json';

/** What version of this format the archive claims. Bumped if the shape changes. */
export const FORMAT = 1;

/**
 * Which names this board will accept back.
 *
 * A mirror of dataIsFileName() in firmware/Obdurate/datafiles.h, kept deliberately
 * strict for the same reason that one is: anything that reaches /file/put opens a
 * file for writing, and the honest answer to "which names are allowed" is a list.
 *
 * Checking here as well as there is not redundancy. The firmware's check is the
 * boundary and it stays; this one is so the page can say "this archive contains
 * three files this board will not take, here they are" before uploading anything,
 * rather than discovering it one 400 at a time.
 */
export function isDataFile(name) {
  if (typeof name !== 'string' || !name) return false;
  const n = name.startsWith('/') ? name : '/' + name;
  if (n.includes('..') || n.includes('\\')) return false;
  if (n.lastIndexOf('/') !== 0) return false;          // no directories
  if (n === '/scanhits.csv' || n === '/didmap.csv') return true;
  return /^\/t\d{4,10}\.csv$/.test(n);                 // trip logs, as trip_names.h has it
}

/** The three kinds, for a summary somebody can read before pressing anything. */
export function fileKind(name) {
  const n = name.startsWith('/') ? name : '/' + name;
  if (n === '/didmap.csv') return 'register';
  if (n === '/scanhits.csv') return 'sweep';
  if (isDataFile(n)) return 'trip';
  return 'other';
}

/** `3 trips, the sweep and the register` - the archive in one line. */
export function summarise(names) {
  const trips = names.filter((n) => fileKind(n) === 'trip').length;
  const bits = [];
  if (trips) bits.push(trips + (trips === 1 ? ' trip' : ' trips'));
  if (names.some((n) => fileKind(n) === 'sweep')) bits.push('the sweep');
  if (names.some((n) => fileKind(n) === 'register')) bits.push('the register');
  if (!bits.length) return 'nothing';
  if (bits.length === 1) return bits[0];
  return bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1];
}

/**
 * The manifest written into the archive.
 *
 * `key` is a hash, and the VIN it is partly derived from is deliberately not here.
 * The key answers the only question the archive is asked - is this the same car -
 * exactly as well as the VIN would, and a backup is a file meant to be copied to a
 * phone, a laptop and wherever else. The calibration id is kept because it is not
 * an identifier of a car, it is an identifier of the software in it, and it is the
 * thing a person actually reads when deciding whether two backups match.
 */
export function buildManifest(veh, board, names, atIso) {
  return {
    format: FORMAT,
    made: atIso,
    key: (veh && veh.key) || '',
    cal: (veh && veh.cal) || '',
    cvn: (veh && veh.cvn) || '',
    fw: (board && board.fw) || '',
    web: (board && board.web) || '',
    files: names.slice().sort(),
  };
}

/** `obdurate-1f3c9a20-20260829-1042.zip`, or `-nocar-` when nothing identified it. */
export function backupName(key, at) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
              + `-${p(at.getHours())}${p(at.getMinutes())}`;
  return `obdurate-${key || 'nocar'}-${stamp}.zip`;
}

/**
 * Should this archive be restored onto this board?
 *
 * Four verdicts, and only one of them is a plain yes:
 *
 *   invalid   - no manifest, or one this build does not understand. Refused.
 *   mismatch  - both ends identified a car and they are different cars. Refused,
 *               and not overridable: this is the failure the whole file exists to
 *               prevent, and an "are you sure" on it is a button people press.
 *   unknown   - one end or the other has no identity. Allowed, but only after
 *               somebody says so, because it is the state a fresh board is in and
 *               also the state a board plugged into the wrong car is in.
 *   match     - the same car. Yes.
 *
 * `board.key` empty means this board has never completed a discovery walk - it has
 * not been in a running car since the last reset. That is not a reason to refuse;
 * it is a reason to say so.
 */
export function restoreCheck(manifest, board) {
  if (!manifest || typeof manifest !== 'object')
    return { verdict: 'invalid', ok: false, needsConfirm: false,
             text: 'This archive has no manifest, so there is nothing that says which car it came from. Obdurate will not restore it.' };

  if (manifest.format !== FORMAT)
    return { verdict: 'invalid', ok: false, needsConfirm: false,
             text: `This archive is format ${manifest.format}, and this build reads format ${FORMAT}.` };

  const mine = (board && board.key) || '';
  const theirs = manifest.key || '';

  if (mine && theirs && mine !== theirs)
    return { verdict: 'mismatch', ok: false, needsConfirm: false,
             text: `This archive is from a different car (${theirs}; this board is ${mine}). Its register holds verdicts about another engine, and restoring it would attach them to this one without saying so.` };

  if (mine && theirs)
    return { verdict: 'match', ok: true, needsConfirm: false,
             text: `Same car (${mine}).` };

  const why = !theirs
    ? 'The archive was made before its board had identified a car'
    : 'This board has not identified a car yet - it has not been in a running one since the last reset';
  return { verdict: 'unknown', ok: true, needsConfirm: true,
           text: `${why}, so there is no way to tell whether this backup belongs to this car. Restoring the register onto the wrong engine is silent, not noisy - check it yourself before continuing.` };
}

/**
 * What a restore would actually write, and what it would skip.
 *
 * The manifest is skipped by name because it is not a data file, and anything else
 * the board's allowlist refuses is skipped by rule. Both are listed rather than
 * dropped: an archive carrying a file this board will not take is worth mentioning,
 * because the usual reason is that it came from a newer firmware.
 */
export function restorePlan(names) {
  const write = [], skip = [];
  for (const n of names) {
    if (n === MANIFEST) continue;
    (isDataFile(n) ? write : skip).push(n);
  }
  return { write, skip };
}

/** `restored 4 files` / `restored 3 of 4 - didmap.csv failed`. Faithful, per the board's own replies. */
export function restoreResultText(results) {
  const good = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (!results.length) return 'Nothing to restore.';
  if (!bad.length) return `Restored ${good.length} file${good.length === 1 ? '' : 's'}. Reboot the board to load them.`;
  return `Restored ${good.length} of ${results.length}. Failed: `
       + bad.map((r) => `${r.name} (${r.error || 'unknown error'})`).join(', ');
}

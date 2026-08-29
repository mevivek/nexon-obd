#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include "obd_types.h"

// What is known about each identifier a sweep found.
//
// The sweep answers "does 1002 exist". Watching answers "what does 1002 mean". This
// is the thing in between, and it is the piece the workflow was missing: somewhere
// to write down what has been established, so identifying an identifier is done once
// rather than every time you come back to it.
//
// Without it, watching is a monitor - eight values on screen that mean nothing the
// moment you change the set. With it, watching is a queue you work through.
//
// THE POINT OF TRIAGE
//
// A sweep on this car found 214 identifiers. The board watches eight. Working
// through 214 in batches of eight, a drive each, is 27 drives - months - and most of
// those drives would be spent on identifiers that never change: part numbers,
// calibration constants, configuration bytes. A value that does not move cannot
// correlate with anything, and spending a watch slot on one is spending the scarcest
// thing here on the least informative.
//
// Re-reading all 214 is cheap by comparison. Over BLE at roughly six exchanges a
// second a full pass is about 36 seconds, so ten passes across idle, revving and
// warm-up is six minutes. That partitions the list before a single watch slot is
// spent, and what is left is a handful worth a drive.
//
// WHAT "CONSTANT" IS ALLOWED TO MEAN
//
// Not "this identifier is constant". Only "this did not change across N reads, under
// whatever conditions happened to be sampled". An identifier that moves only above
// 4000 rpm looks constant at idle, and a value that moves only with the doors open
// looks constant while driving. The record therefore keeps the read count and the
// change count rather than a verdict, and every place this is shown has to say what
// was actually observed. It is a triage result - a reason to look elsewhere first -
// and never a conclusion.
//
// "Varies" is the opposite: one observed change is proof, and it does not weaken.

static const char *DIDMAP_FILE = "/didmap.csv";

// Enough reads that a constant verdict is worth acting on, without being so many
// that a first pass never produces one. Ten passes is about six minutes over BLE.
static const uint8_t DIDMAP_CONST_READS = 10;

enum DidState : uint8_t {
  DID_UNKNOWN = 0,   // never re-read since the sweep found it
  DID_CONSTANT,      // DIDMAP_CONST_READS reads, no change seen - provisional
  DID_VARIES,        // changed at least once - definite
  DID_IDENTIFIED,    // a human has said what it is
};

static const char *didStateName(uint8_t s) {
  switch (s) {
    case DID_CONSTANT:   return "constant";
    case DID_VARIES:     return "varies";
    case DID_IDENTIFIED: return "identified";
    default:             return "unknown";
  }
}

// One line of the register. `first` is the value the sweep recorded; `last` is the
// most recent read. Both are kept because the pair is the evidence for the verdict -
// a reader can see what changed rather than taking "varies" on trust.
struct DidRec {
  uint16_t did;
  uint8_t  ecu;
  uint8_t  state;
  uint16_t reads;
  uint16_t changes;
  uint8_t  len;
  uint8_t  first[8];
  uint8_t  last[8];
};

// The verdict, as a pure function of what was observed, so it can be tested rather
// than driven at a car.
//
// Order matters. An identification is a human statement and outranks any number of
// machine reads - re-reading an identifier somebody has already named must not
// quietly relabel it. A single change outranks any number of unchanged reads,
// because one is proof and the others are only absence of proof.
static uint8_t didVerdict(uint8_t state, uint16_t reads, uint16_t changes) {
  if (state == DID_IDENTIFIED) return DID_IDENTIFIED;
  if (changes) return DID_VARIES;
  if (reads >= DIDMAP_CONST_READS) return DID_CONSTANT;
  return DID_UNKNOWN;
}

// Fold one fresh read into a record. Returns true when the verdict moved, which is
// the only time the file needs rewriting.
static bool didObserve(DidRec &r, const uint8_t *data, uint8_t len) {
  uint8_t n = len > sizeof(r.last) ? (uint8_t)sizeof(r.last) : len;

  // The first read after a restore establishes the baseline rather than counting as
  // a change: `first` came out of the sweep's own record, and comparing a fresh read
  // against a length the sweep truncated differently would manufacture a change that
  // never happened.
  bool changed = false;
  if (r.reads) {
    changed = (n != r.len) || (memcmp(r.last, data, n) != 0);
  } else {
    r.len = n;
    memcpy(r.first, data, n);
  }

  memcpy(r.last, data, n);
  r.len = n;
  if (r.reads < 0xFFFF) r.reads++;
  if (changed && r.changes < 0xFFFF) r.changes++;

  uint8_t before = r.state;
  r.state = didVerdict(r.state, r.reads, r.changes);
  return r.state != before;
}

static void didHex(char *out, size_t cap, const uint8_t *d, uint8_t len) {
  size_t o = 0;
  for (uint8_t i = 0; i < len && o + 3 < cap; i++) o += snprintf(out + o, cap - o, "%02X", d[i]);
  out[o] = 0;
}

static uint8_t didUnhex(const char *s, uint8_t *out, uint8_t cap) {
  uint8_t n = 0;
  while (s[0] && s[1] && n < cap) {
    char b[3] = {s[0], s[1], 0};
    out[n++] = (uint8_t)strtoul(b, nullptr, 16);
    s += 2;
  }
  return n;
}

// One line of the register file, written and read back.
//
// Pure, and above the storage marker on purpose, because the bug that made this a
// separate function was in the parsing - which never needed a filesystem, and was
// only out of reach of the host suite because it sat inside a function that opens
// one. Anything that can be tested without a board belongs on this side of the line.
//
// Fields: ecu,did,state,reads,changes,first,last,note
static void didFormatLine(char *out, size_t cap, const DidRec &r) {
  char a[24], b[24];
  didHex(a, sizeof(a), r.first, r.len);
  didHex(b, sizeof(b), r.last, r.len);
  snprintf(out, cap, "%c,%04X,%s,%u,%u,%s,%s,", r.ecu ? 'T' : 'E', r.did,
           didStateName(r.state), r.reads, r.changes, a, b);
}

static bool didParseLine(const String &line, DidRec &r) {
  if (line.length() < 9 || line.startsWith("ecu,")) return false;

  // Split into fields rather than walking offsets. The version this replaces
  // searched for a comma from index 7 - which is already inside the state name - so
  // it found the comma AFTER the state, dropped it, and shifted every field one to
  // the left. Every record then reloaded as `unknown` with `changes` holding
  // whatever the first data byte happened to parse to as decimal, which turned a
  // whole block of status flags storing 01 into "varies" before a single read.
  String f[8];
  uint8_t nf = 0;
  int from = 0;
  while (nf < 8) {
    int c = line.indexOf(',', from);
    if (c < 0) { f[nf++] = line.substring(from); break; }
    f[nf++] = line.substring(from, c);
    from = c + 1;
  }
  if (nf < 7) return false;

  r = DidRec();
  r.ecu = (f[0] == "T") ? 1 : 0;
  r.did = (uint16_t)strtoul(f[1].c_str(), nullptr, 16);
  r.state = f[2] == "identified" ? DID_IDENTIFIED : f[2] == "varies" ? DID_VARIES
          : f[2] == "constant"   ? DID_CONSTANT   : DID_UNKNOWN;
  r.reads   = (uint16_t)f[3].toInt();
  r.changes = (uint16_t)f[4].toInt();
  r.len = didUnhex(f[5].c_str(), r.first, sizeof(r.first));
  didUnhex(f[6].c_str(), r.last, sizeof(r.last));

  // An invariant, not a formality: the first read establishes the baseline and
  // cannot itself be a change, so changes can never reach reads. A file saying
  // otherwise was written or parsed wrongly, and carrying those counters forward
  // reports the corruption as a finding about the car - which is exactly what
  // happened. Drop them and let triage rebuild from observation.
  if (r.reads && r.changes >= r.reads) { r.reads = 0; r.changes = 0; r.state = DID_UNKNOWN; }
  return true;
}

// ---------------------------------------------------------------- storage
//
// A file on LittleFS, not NVS. NVS holds small state that is written rarely - the
// sweep position, the watch set, the trend ring - and its erase budget is already
// spoken for; a second writer at this cadence would roughly double the churn. The
// register is a few hundred growing records, which is a file.
//
// A NEW file, deliberately not an extra column on /scanhits.csv. That reader is
// loose on purpose so an old export still loads, which means a changed format would
// be silently misparsed rather than rejected - and the sweep's own record is the one
// thing here that cannot be regenerated without hours of bus time.
//
// About 48 bytes a line, so 214 identifiers is around 10 KB against a 1.5 MB
// partition. It is rewritten whole rather than appended: verdicts change at most a
// few hundred times in the life of a car, so the simple thing costs nothing.

static DidRec *didMap    = nullptr;
static uint16_t didMapCap = 0;
static uint16_t didMapN   = 0;
static bool     didMapDirty = false;

static DidRec *didFind(uint8_t ecu, uint16_t did) {
  for (uint16_t i = 0; i < didMapN; i++)
    if (didMap[i].did == did && didMap[i].ecu == ecu) return &didMap[i];
  return nullptr;
}


static const char *DIDMAP_HEADER = "ecu,did,state,reads,changes,first,last,note";

static bool didMapSave() {
  if (!didMap || !tripFsUp) return false;
  File f = LittleFS.open(DIDMAP_FILE, FILE_WRITE);
  if (!f) return false;
  // A header, because this file is meant to be read by a person with a spreadsheet
  // as much as by the board.
  f.print(DIDMAP_HEADER);
  f.print('\n');
  char line[96];
  for (uint16_t i = 0; i < didMapN; i++) {
    didFormatLine(line, sizeof(line), didMap[i]);
    f.print(line);
    f.print('\n');
  }
  bool ok = (f.print('\n') != 0);
  f.close();
  if (ok) didMapDirty = false;
  return ok;
}

static void didMapLoad() {
  if (!didMap || !tripFsUp || !LittleFS.exists(DIDMAP_FILE)) return;
  File f = LittleFS.open(DIDMAP_FILE, FILE_READ);
  if (!f) return;
  while (f.available() && didMapN < didMapCap) {
    String line = f.readStringUntil('\n');
    DidRec r;
    if (!didParseLine(line, r)) continue;
    didMap[didMapN++] = r;
  }
  f.close();
  Serial.printf("[didmap] %u records loaded\n", didMapN);
}

// Every hit the sweep found gets a record, seeded from the value the sweep itself
// recorded - which is a free first observation, taken under whatever conditions the
// car was in hours or days ago. That is the baseline the first re-read is compared
// against, and it is why triage can produce a verdict on the very first pass rather
// than needing a second one to have anything to diff.
static void didMapSeed(const Hit *hits, uint16_t n) {
  if (!didMap) return;
  uint16_t added = 0;
  for (uint16_t i = 0; i < n && didMapN < didMapCap; i++) {
    if (didFind(hits[i].ecu, hits[i].did)) continue;
    DidRec r = {};
    r.did = hits[i].did;
    r.ecu = hits[i].ecu;
    r.state = DID_UNKNOWN;
    r.len = hits[i].len > sizeof(r.first) ? (uint8_t)sizeof(r.first) : hits[i].len;
    memcpy(r.first, hits[i].data, r.len);
    memcpy(r.last,  hits[i].data, r.len);
    // reads stays 0: the sweep's value is the baseline, not a triage observation.
    didMap[didMapN++] = r;
    added++;
  }
  if (added) { didMapDirty = true; Serial.printf("[didmap] %u new from the sweep\n", added); }
}

static void didMapBegin(uint16_t cap) {
  didMapCap = cap;
  if (!cap) return;
  size_t bytes = sizeof(DidRec) * cap;
  didMap = (DidRec *)(psramFound() ? ps_malloc(bytes) : malloc(bytes));
  if (!didMap) { didMapCap = 0; Serial.println("[didmap] no memory - register disabled"); return; }
  memset(didMap, 0, bytes);
  didMapLoad();
}

// Counts for the status endpoint and the page. Cheap enough to recompute per request
// rather than kept in sync, which is one fewer thing that can drift.
struct DidTally { uint16_t total, unknown, constant, varies, identified; };

static DidTally didMapTally() {
  DidTally t = {};
  t.total = didMapN;
  for (uint16_t i = 0; i < didMapN; i++) {
    switch (didMap[i].state) {
      case DID_CONSTANT:   t.constant++;   break;
      case DID_VARIES:     t.varies++;     break;
      case DID_IDENTIFIED: t.identified++; break;
      default:             t.unknown++;    break;
    }
  }
  return t;
}

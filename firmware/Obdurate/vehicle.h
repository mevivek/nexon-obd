#pragma once
#include <Arduino.h>

// What car is this, and what can it actually answer?
//
// Everything else in this firmware is written against one vehicle. The PID batches
// in the sketch are the set a Nexon replies to, the register holds 214 verdicts
// about a Nexon's ECU, and the dashboard draws tiles for readings that car
// publishes. Plug the board into anything else and none of that announces itself:
// the tiles that cannot be filled read blank, which is indistinguishable from a
// car that is simply not answering yet.
//
// So: ask. Mode 01 PID 00 and its continuations are a bitmap of every live PID the
// ECU supports, and mode 09 carries the VIN, the calibration id and its checksum.
// Both are reads, both are in the service allowlist the build enforces, and both
// are answered by every OBD-II car sold since the mandate.
//
// WHAT THIS DOES NOT DO
//
// It does not change what gets polled. The sampler still asks for the Nexon PID
// set and an unsupported reading still comes back absent - it is now labelled
// absent-because-unsupported instead of absent-because-silent, which is the whole
// difference between a dashboard that is broken and one that is honest. Adapting
// the batches to the car in front of it needs a vehicle-profile format, and
// designing that against a sample of one car is designing it blind.
//
// WHY THE BACKUP NEEDS THIS
//
// A restore writes /didmap.csv, and that file is 214 verdicts about one specific
// engine. Restored onto a different car it would not fail - it would attach,
// silently, and every conclusion drawn from it afterwards would be wrong. So a
// backup carries vehKey() and a restore refuses on a mismatch. The key is a hash,
// not the VIN: the whole point is comparing two backups, which a hash does exactly
// as well, and a hash is not the vehicle identifier of a real car sitting in a
// file that is meant to be copied around.
//
// Everything here is pure - no bus, no filesystem, no clock - so the parsers are
// compiled and exercised by the host suite rather than by driving somewhere.

static const uint8_t VEH_VIN_LEN = 17;   // ISO 3779
static const uint8_t VEH_CAL_LEN = 16;   // SAE J1979, one calibration id
static const uint8_t VEH_CVN_LEN = 4;    // calibration verification number, binary

// The mode 01 support bitmaps, one per 32-PID block. 0x00 covers PIDs 01-20,
// 0x20 covers 21-40, and so on to 0xE0. Eight blocks is the whole of mode 01.
static const uint8_t VEH_BLOCKS = 8;

struct Vehicle {
  char vin[VEH_VIN_LEN + 1] = {0};
  char cal[VEH_CAL_LEN + 1] = {0};
  char cvn[VEH_CVN_LEN * 2 + 1] = {0};   // hex, because a CVN is not text

  uint8_t m01[VEH_BLOCKS][4] = {{0}};    // mode 01 support, per block
  bool    m01Have[VEH_BLOCKS] = {false};
  uint8_t m09[4] = {0};                  // mode 09 support, PIDs 01-20
  bool    m09Have = false;

  // Set when the ECU answered "not supported" rather than not answering. The
  // distinction is the same one the sweep and mode 06 discovery already make, and
  // it is the difference between "this car has no VIN over OBD" and "the ignition
  // is off". Absent data must never satisfy a rule.
  bool vinRefused = false;
  bool calRefused = false;

  // Did a second ECU answer? The sketch knows two responder ids - the engine
  // controller and the transmission - and only ever addresses the first.
  //
  // Answered-or-refused means present. Silence does NOT mean absent: an ECU that
  // is not fitted and an ECU that is not talking yet are the same thing on a CAN
  // bus, and there is no frame that distinguishes them. So this stays false until
  // something replies, and the page has to say "did not answer" rather than
  // "not fitted" - which is the honest reading and also the useful one, because
  // the usual cause is that the walk ran before the car was properly awake.
  bool tcmSeen = false;
  bool tcmAsked = false;
};

// ---------------------------------------------------------------- support masks

// A support reply: `41 <base> b0 b1 b2 b3` for mode 01, `49 00 ...` for mode 09.
//
// The echoed pid is checked, not assumed. A reply to the previous request arriving
// late is the ordinary failure on this adapter, and writing the 0x20 block's bitmap
// into the 0x00 block's slot would report a car supporting PIDs it has never heard
// of - which is worse than reporting none, because the tiles would then be blamed
// on the car rather than on the read.
static bool vehMaskParse(const uint8_t *buf, int len, uint8_t mode,
                         uint8_t base, uint8_t *out4) {
  if (!buf || len < 6 || !out4) return false;
  if (buf[0] != (uint8_t)(mode + 0x40)) return false;
  if (buf[1] != base) return false;
  for (uint8_t i = 0; i < 4; i++) out4[i] = buf[2 + i];
  return true;
}

// Is `pid` supported, according to the bitmap for the block starting at `base`?
//
// The bitmap is big-endian by bit: the most significant bit of the first byte is
// base+1, and the least significant bit of the fourth byte is base+0x20.
static bool vehMaskHas(const uint8_t *m, uint8_t base, uint8_t pid) {
  if (!m) return false;
  if (pid <= base) return false;
  uint16_t off = (uint16_t)pid - (uint16_t)base;
  if (off > 32) return false;
  uint8_t idx = (uint8_t)(off - 1);
  return (m[idx / 8] >> (7 - (idx % 8))) & 1;
}

// The last bit of each bitmap is not a PID, it is "there is another block after
// this one". A car that stops at 0x20 leaves it clear, and walking on regardless
// wastes four more timeouts per pass on an ECU that has already said no.
static bool vehMaskMore(const uint8_t *m, uint8_t base) {
  if (base >= 0xE0) return false;          // no block after 0xE0; +0x20 would wrap
  return vehMaskHas(m, base, (uint8_t)(base + 0x20));
}

/** The base of block `i`: 0x00, 0x20, ... 0xE0. */
static uint8_t vehBlockBase(uint8_t i) { return (uint8_t)(i * 0x20); }

/** Which block a PID falls in, or 0xFF for one that is in none (0x00 itself). */
static uint8_t vehBlockOf(uint8_t pid) {
  if (pid == 0x00) return 0xFF;
  return (uint8_t)((pid - 1) / 0x20);
}

// Does this car support this live PID, given everything discovered so far?
//
// Unknown is not unsupported. A block whose bitmap never arrived returns false for
// `supported` and true for `unknown`, and the caller has to say which - the
// dashboard's honest answer for an unread block is "not asked yet", never "your car
// cannot do this".
static bool vehPidSupported(const Vehicle &v, uint8_t pid, bool *unknown = nullptr) {
  uint8_t b = vehBlockOf(pid);
  if (b >= VEH_BLOCKS) { if (unknown) *unknown = false; return false; }
  if (!v.m01Have[b])   { if (unknown) *unknown = true;  return false; }
  if (unknown) *unknown = false;
  return vehMaskHas(v.m01[b], vehBlockBase(b), pid);
}

// ---------------------------------------------------------------- mode 09 text

// One item out of a mode 09 text reply.
//
// The shape is `49 <pid> <count> <item>...`, where count is the number of items
// and every item is the same fixed width. Two things go wrong in the field and
// both are handled here rather than by the caller:
//
//   - Some ECUs omit the count byte entirely. Which layout arrived is decided by
//     arithmetic, not by hope: whichever of the two leaves a whole number of
//     items is the one that was sent.
//   - Items are padded. The VIN block is 17 bytes on a 20-byte ISO-TP payload and
//     the calibration id is very often a short string in a 16-byte field, padded
//     with NUL, space or 0xFF depending on who wrote the ECU.
//
// Returns the number of characters written, or 0 for anything that does not parse.
static uint8_t vehItemParse(const uint8_t *buf, int len, uint8_t pid,
                            uint8_t itemLen, char *out, size_t cap) {
  if (!buf || !out || cap < (size_t)itemLen + 1 || itemLen == 0) return 0;
  out[0] = 0;
  if (len < 3 || buf[0] != 0x49 || buf[1] != pid) return 0;

  int body = len - 3;                        // assume the count byte is present
  int at   = 3;
  if (body <= 0 || body % itemLen != 0) {
    body = len - 2;                          // no count byte
    at   = 2;
    if (body <= 0 || body % itemLen != 0) return 0;
  }
  if (body < itemLen) return 0;

  // Leading padding first: a right-aligned calibration id in a 16-byte field is
  // common, and trimming only the tail would leave the string starting with NULs.
  int s = at, e = at + itemLen - 1;
  while (s <= e && (buf[s] == 0x00 || buf[s] == 0x20 || buf[s] == 0xFF)) s++;
  while (e >= s && (buf[e] == 0x00 || buf[e] == 0x20 || buf[e] == 0xFF)) e--;

  uint8_t n = 0;
  for (int i = s; i <= e && n < itemLen; i++) {
    const uint8_t c = buf[i];
    if (c < 0x20 || c > 0x7E) return 0;      // not text: report nothing, not rubbish
    out[n++] = (char)c;
  }
  out[n] = 0;
  return n;
}

// Is this a VIN, or is it seventeen bytes that happened to be printable?
//
// ISO 3779 excludes I, O and Q precisely because they are misread as 1, 0 and 0,
// so a string containing one is not a VIN however well it survived the parser.
// This is the guard on vehKey(): a garbled read that passed for a VIN would give a
// backup a key its own car does not match, and the restore would refuse a file
// that was fine.
static bool vehVinOk(const char *s) {
  if (!s) return false;
  size_t n = strlen(s);
  if (n != VEH_VIN_LEN) return false;
  for (size_t i = 0; i < n; i++) {
    const char c = s[i];
    const bool digit = (c >= '0' && c <= '9');
    const bool alpha = (c >= 'A' && c <= 'Z') && c != 'I' && c != 'O' && c != 'Q';
    if (!digit && !alpha) return false;
  }
  return true;
}

/** The CVN, as hex. Four opaque bytes - a checksum over the calibration, not text. */
static uint8_t vehCvnParse(const uint8_t *buf, int len, char *out, size_t cap) {
  if (!buf || !out || cap < VEH_CVN_LEN * 2 + 1) return 0;
  out[0] = 0;
  if (len < 3 || buf[0] != 0x49 || buf[1] != 0x06) return 0;

  int body = len - 3, at = 3;
  if (body <= 0 || body % VEH_CVN_LEN != 0) {
    body = len - 2; at = 2;
    if (body <= 0 || body % VEH_CVN_LEN != 0) return 0;
  }
  static const char VEH_HEX[] = "0123456789ABCDEF";
  for (uint8_t i = 0; i < VEH_CVN_LEN; i++) {
    out[i * 2]     = VEH_HEX[(buf[at + i] >> 4) & 0x0F];
    out[i * 2 + 1] = VEH_HEX[buf[at + i] & 0x0F];
  }
  out[VEH_CVN_LEN * 2] = 0;
  return VEH_CVN_LEN * 2;
}

// ---------------------------------------------------------------- identity key

// The identity a backup carries and a restore checks.
//
// FNV-1a over whichever of the VIN and the calibration id are known, and an empty
// string when neither is. Empty is the important case and it is not an error: a
// board that has never been plugged into a running car has nothing to key on, and
// the answer to "is this backup from this car" is then honestly "cannot tell" -
// which the UI has to put in front of somebody, not decide on their behalf.
//
// A hash rather than the identifiers themselves, because a backup file is meant to
// be copied to a phone, a laptop and wherever else, and the VIN of a real car does
// not need to travel with it to answer the only question being asked of it.
static void vehKey(const Vehicle &v, char *out, size_t cap) {
  if (!out || cap < 9) return;
  out[0] = 0;

  const bool haveVin = vehVinOk(v.vin);
  const bool haveCal = v.cal[0] != 0;
  if (!haveVin && !haveCal) return;

  uint32_t h = 2166136261u;
  if (haveVin) for (const char *p = v.vin; *p; p++) h = (h ^ (uint8_t)*p) * 16777619u;
  h = (h ^ (uint8_t)'|') * 16777619u;
  if (haveCal) for (const char *p = v.cal; *p; p++) h = (h ^ (uint8_t)*p) * 16777619u;

  static const char VEH_HEX[] = "0123456789abcdef";
  for (uint8_t i = 0; i < 8; i++) out[i] = VEH_HEX[(h >> (28 - i * 4)) & 0x0F];
  out[8] = 0;
}

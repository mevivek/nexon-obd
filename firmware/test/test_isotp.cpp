// Tests for the ISO-TP reassembly contract and the mode-01 batch poller.
//
// The bug these were written for: a truncated multi-frame reply used to come back
// as a short-but-positive length, indistinguishable from a complete one. pollBatch
// parsed it, applied whichever PIDs had arrived, and left the rest of Live at NAN
// - which /data serialises as null and the dashboard renders as blanks over the
// top of readings that were fine a moment earlier.

#include "shims.h"
#include "isotp_extract.h"
#include "../Obdurate/didwatch.h"
#include "../Obdurate/trip_names.h"
#include "../Obdurate/ui_paths.h"
#include "didmap_extract.h"

#include <cstdio>

static int g_fail = 0, g_ran = 0;

static void ok(bool cond, const char *what) {
  g_ran++;
  if (!cond) { g_fail++; printf("  FAIL  %s\n", what); }
  else       { printf("  ok    %s\n", what); }
}

static void eq(int got, int want, const char *what) {
  g_ran++;
  if (got != want) { g_fail++; printf("  FAIL  %s (got %d, want %d)\n", what, got, want); }
  else             { printf("  ok    %s\n", what); }
}

// ------------------------------------------------------------------ canIsoTp

static void test_can_single_frame() {
  printf("canIsoTp: single frame\n");
  resetBus();
  uint8_t req[2] = {0x01, 0x00}, out[64];
  rx(0x7E8, {0x06, 0x41, 0x00, 0xBE, 0x3E, 0xA8, 0x13});
  int n = canIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400);
  eq(n, 6, "returns the payload length");
  ok(out[0] == 0x41 && out[1] == 0x00 && out[5] == 0x13, "payload bytes are intact");
}

static void test_can_ignores_other_ecu() {
  printf("canIsoTp: demultiplexes by responder id\n");
  resetBus();
  uint8_t req[2] = {0x01, 0x00}, out[64];
  rx(0x7E9, {0x06, 0x41, 0x00, 0x88, 0x18, 0x80, 0x01});   // TCM answers first
  rx(0x7E8, {0x06, 0x41, 0x00, 0xBE, 0x3E, 0xA8, 0x13});   // ECM
  int n = canIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400);
  eq(n, 6, "returns a payload");
  ok(out[2] == 0xBE, "took the ECM mask, not the TCM's");
}

static void test_can_negative_response() {
  printf("canIsoTp: negative response\n");
  resetBus();
  uint8_t req[3] = {0x22, 0xF1, 0x90}, out[64];
  rx(0x7E8, {0x03, 0x7F, 0x22, 0x31});                     // requestOutOfRange
  eq(canIsoTp(0x7E0, 0x7E8, req, 3, out, sizeof(out), 400), -2, "reports -2");
}

static void test_can_response_pending() {
  printf("canIsoTp: 0x78 responsePending then the real answer\n");
  resetBus();
  uint8_t req[3] = {0x22, 0xF1, 0x8A}, out[64];
  rx(0x7E8, {0x03, 0x7F, 0x22, 0x78});
  rx(0x7E8, {0x05, 0x62, 0xF1, 0x8A, 0x42, 0x4F});
  eq(canIsoTp(0x7E0, 0x7E8, req, 3, out, sizeof(out), 400), 5, "waits and returns the answer");
}

static void test_can_multiframe_complete() {
  printf("canIsoTp: complete multi-frame\n");
  resetBus();
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});   // FF, total 14
  rx(0x7E8, {0x21, 0x0B, 0x28, 0x11, 0x1A, 0x04, 0x2E, 0x05});   // CF 1
  rx(0x7E8, {0x22, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55});   // CF 2
  int n = canIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 400);
  eq(n, 14, "returns the full reassembled length");
  ok(out[0] == 0x41 && out[1] == 0x0C, "first frame bytes land at the start");
  ok(out[6] == 0x0B && out[7] == 0x28, "consecutive frame bytes follow on");
  ok(g_tx.size() >= 2 && g_tx[1].data[0] == 0x30, "flow control was sent");
}

static void test_can_multiframe_truncated() {
  printf("canIsoTp: multi-frame that stops after the first frame\n");
  resetBus();
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});   // FF, no CFs follow
  // Used to return 6 here, which looks exactly like a complete short reply.
  eq(canIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 400), -3, "reports -3, not a short length");
}

static void test_can_dropped_consecutive_frame() {
  printf("canIsoTp: consecutive frame dropped mid-reassembly\n");
  resetBus();
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  rx(0x7E8, {0x10, 0x14, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});   // FF, total 20
  rx(0x7E8, {0x22, 0x0B, 0x28, 0x11, 0x1A, 0x04, 0x2E, 0x05});   // seq 2 - seq 1 lost
  eq(canIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 400), -3, "reports -3 on a sequence gap");
}

static void test_can_oversize_reply() {
  printf("canIsoTp: reply larger than the caller's buffer\n");
  resetBus();
  uint8_t req[3] = {0x22, 0xF1, 0x90}, out[8];
  rx(0x7E8, {0x10, 0x28, 0x62, 0xF1, 0x90, 0x4D, 0x41, 0x54});   // total 40 into 8 bytes
  eq(canIsoTp(0x7E0, 0x7E8, req, 3, out, sizeof(out), 400), -3, "refuses rather than half-copying");
}

static void test_can_silent() {
  printf("canIsoTp: no reply at all\n");
  resetBus();
  uint8_t req[2] = {0x01, 0x00}, out[64];
  eq(canIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400), -1, "reports -1");
}

// A single frame is one PCI byte and seven of payload. The request was memcpy'd into
// an eight-byte stack buffer with no bound, and the largest caller in the firmware -
// the mode 01 batch, six PIDs plus the mode byte - passes exactly 7. At the limit
// with nothing spare: a seventh PID in a batch, or two DIDs packed into one 0x22
// request, would have written past the frame and said nothing about it.
static void test_can_rejects_an_overlong_request() {
  printf("canIsoTp: a request that cannot fit one frame\n");
  resetBus();
  uint8_t req[8] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05, 0x0F}, out[64];
  eq(canIsoTp(0x7E0, 0x7E8, req, 8, out, sizeof(out), 400), -1, "is refused");
  ok(g_tx.empty(), "and nothing is put on the bus");
}

static void test_can_still_sends_a_full_single_frame() {
  printf("canIsoTp: seven payload bytes still fit\n");
  resetBus();
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  rx(0x7E8, {0x03, 0x41, 0x0C, 0x1A});
  eq(canIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 400), 3, "still exchanges");
  ok(g_tx.size() == 1 && g_tx[0].data[0] == 0x07, "and the PCI byte says seven");
}

// ------------------------------------------------------------------ did register
//
// Triage decides which of a sweep's hits are worth a watch slot. The verdict is a
// pure function of what was observed, so the rules can be tested rather than driven
// at a car for six minutes a round.
//
// The rule that matters most: "constant" is provisional and "varies" is not. One
// observed change is proof; any number of unchanged reads is only absence of proof.

static DidRec mk(uint8_t b0) {
  DidRec r = {};
  r.did = 0x1002; r.ecu = 0; r.len = 1; r.first[0] = b0; r.last[0] = b0;
  return r;
}

static void test_did_unknown_until_enough_reads() {
  printf("didmap: no verdict before there is evidence\n");
  DidRec r = mk(0x10);
  for (int i = 0; i < DIDMAP_CONST_READS - 1; i++) {
    uint8_t v = 0x10;
    didObserve(r, &v, 1);
  }
  eq(r.state, DID_UNKNOWN, "still unknown one read short");
  uint8_t v = 0x10;
  didObserve(r, &v, 1);
  eq(r.state, DID_CONSTANT, "and constant on the last one");
}

static void test_did_one_change_is_proof() {
  printf("didmap: a single change settles it\n");
  DidRec r = mk(0x10);
  uint8_t a = 0x10, b = 0x11;
  didObserve(r, &a, 1);            // baseline read
  didObserve(r, &b, 1);            // changed
  eq(r.state, DID_VARIES, "varies after one change");
  eq((int)r.changes, 1, "and counts it");
  // And it does not decay: a hundred unchanged reads afterwards do not make a
  // value that demonstrably moved into a constant one.
  for (int i = 0; i < 100; i++) didObserve(r, &b, 1);
  eq(r.state, DID_VARIES, "and never reverts to constant");
}

static void test_did_sweep_value_is_a_baseline_not_a_read() {
  printf("didmap: the sweep's value is a baseline, not an observation\n");
  // A record seeded from the sweep has reads == 0. The first triage read must
  // establish the comparison rather than count as a change against a value that was
  // recorded under different conditions and possibly a different truncation.
  DidRec r = mk(0x10);
  eq((int)r.reads, 0, "seeded with no reads");
  uint8_t v = 0x99;
  didObserve(r, &v, 1);
  eq((int)r.changes, 0, "the first read is not a change");
  eq((int)r.reads, 1, "but it is a read");
}

static void test_did_length_change_is_a_change() {
  printf("didmap: a different length is a different value\n");
  DidRec r = mk(0x10);
  uint8_t one = 0x10;
  didObserve(r, &one, 1);
  uint8_t two[2] = {0x10, 0x00};
  didObserve(r, two, 2);
  eq(r.state, DID_VARIES, "one byte becoming two counts");
}

static void test_did_identification_outranks_the_machine() {
  printf("didmap: a human identification is not overwritten\n");
  // Somebody has said what this is. Re-reading it must not quietly relabel it, or
  // a triage run started later would erase the findings it exists to accumulate.
  DidRec r = mk(0x10);
  r.state = DID_IDENTIFIED;
  uint8_t a = 0x10, b = 0x22;
  didObserve(r, &a, 1);
  didObserve(r, &b, 1);
  eq(r.state, DID_IDENTIFIED, "still identified after a change");
  eq((int)r.changes, 1, "though the change is still recorded");
}

static void test_did_verdict_is_pure() {
  printf("didmap: the verdict rules, directly\n");
  eq(didVerdict(DID_UNKNOWN, 0, 0), DID_UNKNOWN, "nothing observed");
  eq(didVerdict(DID_UNKNOWN, DIDMAP_CONST_READS, 0), DID_CONSTANT, "enough quiet reads");
  eq(didVerdict(DID_UNKNOWN, 1, 1), DID_VARIES, "one change, however few reads");
  eq(didVerdict(DID_CONSTANT, 999, 1), DID_VARIES, "a change overrides a constant verdict");
  eq(didVerdict(DID_IDENTIFIED, 999, 999), DID_IDENTIFIED, "identification is final");
}

static void test_did_hex_round_trip() {
  printf("didmap: hex encoding round-trips\n");
  uint8_t in[4] = {0x00, 0x1F, 0xA3, 0xFF}, out[4] = {0};
  char hex[16];
  didHex(hex, sizeof(hex), in, 4);
  ok(strcmp(hex, "001FA3FF") == 0, "encodes uppercase, zero padded");
  eq(didUnhex(hex, out, 4), 4, "decodes the same count");
  ok(memcmp(in, out, 4) == 0, "and the same bytes");
  // A truncated field must not invent a byte from one nibble.
  eq(didUnhex("A", out, 4), 0, "a lone nibble decodes to nothing");
}

static void test_did_state_names_round_trip() {
  printf("didmap: state names are the file format\n");
  // These strings are the on-disk format and the JSON the page reads. A rename
  // here silently turns every stored record back into "unknown" on the next load,
  // which would erase a register built up over weeks.
  ok(strcmp(didStateName(DID_UNKNOWN),    "unknown")    == 0, "unknown");
  ok(strcmp(didStateName(DID_CONSTANT),   "constant")   == 0, "constant");
  ok(strcmp(didStateName(DID_VARIES),     "varies")     == 0, "varies");
  ok(strcmp(didStateName(DID_IDENTIFIED), "identified") == 0, "identified");
  // Anything unrecognised reads back as unknown rather than as a neighbouring
  // state - a corrupt byte must not promote a record to identified.
  ok(strcmp(didStateName(99), "unknown") == 0, "an unknown byte is not a verdict");
  ok(strcmp(DIDMAP_FILE, "/didmap.csv") == 0, "the register has its own file");
  ok(strcmp(DIDMAP_FILE, "/scanhits.csv") != 0, "and never the sweep's own record");
}

// ------------------------------------------------------------------ battery floor
//
// The rule that decides whether the board switches itself off to save the car's
// battery. Testable because it is a pure step over the run of low readings - the
// alternative is a test that needs a flat car and can be run once.
//
// The expensive mistake in both directions: sleeping while the engine is cranking
// (the rail is at its lowest exactly then) or while the reading is simply absent,
// and never sleeping at all on a car whose ECU keeps answering with nothing
// charging.

static void test_batt_ignores_absent_readings() {
  printf("battery floor: an unread value is not a low value\n");
  // The same rule voltFlag() follows on the page, where `null < 12.2` being true in
  // JavaScript reported healthy charging systems as broken. Here the equivalent
  // mistake would switch the board off in the middle of a drive.
  eq((int)battLowStep(0, NAN, 0.0f, 5000), 0, "no voltage: no run starts");
  eq((int)battLowStep(0, 11.0f, NAN, 5000), 0, "no rpm: no run starts");
  eq((int)battLowStep(4000, NAN, 0.0f, 5000), 0, "and an existing run is broken");
}

static void test_batt_never_while_the_engine_runs() {
  printf("battery floor: a turning engine is proof something is charging\n");
  eq((int)battLowStep(0, 11.0f, 800.0f, 5000), 0, "idling at 11.0 V does not count");
  eq((int)battLowStep(4000, 9.5f, 2500.0f, 5000), 0, "and breaks a run in progress");
}

static void test_batt_survives_cranking() {
  printf("battery floor: cranking does not trip it\n");
  // The rail sits at nine volts and below for about a second while the starter
  // turns, which is the one moment a naive threshold would fire.
  uint32_t run = 0, t = 1000;
  for (int i = 0; i < 10; i++) { run = battLowStep(run, 9.2f, 0.0f, t); t += 100; }
  ok(run != 0, "a run does start - the reading really is low");
  ok(t - run < BATT_SLEEP_HOLD_MS, "but a second of it is nowhere near the hold");
  // Then it fires and the rail recovers.
  run = battLowStep(run, 13.8f, 900.0f, t);
  eq((int)run, 0, "and the run is broken the moment it recovers");
}

static void test_batt_fires_on_a_sustained_low() {
  printf("battery floor: sustained low with the engine stopped\n");
  uint32_t run = 0, t = 1000;
  run = battLowStep(run, 11.5f, 0.0f, t);
  ok(run == t, "the run starts at the first low reading");
  for (int i = 0; i < 60; i++) { t += 1000; run = battLowStep(run, 11.5f, 0.0f, t); }
  eq((int)run, 1000, "and keeps its original start rather than sliding forward");
  ok(t - run >= BATT_SLEEP_HOLD_MS, "so the hold is reached");
}

static void test_batt_boundary_is_not_low() {
  printf("battery floor: the threshold itself is not below it\n");
  eq((int)battLowStep(0, BATT_SLEEP_V, 0.0f, 5000), 0, "exactly at the floor is fine");
  ok(battLowStep(0, BATT_SLEEP_V - 0.01f, 0.0f, 5000) != 0, "just under it is not");
  eq((int)battLowStep(0, 11.0f, BATT_ENGINE_RPM, 5000), 0, "exactly at cranking rpm counts as running");
}

static void test_batt_run_can_start_at_time_zero() {
  printf("battery floor: a run beginning in the first millisecond\n");
  // 0 is the sentinel for "not low", so a run starting at millis() == 0 would never
  // start at all if the timestamp were stored as it comes.
  ok(battLowStep(0, 11.0f, 0.0f, 0) != 0, "still starts a run");
}

// ------------------------------------------------------------------ HTTP yield
//
// The transports serve the web server while they wait on the car, so a tab switch
// no longer queues behind a full ISO-TP exchange. Two things have to hold for that
// to be safe: the time spent serving must be given back to the response deadline
// (or every page load would show up as a phantom ECU timeout), and the give-back
// must be bounded (or one slow handler could hold an exchange open forever).

static void test_yield_only_while_idle() {
  printf("yield: only when there is nothing on the bus\n");
  resetBus();
  g_yieldCostMs = 50;
  uint8_t req[2] = {0x01, 0x00}, out[64];
  rx(0x7E8, {0x06, 0x41, 0x00, 0xBE, 0x3E, 0xA8, 0x13});
  eq(canIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400), 6, "reply still parsed");
  eq(g_yieldCalls, 0, "a waiting frame is taken before the web server gets a turn");
}

static void test_yield_extends_the_deadline() {
  printf("yield: time spent serving is not charged to the ECU\n");
  resetBus();
  g_yieldCostMs = 100;                       // every yield serves a request
  uint8_t req[2] = {0x01, 0x00}, out[64];
  uint32_t start = g_millis;
  eq(canIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400), -1,
     "a genuinely silent ECU is still reported silent");
  uint32_t elapsed = g_millis - start;
  ok(g_yieldCalls > 1, "served the web server while it waited");
  ok(elapsed > 400 + 1000,
     "waited well past the raw timeout, because the wait was spent serving pages");
  ok(elapsed < 400 + YIELD_EXTEND_MAX_MS + 200,
     "but not indefinitely - the extension is capped");
}

static void test_yield_extension_is_bounded() {
  printf("yield: the give-back is bounded\n");
  g_millis = 1000;
  g_yieldCostMs = 500;                       // a slow handler: a trip download, say
  g_yieldCalls = 0;
  uint32_t deadline = 1400, extended = 0;
  for (int i = 0; i < 20; i++) busWaitYield(deadline, extended);
  eq((int)extended, (int)YIELD_EXTEND_MAX_MS, "stops extending at the cap");
  eq((int)deadline, (int)(1400 + YIELD_EXTEND_MAX_MS), "and the deadline moved by exactly that");
}

static void test_yield_costing_nothing_changes_nothing() {
  printf("yield: an idle server does not move the deadline\n");
  g_millis = 1000;
  g_yieldCostMs = 0;                         // nothing queued, accept() returns at once
  uint32_t deadline = 1400, extended = 0;
  for (int i = 0; i < 20; i++) busWaitYield(deadline, extended);
  eq((int)extended, 0, "nothing served, nothing given back");
  eq((int)deadline, 1400, "deadline untouched");
}

static void test_bus_guard_is_visible_from_a_yield() {
  printf("yield: a handler reached from a yield can see the bus is busy\n");
  resetBus();
  g_yieldCostMs = 100;
  uint8_t req[2] = {0x01, 0x00}, out[64];
  eq(obdIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400), -1, "exchange timed out");
  ok(g_yieldSawBusBusy, "the guard was set for the whole exchange");
  ok(!g_busBusy, "and cleared on the way out, even though the exchange failed");

  resetBus();
  g_yieldCostMs = 100;
  rx(0x7E8, {0x06, 0x41, 0x00, 0xBE, 0x3E, 0xA8, 0x13});
  eq(obdIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 400), 6, "exchange succeeded");
  ok(!g_busBusy, "guard cleared on the success path too");
}

// ------------------------------------------------------------------ bleIsoTp

static void test_ble_single_frame() {
  printf("bleIsoTp: single frame\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[2] = {0x01, 0x00}, out[64];
  g_elmReplies.push_back(String("7E8 06 41 00 BE 3E A8 13\r>"));
  int n = bleIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 900);
  eq(n, 6, "returns the payload length");
  ok(out[0] == 0x41 && out[4] == 0xA8, "payload bytes are intact");
}

static void test_ble_ignores_other_ecu() {
  printf("bleIsoTp: demultiplexes by header (ATCRA does not filter)\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[2] = {0x01, 0x00}, out[64];
  g_elmReplies.push_back(String("7E9 06 41 00 88 18 80 01\r7E8 06 41 00 BE 3E A8 13\r>"));
  int n = bleIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 900);
  eq(n, 6, "returns a payload");
  ok(out[2] == 0xBE, "took the ECM mask, not the TCM's");
}

static void test_ble_multiframe_complete() {
  printf("bleIsoTp: complete multi-frame\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  g_elmReplies.push_back(String(
      "7E8 10 0E 41 0C 0A F0 0D 00\r"
      "7E8 21 0B 28 11 1A 04 2E 05\r"
      "7E8 22 55 55 55 55 55 55 55\r>"));
  int n = bleIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 900);
  eq(n, 14, "returns the full reassembled length");
  ok(out[0] == 0x41 && out[6] == 0x0B, "bytes are in order across frames");
}

static void test_ble_dropped_frame() {
  printf("bleIsoTp: adapter drops a consecutive frame\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  g_elmReplies.push_back(String(
      "7E8 10 14 41 0C 0A F0 0D 00\r"
      "7E8 22 0B 28 11 1A 04 2E 05\r>"));   // seq 1 never arrived
  // Used to return 13 - the seq-2 bytes silently slotted into the seq-1 gap.
  eq(bleIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 900), -3, "reports -3 on a sequence gap");
}

static void test_ble_incomplete_multiframe() {
  printf("bleIsoTp: multi-frame that never finishes\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[7] = {0x01, 0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05}, out[64];
  g_elmReplies.push_back(String("7E8 10 0E 41 0C 0A F0 0D 00\r>"));
  eq(bleIsoTp(0x7E0, 0x7E8, req, 7, out, sizeof(out), 900), -3, "reports -3, not a short length");
}

static void test_ble_no_data() {
  printf("bleIsoTp: NO DATA\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[2] = {0x01, 0x00}, out[64];
  g_elmReplies.push_back(String("NO DATA\r>"));
  eq(bleIsoTp(0x7E0, 0x7E8, req, 2, out, sizeof(out), 900), -1, "reports -1");
}

static void test_ble_negative() {
  printf("bleIsoTp: negative response\n");
  resetBus();
  activeTransport = TR_BLE;
  uint8_t req[3] = {0x22, 0xF1, 0x90}, out[64];
  g_elmReplies.push_back(String("7E8 03 7F 22 31\r>"));
  eq(bleIsoTp(0x7E0, 0x7E8, req, 3, out, sizeof(out), 900), -2, "reports -2");
}

// ------------------------------------------------------------------ pollBatch

// The sampler's real first batch: rpm, speed, map, throttle, load, coolant.
static const uint8_t *const B1 = PID_B1;

// A complete 6-PID reply: 41 + 0C 0AF0 + 0D 00 + 0B 28 + 11 1A + 04 2E + 05 5A.
static void queueGoodBatch() {
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});
  rx(0x7E8, {0x21, 0x0B, 0x28, 0x11, 0x1A, 0x04, 0x2E, 0x05});
  rx(0x7E8, {0x22, 0x5A, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55});
}

static void test_batch_complete() {
  printf("pollBatch: complete reply\n");
  resetBus();
  Live L;
  queueGoodBatch();
  ok(pollBatch(L, B1, 6), "returns true");
  eq((int)L.rpm, 700, "rpm decoded");           // 0x0AF0 / 4
  eq((int)L.coolant, 50, "coolant decoded");    // 0x5A - 40
  eq((int)L.map_, 40, "map decoded");           // 0x28
}

static void test_batch_retries_for_a_complete_reply() {
  printf("pollBatch: first attempt truncated, retry completes it\n");
  resetBus();
  Live L;
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});   // truncated attempt
  queueGoodBatch();                                              // retry answers fully
  ok(pollBatch(L, B1, 6), "returns true");
  eq((int)L.rpm, 700, "rpm from the complete retry");
  ok(!isnan(L.coolant), "coolant, present only in the complete reply, is decoded");
}

static void test_batch_salvages_verified_partial() {
  printf("pollBatch: truncated twice, but the fragment verifies\n");
  resetBus();
  Live L;
  // Both attempts stop after the first frame. Those six bytes are still a valid
  // mode-01 message - 41, then 0C with two data bytes, then 0D with one - so the
  // pairs that did arrive are provably correct and worth keeping. Discarding them
  // is what left the BLE dashboard blank at a third of a hertz.
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});
  ok(pollBatch(L, B1, 6), "returns true on a verified fragment");
  eq((int)L.rpm, 700, "the pid that arrived intact is applied");
  eq((int)L.speed, 0, "and the next one");
  // Everything past the cut is left alone rather than guessed at; the dashboard
  // holds those fields at their previous reading.
  ok(isnan(L.coolant), "pids past the cut are left untouched");
  ok(isnan(L.load), "and so are the rest");
}

static void test_batch_rejects_misframed() {
  printf("pollBatch: reply containing a pid we never asked for\n");
  resetBus();
  Live L;
  // 0x99 was not in the request, so the bytes are not the message they claim to be
  // and none of them can be trusted - not even the pair before the bad pid.
  rx(0x7E8, {0x05, 0x41, 0x0C, 0x0A, 0xF0, 0x99, 0x55, 0x55});
  rx(0x7E8, {0x05, 0x41, 0x0C, 0x0A, 0xF0, 0x99, 0x55, 0x55});
  ok(!pollBatch(L, B1, 6), "returns false");
  ok(isnan(L.rpm), "nothing from a misframed reply is applied");
}

static void test_new_pid_lengths() {
  printf("pidLen: the demand/delivery PIDs\n");
  // A wrong length is not a wrong number - mode01Walk validates against pidLen, so
  // it rejects the batch outright. That is the safety net for PIDs added without a
  // car to check them against, but it means the lengths have to be right or those
  // readings simply never appear.
  eq(pidLen(0x49), 1, "accelerator pedal D is one byte");
  eq(pidLen(0x4A), 1, "accelerator pedal E is one byte");
  eq(pidLen(0x4C), 1, "commanded throttle is one byte");
  eq(pidLen(0x61), 1, "demanded torque is one byte");
  eq(pidLen(0x62), 1, "actual torque is one byte");
  eq(pidLen(0x43), 2, "absolute load is two");
  eq(pidLen(0x63), 2, "reference torque is two");

  // ...and a b4 reply has to walk cleanly end to end with those lengths.
  uint8_t reply[] = {0x41, 0x49, 0x33, 0x4A, 0x34, 0x4C, 0x28,
                     0x61, 0x8C, 0x62, 0x8A, 0x43, 0x00, 0x64};
  Live L;
  eq(mode01Walk(reply, sizeof(reply), PID_B4, 6, &L), 6, "a full b4 reply verifies");
  eq((int)L.pedalD, 20, "pedal decodes");            // 0x33 * 100 / 255
  eq((int)L.torqDem, 15, "demanded torque decodes"); // 0x8C - 125
  eq((int)L.torqAct, 13, "actual torque decodes");   // 0x8A - 125
}

static void test_mode01_walk() {
  printf("mode01Walk: verification\n");
  static const uint8_t pids[2] = {0x0C, 0x05};
  uint8_t good[] = {0x41, 0x0C, 0x0A, 0xF0, 0x05, 0x5A};
  eq(mode01Walk(good, 6, pids, 2, nullptr), 2, "a complete reply verifies both pairs");

  uint8_t cut[] = {0x41, 0x0C, 0x0A, 0xF0, 0x05};          // 0x05 has no data byte
  eq(mode01Walk(cut, 5, pids, 2, nullptr), 1, "a value cut in half is not counted");

  uint8_t alien[] = {0x41, 0x0C, 0x0A, 0xF0, 0x99, 0x01};  // 0x99 never requested
  eq(mode01Walk(alien, 6, pids, 2, nullptr), -1, "an unrequested pid rejects the reply");

  uint8_t wrongMode[] = {0x43, 0x0C, 0x0A, 0xF0};
  eq(mode01Walk(wrongMode, 4, pids, 2, nullptr), -1, "a non-0x41 reply is rejected");
}

static void test_batch_silent_does_not_retry() {
  printf("pollBatch: silent ECU\n");
  resetBus();
  Live L;
  uint32_t t0 = g_millis;
  ok(!pollBatch(L, B1, 6), "returns false");
  // One 400 ms window, not two: retrying a silent bus would triple the latency of
  // /data with the ignition off, since a sample is three of these.
  ok(g_millis - t0 < 800, "did not burn a second timeout");
}

// ------------------------------------------------------------------ mode 06

static void test_mon_mask() {
  printf("monMaskMids: support masks and how the ranges chain\n");
  uint8_t out[32];

  // The exact reply FINDINGS records from this car: 46 00 C0 00 00 01.
  // C0 is the top two bits of the first byte - monitors 01 and 02 - and the very
  // last bit is id 20, which is not a monitor but the marker saying the next range
  // has its own mask.
  uint8_t real[] = {0x46, 0x00, 0xC0, 0x00, 0x00, 0x01};
  uint8_t n = monMaskMids(real, sizeof(real), 0x00, out, 32);
  eq(n, 3, "three bits set");
  eq(out[0], 0x01, "monitor 01");
  eq(out[1], 0x02, "monitor 02");
  eq(out[2], 0x20, "and the next-range marker");

  // Bit ordering is most significant first, and the range is relative to the base.
  uint8_t hi[] = {0x46, 0x20, 0x80, 0x00, 0x00, 0x00};
  eq(monMaskMids(hi, sizeof(hi), 0x20, out, 32), 1, "one bit set in the 20 range");
  eq(out[0], 0x21, "the first id of that range, not of the first range");

  // A reply for a different base than we asked about is not ours to read.
  eq(monMaskMids(real, sizeof(real), 0x20, out, 32), 0, "a mismatched base is rejected");
  uint8_t stub[] = {0x46, 0x00, 0xC0};
  eq(monMaskMids(stub, sizeof(stub), 0x00, out, 32), 0, "a short mask is rejected");
}

static void test_mon_parse() {
  printf("monParse: nine-byte test records\n");
  MonRec r[12];
  uint8_t reply[] = {0x46,
                     0x01, 0x01, 0x0B, 0x02, 0x30, 0x01, 0x00, 0x03, 0x00,
                     0x01, 0x02, 0x0B, 0x00, 0x90, 0x00, 0x40, 0x01, 0x80};
  eq(monParse(reply, sizeof(reply), r, 12), 2, "both records are read");
  eq(r[0].mid, 0x01, "monitor id");
  eq(r[0].tid, 0x01, "test id");
  eq(r[0].uas, 0x0B, "unit and scaling id is kept, not interpreted");
  eq((int)r[0].value, 0x0230, "value is a 16-bit word");
  eq((int)r[0].lo, 0x0100, "as is the lower limit");
  eq((int)r[0].hi, 0x0300, "and the upper");
  eq(r[1].tid, 0x02, "the second record follows on");

  // A reply cut mid-record must drop the fragment rather than read past it.
  eq(monParse(reply, 14, r, 12), 1, "a trailing part-record is ignored");
  uint8_t wrong[] = {0x41, 0x01, 0x01, 0x0B, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  eq(monParse(wrong, sizeof(wrong), r, 12), 0, "a reply that is not mode 06 is rejected");
  eq(monParse(reply, sizeof(reply), r, 1), 1, "the caller's capacity is respected");
}

// ------------------------------------------------------------------ reconnect

static void test_pick_backoff() {
  printf("pickBackoff: impatient first, then eases off\n");
  // The adapter is powered from the OBD port and outlives the board, which runs off
  // the accessory socket. Every start therefore meets an ELM327 that may still be
  // holding the link to a device that vanished without disconnecting, so the first
  // connect can fail for reasons that will clear on their own in seconds. Waiting a
  // flat twenty seconds to find that out meant a dead dashboard at every ignition.
  eq((int)pickBackoff(0), (int)PICK_MIN_MS, "starts at the minimum");
  eq((int)pickBackoff(PICK_MIN_MS), 4000, "then doubles");
  eq((int)pickBackoff(4000), 8000, "and again");
  eq((int)pickBackoff(8000), 16000, "and again");
  // Doubling has to stop somewhere, or a car left in accessory position would end up
  // checking once an hour and take that long to notice the engine had started.
  eq((int)pickBackoff(16000), (int)PICK_MAX_MS, "capping at the maximum");
  eq((int)pickBackoff(PICK_MAX_MS), (int)PICK_MAX_MS, "and staying there");
  ok(PICK_MIN_MS < 5000, "the first retry is quick enough to feel immediate");
}

// ------------------------------------------------------------------ sampler

static void test_sample_order_favours_live_values() {
  printf("SAMPLE_ORDER: b1 gets the most turns\n");
  int count[4] = {0, 0, 0, 0};
  for (size_t i = 0; i < sizeof(SAMPLE_ORDER) / sizeof(SAMPLE_ORDER[0]); i++)
    count[SAMPLE_ORDER[i]]++;
  // b1 is rpm, speed, MAP, throttle, load, coolant - everything with a sparkline.
  // On BLE each batch is a full round trip, so giving all three equal billing held
  // the values that actually move to a third of the achievable rate.
  ok(count[0] > count[1] && count[0] > count[2], "b1 is polled more often than b2/b3");
  // b4 is pedal, commanded throttle and torque - driver input and the engine's
  // answer to it. A pedal position sampled every few seconds says nothing, so it
  // rides at b1's cadence rather than with the temperatures.
  eq(count[3], count[0], "b4 keeps pace with b1");
  ok(count[1] > 0 && count[2] > 0, "the slower batches are still polled");
}

static void test_stale_window_tracks_the_cycle() {
  printf("sampleStaleMs: derived from how often a batch comes round\n");
  // b2 and b3 are polled once every four batches, so the window has to outlast a
  // full pass or they expire before their next turn. A fixed 3 s only survives if a
  // batch completes in under 750 ms - true on CAN, not on BLE, where it blanked
  // twelve of the twenty rows on every cycle.
  ok(sampleStaleMs(3200) > 3200, "a 3.2 s BLE cycle gets a window longer than the cycle");
  ok(sampleStaleMs(3200) >= 3 * 3200, "with room for a couple of missed turns");
  eq((int)sampleStaleMs(200), 3000, "a fast CAN cycle still drops dead data promptly");
  eq((int)sampleStaleMs(0), 3000, "and an unmeasured cycle falls back to the floor");
  ok(sampleStaleMs(60000) <= 20000, "a stall cannot leave minutes-old numbers on screen");
}

static void test_sample_merge_combines_batches() {
  printf("sampleMerge: a published sample carries every fresh batch\n");
  uint8_t bufs[4][40] = {};
  uint8_t lens[4] = {0, 0, 0, 0};
  uint32_t stamps[4] = {0, 0, 0, 0};

  // b1 answered: 41 0C 0AF0 0D 00
  const uint8_t r1[] = {0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00};
  memcpy(bufs[0], r1, sizeof(r1)); lens[0] = sizeof(r1); stamps[0] = 1000;
  // b2 answered on an earlier turn: 41 5C 96 (oil 110 C)
  const uint8_t r2[] = {0x41, 0x5C, 0x96};
  memcpy(bufs[1], r2, sizeof(r2)); lens[1] = sizeof(r2); stamps[1] = 900;

  Live L;
  ok(sampleMerge(L, bufs, lens, stamps, 1000, 3000), "reports data");
  eq((int)L.rpm, 700, "the batch polled this turn is present");
  eq((int)L.oil, 110, "and so is one carried forward from cache");
  ok(isnan(L.lambda), "a batch never received stays absent");
}

static void test_sample_merge_drops_stale() {
  printf("sampleMerge: a batch that stopped answering is dropped\n");
  uint8_t bufs[4][40] = {};
  uint8_t lens[4] = {0, 0, 0, 0};
  uint32_t stamps[4] = {0, 0, 0, 0};

  const uint8_t r1[] = {0x41, 0x0C, 0x0A, 0xF0};
  memcpy(bufs[0], r1, sizeof(r1)); lens[0] = sizeof(r1); stamps[0] = 10000;
  const uint8_t r2[] = {0x41, 0x5C, 0x96};
  memcpy(bufs[1], r2, sizeof(r2)); lens[1] = sizeof(r2); stamps[1] = 1000;   // long ago

  Live L;
  // Carrying a batch forward is what makes publishing after every turn possible, so
  // the staleness bound is what stops it becoming "show an old number as current".
  ok(sampleMerge(L, bufs, lens, stamps, 10000, 3000), "still reports the fresh batch");
  eq((int)L.rpm, 700, "the fresh batch is published");
  ok(isnan(L.oil), "the stale one is dropped rather than shown as current");
}

static void test_sample_merge_nothing_fresh() {
  printf("sampleMerge: everything stale\n");
  uint8_t bufs[4][40] = {};
  uint8_t lens[4] = {0, 0, 0, 0};
  uint32_t stamps[4] = {0, 0, 0, 0};
  const uint8_t r1[] = {0x41, 0x0C, 0x0A, 0xF0};
  memcpy(bufs[0], r1, sizeof(r1)); lens[0] = sizeof(r1); stamps[0] = 1000;

  Live L;
  ok(!sampleMerge(L, bufs, lens, stamps, 99000, 3000), "reports no data at all");
  ok(isnan(L.rpm), "and publishes nothing");
}

static void test_pollbatch_keeps_bytes() {
  printf("pollBatch: hands back the bytes it accepted\n");
  resetBus();
  Live L;
  uint8_t keep[40], keepLen = 0;
  queueGoodBatch();
  ok(pollBatch(L, B1, 6, keep, &keepLen), "returns true");
  ok(keepLen > 0, "and reports a length");
  // The sampler caches these and re-walks them on later turns, so they have to be
  // the verified reply rather than whatever was left in the scratch buffer.
  Live again;
  eq(mode01Walk(keep, keepLen, B1, 6, &again), 6, "the kept bytes re-walk cleanly");
  eq((int)again.rpm, 700, "and decode to the same values");
}

// ------------------------------------------------------------------ UI bundle
//
// A frontend built with an ordinary toolchain and uploaded to the board's
// filesystem, served from /w. Two of these paths take a name straight off the
// wire - the request URI and the multipart upload filename - so the checking is
// the interesting part, along with the rules that decide what may be cached
// forever and what must never be answered with an HTML document.

static void test_ui_path_accepts_bundle_assets() {
  printf("ui paths: what a build emits is servable\n");
  ok(uiPathOk("/index.html"), "the entry point");
  ok(uiPathOk("/app-a1b2c3d4.js"), "a content-hashed script");
  ok(uiPathOk("/style-9f8e.css"), "a content-hashed stylesheet");
  ok(uiPathOk("/assets/logo.svg"), "something in a subdirectory of the bundle");
  ok(uiPathOk("/app.js.gz"), "a compressed copy");
}

static void test_ui_path_rejects_everything_else() {
  printf("ui paths: a name off the wire is checked, not trusted\n");
  // Traversal is the one that matters: /w is a directory on a filesystem that also
  // holds trip logs, the sweep's hits and the NVS-backed config.
  ok(!uiPathOk("/../scanhits.csv"), "traversal out of the bundle directory");
  ok(!uiPathOk("/a/../../t0001.csv"), "traversal buried mid-path");
  ok(!uiPathOk("/..%2fx"), "an escaped traversal attempt");
  ok(!uiPathOk("index.html"), "a path that is not rooted");
  ok(!uiPathOk("//evil"), "a doubled separator");
  ok(!uiPathOk("/a b.js"), "a space");
  ok(!uiPathOk("/a?b.js"), "a query character");
  ok(!uiPathOk("/a\\b.js"), "a backslash");
  ok(!uiPathOk("/"), "the bare root");
  ok(!uiPathOk(""), "empty");
  ok(!uiPathOk(nullptr), "null");
  char longName[80];
  memset(longName, 'a', sizeof(longName));
  longName[0] = '/';
  longName[sizeof(longName) - 1] = 0;
  ok(!uiPathOk(longName), "a name too long for the buffers it is copied into");
}

static void test_ui_content_types() {
  printf("ui paths: content type follows the extension, not the compression\n");
  ok(strcmp(uiContentType("/index.html"), "text/html") == 0, "html");
  ok(strcmp(uiContentType("/app.js"), "text/javascript") == 0, "javascript");
  ok(strcmp(uiContentType("/s.css"), "text/css") == 0, "css");
  // The one worth pinning: a gzipped script is still a script. Reporting it as
  // application/gzip makes the browser download the file instead of running it.
  ok(strcmp(uiContentType("/app.js.gz"), "text/javascript") == 0,
     "a gzipped script is still a script");
  ok(strcmp(uiContentType("/index.html.gz"), "text/html") == 0,
     "and a gzipped page is still a page");
  ok(strcmp(uiContentType("/f.woff2"), "font/woff2") == 0, "a font");
  ok(strcmp(uiContentType("/unknown.bin"), "application/octet-stream") == 0,
     "and anything unrecognised is served as bytes");
}

static void test_ui_cache_policy() {
  printf("ui paths: only content-hashed assets may be cached forever\n");
  ok(uiImmutable("/app-a1b2c3.js"), "a hashed script is immutable");
  ok(uiImmutable("/style-9f8e.css.gz"), "so is a hashed, compressed stylesheet");
  // index.html names every other file, so caching it forever would mean a deployed
  // bundle could never be picked up - the board would serve the old one until the
  // browser's cache expired, which is to say never.
  ok(!uiImmutable("/index.html"), "the entry point is not");
  ok(!uiImmutable("/index.html.gz"), "nor its compressed copy");
}

static void test_ui_store_name() {
  printf("ui paths: an uploaded file is stored under a name the board chooses\n");
  char out[64];

  // The one that actually happened: a phone renamed the download, the bundle
  // installed fine, and the board reported "no frontend installed" over the top of
  // it because uiInstalled() looks for the entry point by name.
  ok(uiStoreName("index-1.11.1.html.gz", out, sizeof(out)) &&
     strcmp(out, "/index.html.gz") == 0, "a version suffix is normalised away");
  ok(uiStoreName("index.html.gz", out, sizeof(out)) &&
     strcmp(out, "/index.html.gz") == 0, "the expected name is unchanged");
  ok(uiStoreName("index.html", out, sizeof(out)) &&
     strcmp(out, "/index.html") == 0, "uncompressed too");

  // A duplicate download. This one could not even be stored before: uiPathOk
  // refuses spaces and brackets, so the upload failed outright.
  ok(uiStoreName("index (1).html.gz", out, sizeof(out)) &&
     strcmp(out, "/index.html.gz") == 0, "a duplicate-download name is survivable");
  ok(uiStoreName("Download/index.html.gz", out, sizeof(out)) &&
     strcmp(out, "/index.html.gz") == 0, "a directory the client sent is dropped");
  ok(uiStoreName("C:\\Users\\x\\index.html.gz", out, sizeof(out)) &&
     strcmp(out, "/index.html.gz") == 0, "including a Windows one");

  // Anything that is not the entry point keeps its own name, which is what a
  // multi-file bundle would need.
  ok(uiStoreName("app.js.gz", out, sizeof(out)) &&
     strcmp(out, "/app.js.gz") == 0, "a script keeps its name");
  ok(uiStoreName("app.css", out, sizeof(out)) &&
     strcmp(out, "/app.css") == 0, "so does a stylesheet");

  // Traversal cannot be expressed, rather than being detected and refused: the
  // directory is stripped first, so what is left is always a bare name inside the
  // bundle directory. "../../etc/passwd" becomes /passwd - junk in /w, not a file
  // anywhere else - and the budget cap deals with junk.
  ok(uiStoreName("../../etc/passwd", out, sizeof(out)) &&
     strcmp(out, "/passwd") == 0, "traversal collapses to a name inside the bundle");
  ok(uiStoreName("../../index.html", out, sizeof(out)) &&
     strcmp(out, "/index.html") == 0, "and cannot smuggle the entry point elsewhere");

  // ...but a leftover name still has to be servable at all.
  ok(!uiStoreName("app (1).js", out, sizeof(out)),
     "a non-HTML name that cannot be served is refused rather than mangled");
  ok(!uiStoreName("", out, sizeof(out)), "empty");
  ok(!uiStoreName(nullptr, out, sizeof(out)), "null");
  ok(!uiStoreName("index.html.gz", out, 4), "and a buffer too small is a refusal");
}

static void test_ui_budget() {
  printf("ui paths: the bundle's share of a shared filesystem\n");
  ok(strcmp(UI_DIR, "/w") == 0, "the bundle lives in its own directory");
  // The partition is shared with trip logs at roughly half a megabyte an hour, so
  // the cap is denominated in recording time: 300 KB is about 35 minutes of it.
  ok(UI_MAX_BYTES <= 512UL * 1024UL, "a bundle cannot take more than half a megabyte");
  ok(UI_MAX_BYTES >= 128UL * 1024UL, "but there is room for a real framework build");
  // The two subsystems have to agree, or log rotation would delete the frontend to
  // make room for another minute of logging.
  ok(!tripIsLogName("/w/index.html"), "and log rotation will never reclaim it");
  ok(!tripIsLogName("/w/app-a1b2.js.gz"), "nor any asset in it");
}

static void test_ui_api_paths_never_fall_through() {
  printf("ui paths: an API request is never answered with the app shell\n");
  // The single-page fallback returns index.html for unknown paths. If that applied
  // to API routes, a mistyped or removed endpoint would come back as an HTML
  // document with status 200 and be parsed as JSON - a failure that looks like
  // corrupt data rather than a missing endpoint.
  ok(uiIsApiPath("/data"), "the live sample");
  ok(uiIsApiPath("/history"), "the trend buffer");
  ok(uiIsApiPath("/trips/list"), "a nested endpoint");
  ok(uiIsApiPath("/scan/status"), "another");
  ok(uiIsApiPath("/watch/set"), "and another");
  ok(uiIsApiPath("/ui/manifest"), "including the bundle's own endpoints");
  ok(uiIsApiPath("/data?x=1"), "with a query string attached");
  ok(!uiIsApiPath("/"), "the root is not an API path");
  ok(!uiIsApiPath("/index.html"), "nor an asset");
  ok(!uiIsApiPath("/monitors"), "nor a client-side route that shares a prefix idea");
  // Prefix matching must not be sloppy: /database is not /data.
  ok(!uiIsApiPath("/database"), "and a longer name that merely starts the same is not");
  ok(!uiIsApiPath("/scanner"), "nor this one");
}

// ------------------------------------------------------------------ trip names
//
// The filesystem holds trip logs, the DID sweep's hits, and soon a served UI
// bundle. Everything that walked the root used to accept any name containing
// ".csv", and rotation deletes the lexicographically smallest match when space runs
// short - so "/scanhits.csv", which sorts before "/t0001.csv", was first in line.
// A long drive would delete hours of sweep results, and its resume position, to
// make room for another minute of logging. The trips page listed it as a trip and
// would download or delete it on request, too.

static void test_trip_name_accepts_real_logs() {
  printf("trip names: what tripPath() writes is a trip log\n");
  ok(tripIsLogName("/t0001.csv"), "the first trip");
  ok(tripIsLogName("/t0000.csv"), "sequence zero");
  ok(tripIsLogName("/t9999.csv"), "four digits");
  ok(tripIsLogName("/t123456.csv"), "and a sequence that has outgrown the padding");
  ok(tripIsLogNameLoose("t0007.csv"), "a name arriving without its leading slash");
  ok(tripIsLogNameLoose("/t0007.csv"), "or with one");
}

static void test_trip_name_protects_everything_else() {
  printf("trip names: nothing else on the filesystem is a trip log\n");
  // The one that mattered: it sorts first, so it was deleted first.
  ok(!tripIsLogName("/scanhits.csv"), "the sweep's hits are not a trip");
  ok(!tripIsLogNameLoose("scanhits.csv"), "nor without the slash");
  ok(strcmp("/scanhits.csv", "/t0001.csv") < 0,
     "and it really does sort ahead of the trips, which is why this mattered");

  // A UI bundle will live here too.
  ok(!tripIsLogName("/w/index.html"), "a served asset is not a trip");
  ok(!tripIsLogName("/w/app.js.gz"), "nor a compressed one");

  ok(!tripIsLogName("/t.csv"), "no sequence number at all");
  ok(!tripIsLogName("/t001.csv"), "too few digits to sort chronologically");
  ok(!tripIsLogName("/trip0001.csv"), "a near miss on the prefix");
  ok(!tripIsLogName("/t0001.txt"), "right name, wrong extension");
  ok(!tripIsLogName("/t0001.csv.bak"), "and nothing may follow the extension");
  ok(!tripIsLogName("t0001.csv"), "the strict form requires the leading slash");
  ok(!tripIsLogName("/sub/t0001.csv"), "only the root, never a subdirectory");
  ok(!tripIsLogName(""), "empty");
  ok(!tripIsLogName(nullptr), "null");
}

// ------------------------------------------------------------------ trip totals
//
// Fuel economy has to be integrated - there is no PID for it. The failure modes are
// all quiet ones: a gap counted as if it were driven, distance accumulated while
// the fuel rate was missing, a stale reading integrated twice. Each of those moves
// the average in the flattering direction, which is exactly the direction a mileage
// figure must not drift on its own.

static void tripReset() {
  g_tripKm = 0.0f;
  g_tripL = 0.0f;
  tripIntAt = 0;
}

static void test_trip_integrates_distance_and_fuel() {
  printf("trip: integrates speed and fuel rate over time\n");
  tripReset();
  tripIntegrate(60.0f, 6.0f, 1000);              // first call only starts the clock
  eq((int)(g_tripKm * 1000), 0, "the first sample has no interval behind it");

  // 60 km/h for one second is 1/60 km; 6 L/h for one second is 1/600 L.
  tripIntegrate(60.0f, 6.0f, 2000);
  ok(fabsf(g_tripKm - 60.0f / 3600.0f) < 1e-5f, "one second at 60 km/h is 16.7 m");
  ok(fabsf(g_tripL - 6.0f / 3600.0f) < 1e-6f, "and burns 1.67 ml at 6 L/h");

  for (uint32_t t = 3000; t <= 3600000; t += 1000) tripIntegrate(60.0f, 6.0f, t);
  ok(fabsf(g_tripKm - 60.0f) < 0.05f, "an hour at 60 km/h is 60 km");
  ok(fabsf(g_tripL - 6.0f) < 0.01f, "and 6 litres at 6 L/h");
  ok(fabsf(g_tripKm / g_tripL - 10.0f) < 0.01f, "which is 10 km/L");
}

static void test_trip_skips_intervals_it_knows_nothing_about() {
  printf("trip: a gap is not driving\n");
  tripReset();
  tripIntegrate(60.0f, 6.0f, 1000);
  tripIntegrate(60.0f, 6.0f, 2000);
  float km = g_tripKm, l = g_tripL;

  // A BLE dropout, a scan taking the bus, a wake from sleep. The car may have been
  // stationary or at 100 km/h; integrating the last known speed across it invents
  // a distance nobody measured.
  tripIntegrate(60.0f, 6.0f, 2000 + TRIP_INT_MAX_MS + 1);
  ok(g_tripKm == km && g_tripL == l, "a gap longer than the cap is not integrated");

  // ...but the clock still moves, so the next interval is measured from the gap's
  // end rather than accumulating the whole outage on the following sample.
  tripIntegrate(60.0f, 6.0f, 2000 + TRIP_INT_MAX_MS + 1001);
  ok(fabsf(g_tripKm - (km + 60.0f / 3600.0f)) < 1e-5f,
     "and the interval after it is one second, not the whole outage");
}

static void test_trip_needs_both_inputs() {
  printf("trip: both inputs or neither\n");
  tripReset();
  tripIntegrate(60.0f, 6.0f, 1000);
  tripIntegrate(60.0f, 6.0f, 2000);
  float km = g_tripKm, l = g_tripL;

  // Fuel rate is in the b2 batch and refreshes half as often as speed, so it goes
  // absent regularly. Counting the distance anyway would divide real kilometres by
  // an understated litre count and report a mileage better than the car achieved.
  tripIntegrate(60.0f, NAN, 3000);
  ok(g_tripKm == km, "distance is not counted while the fuel rate is missing");
  ok(g_tripL == l, "and neither is fuel");

  tripIntegrate(NAN, 6.0f, 4000);
  ok(g_tripKm == km && g_tripL == l, "nor the other way round");

  // A misframed reply that decoded to something impossible.
  tripIntegrate(-5.0f, 6.0f, 5000);
  ok(g_tripKm == km && g_tripL == l, "a negative decode is refused rather than subtracted");

  tripIntegrate(60.0f, 6.0f, 6000);
  ok(g_tripKm > km, "and it resumes once both are back");
}

static void test_trip_totals_only_grow() {
  printf("trip: totals are monotonic\n");
  tripReset();
  float lastKm = 0, lastL = 0;
  bool monotonic = true;
  for (uint32_t t = 1000; t <= 60000; t += 1000) {
    // A drive with stops, missing samples and idling.
    float sp = (t / 1000) % 7 == 0 ? 0.0f : 45.0f;
    float fr = (t / 1000) % 5 == 0 ? NAN : 4.2f;
    tripIntegrate(sp, fr, t);
    if (g_tripKm < lastKm || g_tripL < lastL) monotonic = false;
    lastKm = g_tripKm;
    lastL = g_tripL;
  }
  ok(monotonic, "neither total ever goes backwards across a minute of mixed driving");
  ok(lastKm > 0 && lastL > 0, "and both accumulate");
  ok(lastKm / lastL > 0 && lastKm / lastL < 100, "and gives a plausible km/L");
  // Idling burns fuel while covering no ground, which is the whole reason a trip
  // average is worth having and the instantaneous figure is not.
  tripReset();
  for (uint32_t t = 1000; t <= 60000; t += 1000) tripIntegrate(0.0f, 0.8f, t);
  eq((int)(g_tripKm * 1000), 0, "idling covers no distance");
  ok(g_tripL > 0, "but does burn fuel");
}

// ------------------------------------------------------------------ DID watch
//
// The scanner finds identifiers; the watch reads a chosen few of them repeatedly
// and files the readings alongside the live PIDs. Everything here is a way that can
// go wrong silently: a column appearing in the CSV header with no cell under it, a
// value reading as zero when it never actually arrived, or a typo parsing as a
// perfectly valid identifier 0000 and being watched forever.

static WatchDid mk(uint16_t did, uint8_t ecu, std::vector<uint8_t> bytes, uint32_t stamp) {
  WatchDid w;
  w.did = did;
  w.ecu = ecu;
  w.len = (uint8_t)bytes.size();
  for (size_t i = 0; i < bytes.size() && i < sizeof(w.data); i++) w.data[i] = bytes[i];
  w.stamp = stamp;
  return w;
}

static void test_watch_value_is_big_endian() {
  printf("watch: decodes big-endian unsigned\n");
  eq((int)watchValue(mk(0x1000, 0, {0x91}, 1)), 0x91, "one byte");
  eq((int)watchValue(mk(0x1002, 0, {0x15, 0x4F}, 1)), 0x154F, "two bytes, high byte first");
  eq((int)watchValue(mk(0x1002, 0, {0x00, 0x00, 0x01, 0x00}, 1)), 256, "four bytes");
  // Longer than four bytes is a string or a structure, not a number - the raw column
  // is the honest representation of those and the decode simply stops.
  eq((int)watchValue(mk(0xF18A, 0, {0x42, 0x4F, 0x53, 0x43, 0x48}, 1)), 0x424F5343,
     "stops at four bytes rather than overflowing");
  WatchDid never;
  eq((int)watchValue(never), 0, "an identifier that never answered decodes to nothing");
}

static void test_watch_freshness() {
  printf("watch: a reading that missed its turn is not current\n");
  watchN = 4;
  watchPeriodMs = 1000;
  uint32_t cycle = watchCycleMs();
  eq((int)cycle, 4000, "a cycle is one read of each");

  WatchDid never;
  ok(!watchFresh(never, 10000), "never answered is never fresh");
  ok(watchFresh(mk(0x1000, 0, {0x10}, 9500), 10000), "just read is fresh");
  // One cycle plus a period of slack: this adapter drops replies (FINDINGS), and a
  // single lost one must not flap the column between present and absent.
  ok(watchFresh(mk(0x1000, 0, {0x10}, 10000 - (cycle + 900)), 10000),
     "one dropped reply is tolerated");
  ok(!watchFresh(mk(0x1000, 0, {0x10}, 10000 - (cycle + 1500)), 10000),
     "but a reading that missed a whole extra cycle is stale");
}

static void test_watch_header_and_row_agree() {
  printf("watch: every header column has a cell under it\n");
  watchN = 2;
  watchPeriodMs = 1000;
  const uint32_t now = 100000;
  // Every state a watched identifier can be in, including the ones that produce
  // empty cells - an empty cell is still a cell, or the row shifts left and every
  // column after it is read as the wrong thing.
  WatchDid cases[] = {
    WatchDid(),                                             // never answered
    mk(0x1002, 0, {0x15, 0x4F}, now - 100),                 // fresh
    mk(0x1002, 1, {0x15, 0x4F}, now - 60000),               // long stale
    mk(0x1000, 0, {0x91}, now - 100),                       // single byte
    mk(0xF190, 0, {1, 2, 3, 4, 5, 6, 7, 8}, now - 100),     // full width
  };
  for (const WatchDid &w : cases) {
    char names[WATCH_COLS_PER_DID][12];
    char cells[WATCH_COLS_PER_DID][20];
    uint8_t nh = watchColNames(w, names, WATCH_COLS_PER_DID);
    uint8_t nr = watchColCells(w, now, cells, WATCH_COLS_PER_DID);
    eq(nr, nh, "header columns and row cells match");
  }
}

static void test_watch_cells() {
  printf("watch: cell contents\n");
  watchN = 1;
  watchPeriodMs = 1000;
  const uint32_t now = 100000;
  char cells[WATCH_COLS_PER_DID][20];

  watchColCells(mk(0x1002, 0, {0x15, 0x4F}, now - 100), now, cells, WATCH_COLS_PER_DID);
  ok(strcmp(cells[0], "5455") == 0, "decoded column carries the big-endian value");
  ok(strcmp(cells[1], "154F") == 0, "raw column carries the bytes as sent");

  // The whole reason an absent PID is written empty rather than zero: a watched
  // identifier that stopped answering must not correlate as a value of nought.
  watchColCells(mk(0x1002, 0, {0x15, 0x4F}, now - 90000), now, cells, WATCH_COLS_PER_DID);
  ok(cells[0][0] == 0, "a stale reading leaves the value empty, not zero");
  ok(cells[1][0] == 0, "and leaves the raw column empty too");

  WatchDid never;
  watchColCells(never, now, cells, WATCH_COLS_PER_DID);
  ok(cells[0][0] == 0 && cells[1][0] == 0, "never answered writes two empty cells");
}

static void test_watch_column_names() {
  printf("watch: column names distinguish the responder\n");
  char names[WATCH_COLS_PER_DID][12];
  watchColNames(mk(0x1002, 0, {}, 0), names, WATCH_COLS_PER_DID);
  ok(strcmp(names[0], "E1002") == 0, "an ECM identifier names its column E....");
  ok(strcmp(names[1], "E1002x") == 0, "and the raw column takes an x");
  watchColNames(mk(0x0140, 1, {}, 0), names, WATCH_COLS_PER_DID);
  ok(strcmp(names[0], "T0140") == 0, "the same DID on the TCM is a different column");
}

static void test_watch_nvs_round_trip() {
  printf("watch: the set survives a restart\n");
  WatchDid in[3] = { mk(0x1002, 0, {0x15, 0x4F}, 12345),
                     mk(0x0140, 1, {0x01}, 12345),
                     mk(0xF190, 0, {}, 0) };
  uint8_t blob[WATCH_MAX * 3];
  size_t n = watchEncode(in, 3, blob, sizeof(blob));
  eq((int)n, 9, "three identifiers encode to nine bytes");

  WatchDid out[WATCH_MAX];
  uint8_t got = watchDecode(blob, n, out, WATCH_MAX);
  eq(got, 3, "and decode back to three");
  ok(out[0].did == 0x1002 && out[0].ecu == 0, "the first survives");
  ok(out[1].did == 0x0140 && out[1].ecu == 1, "the responder survives too");
  // Readings are deliberately not persisted: a value from before the ignition went
  // off is not a reading, and restoring one would put a stale number into the first
  // rows of the next drive's CSV.
  eq(out[0].len, 0, "readings are not restored, only the choice of identifier");
  eq((int)out[0].stamp, 0, "so nothing looks fresh on the first row after a restart");

  WatchDid two[2];
  eq(watchDecode(blob, n, two, 2), 2, "decode honours the caller's capacity");
  eq((int)watchEncode(in, 3, blob, 4), 3, "encode honours the buffer it was given");
}

static void test_watch_parse() {
  printf("watch: parsing identifiers\n");
  WatchDid w;
  ok(watchParseOne("E1002", w) && w.did == 0x1002 && w.ecu == 0, "E prefix is the ECM");
  ok(watchParseOne("T0140", w) && w.did == 0x0140 && w.ecu == 1, "T prefix is the TCM");
  ok(watchParseOne("1002", w) && w.did == 0x1002 && w.ecu == 0, "bare hex assumes the ECM");
  ok(watchParseOne("f18a", w) && w.did == 0xF18A, "lower case is accepted");
  // A typo has to drop the entry rather than fall through to identifier 0000, which
  // is a real address and would then be watched silently forever.
  ok(!watchParseOne("10G2", w), "a non-hex digit is rejected");
  ok(!watchParseOne("102", w), "three digits is rejected");
  ok(!watchParseOne("10022", w), "five digits is rejected");
  ok(!watchParseOne("", w), "empty is rejected");
  ok(!watchParseOne("E", w), "a bare prefix is rejected");
}

static void test_watch_parse_list() {
  printf("watch: parsing a list\n");
  WatchDid out[WATCH_MAX];
  eq(watchParseList("1002,1003,T0140", out, WATCH_MAX), 3, "comma separated");
  ok(out[2].ecu == 1 && out[2].did == 0x0140, "the responder carries through the list");
  eq(watchParseList("1002, 1003 ,1002", out, WATCH_MAX), 2,
     "a duplicate does not get a second turn of the round robin");
  eq(watchParseList("E1002,T1002", out, WATCH_MAX), 2,
     "the same DID on two ECUs is not a duplicate");
  eq(watchParseList("1002,zzz,1003", out, WATCH_MAX), 2, "junk is dropped, the rest kept");
  eq(watchParseList("", out, WATCH_MAX), 0, "an empty list watches nothing");
  eq(watchParseList("1000,1001,1002,1003,1004,1005,1006,1007,1008,1009", out, WATCH_MAX),
     WATCH_MAX, "and the set cannot exceed the cap");
}

static void test_watch_apply_detects_a_real_change() {
  printf("watch: only a real change rotates the CSV\n");
  WatchDid empty[1];
  watchApply(empty, 0, 1000);                     // known starting point
  eq((int)watchN, 0, "starts watching nothing");

  WatchDid a[2] = { mk(0x1002, 0, {}, 0), mk(0x1003, 0, {}, 0) };
  uint32_t gen0 = watchGen;
  ok(watchApply(a, 2, 1000), "a new set is a change");
  eq((int)(watchGen - gen0), 1, "and bumps the generation, so the trip file rotates");
  eq((int)watchN, 2, "both are watched");
  eq((int)watchTurn, 0, "the round robin restarts");

  // The page re-sends its selection on every Apply. If an identical list counted as
  // a change, a drive would become a pile of one-row CSVs.
  uint32_t gen1 = watchGen;
  ok(!watchApply(a, 2, 1000), "re-applying the same set is not a change");
  eq((int)(watchGen - gen1), 0, "so the file it is writing stays open");

  ok(watchApply(a, 2, 2000), "changing only the period is still a change");
  WatchDid reordered[2] = { mk(0x1003, 0, {}, 0), mk(0x1002, 0, {}, 0) };
  ok(watchApply(reordered, 2, 2000), "reordering changes the column order, so it counts");

  // A reading taken under the old set does not belong under the new header.
  watch[0].len = 2; watch[0].data[0] = 0x15; watch[0].stamp = 4242;
  watchApply(a, 2, 2000);
  eq((int)watch[0].len, 0, "applying a set clears readings taken under the last one");

  watchApply(a, 2, 1);
  eq((int)watchPeriodMs, (int)WATCH_PERIOD_MIN, "an absurd period is clamped up");
  watchApply(a, 2, 99999);
  eq((int)watchPeriodMs, (int)WATCH_PERIOD_MAX, "and a lazy one is clamped down");

  WatchDid many[WATCH_MAX + 2];
  for (uint8_t i = 0; i < WATCH_MAX + 2; i++) many[i] = mk((uint16_t)(0x2000 + i), 0, {}, 0);
  watchApply(many, WATCH_MAX + 2, 1000);
  eq((int)watchN, (int)WATCH_MAX, "more than the cap is truncated, not overflowed");
}

// ------------------------------------------------------------------

int main() {
  test_can_single_frame();
  test_can_ignores_other_ecu();
  test_can_negative_response();
  test_can_response_pending();
  test_can_multiframe_complete();
  test_can_multiframe_truncated();
  test_can_dropped_consecutive_frame();
  test_can_oversize_reply();
  test_can_silent();
  test_can_rejects_an_overlong_request();
  test_can_still_sends_a_full_single_frame();

  test_yield_only_while_idle();
  test_yield_extends_the_deadline();
  test_yield_extension_is_bounded();
  test_yield_costing_nothing_changes_nothing();
  test_bus_guard_is_visible_from_a_yield();

  test_ble_single_frame();
  test_ble_ignores_other_ecu();
  test_ble_multiframe_complete();
  test_ble_dropped_frame();
  test_ble_incomplete_multiframe();
  test_ble_no_data();
  test_ble_negative();

  test_new_pid_lengths();
  test_mode01_walk();
  test_batch_complete();
  test_batch_retries_for_a_complete_reply();
  test_batch_salvages_verified_partial();
  test_batch_rejects_misframed();
  test_batch_silent_does_not_retry();

  test_mon_mask();
  test_mon_parse();
  test_pick_backoff();
  test_sample_order_favours_live_values();
  test_stale_window_tracks_the_cycle();
  test_sample_merge_combines_batches();
  test_sample_merge_drops_stale();
  test_sample_merge_nothing_fresh();
  test_pollbatch_keeps_bytes();

  test_ui_path_accepts_bundle_assets();
  test_ui_path_rejects_everything_else();
  test_ui_content_types();
  test_ui_cache_policy();
  test_ui_store_name();
  test_ui_budget();
  test_ui_api_paths_never_fall_through();

  test_trip_name_accepts_real_logs();
  test_trip_name_protects_everything_else();

  test_trip_integrates_distance_and_fuel();
  test_trip_skips_intervals_it_knows_nothing_about();
  test_trip_needs_both_inputs();
  test_trip_totals_only_grow();

  test_did_unknown_until_enough_reads();
  test_did_one_change_is_proof();
  test_did_sweep_value_is_a_baseline_not_a_read();
  test_did_length_change_is_a_change();
  test_did_identification_outranks_the_machine();
  test_did_verdict_is_pure();
  test_did_hex_round_trip();
  test_did_state_names_round_trip();

  test_batt_ignores_absent_readings();
  test_batt_never_while_the_engine_runs();
  test_batt_survives_cranking();
  test_batt_fires_on_a_sustained_low();
  test_batt_boundary_is_not_low();
  test_batt_run_can_start_at_time_zero();

  test_watch_value_is_big_endian();
  test_watch_freshness();
  test_watch_header_and_row_agree();
  test_watch_cells();
  test_watch_column_names();
  test_watch_nvs_round_trip();
  test_watch_parse();
  test_watch_parse_list();
  test_watch_apply_detects_a_real_change();

  printf("\n%d checks, %d failed\n", g_ran, g_fail);
  return g_fail ? 1 : 0;
}

// Tests for the ISO-TP reassembly contract and the mode-01 batch poller.
//
// The bug these were written for: a truncated multi-frame reply used to come back
// as a short-but-positive length, indistinguishable from a complete one. pollBatch
// parsed it, applied whichever PIDs had arrived, and left the rest of Live at NAN
// - which /data serialises as null and the dashboard renders as blanks over the
// top of readings that were fine a moment earlier.

#include "shims.h"
#include "isotp_extract.h"

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

// ------------------------------------------------------------------ sampler

static void test_sampler_rotates() {
  printf("sampleAdvance: one batch per call\n");
  resetBus();
  Live acc; bool any = false; uint8_t batch = 0;

  queueGoodBatch();                                   // only b1 will answer
  ok(!sampleAdvance(acc, any, batch), "first call does not complete a sample");
  eq((int)batch, 1, "and advances to the next batch");
  ok(any, "b1 answered");
  ok(!isnan(acc.rpm), "b1 fields are in the accumulator");

  ok(!sampleAdvance(acc, any, batch), "second call still incomplete");
  ok(sampleAdvance(acc, any, batch), "third call completes the rotation");
  eq((int)batch, 0, "and wraps back to the start");

  // The point of splitting the sample across loop turns: the web server gets a turn
  // between batches, so a page request never waits on a whole three-batch poll.
  ok(!isnan(acc.rpm), "the completed sample keeps what b1 provided");
  ok(isnan(acc.oil), "and leaves absent fields alone");
}

static void test_sampler_partial_still_publishes() {
  printf("sampleAdvance: only one batch of three answers\n");
  resetBus();
  Live acc; bool any = false; uint8_t batch = 0;
  queueGoodBatch();
  for (int i = 0; i < 3; i++) sampleAdvance(acc, any, batch);
  ok(any, "the sample is still flagged usable");
  ok(!isnan(acc.speed), "the batch that answered is present");
  // This is what reaches the browser as null, and why the client holds the previous
  // value rather than painting an em-dash over a good reading.
  ok(isnan(acc.lambda), "the batches that did not are absent, not invented");
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

  test_ble_single_frame();
  test_ble_ignores_other_ecu();
  test_ble_multiframe_complete();
  test_ble_dropped_frame();
  test_ble_incomplete_multiframe();
  test_ble_no_data();
  test_ble_negative();

  test_mode01_walk();
  test_batch_complete();
  test_batch_retries_for_a_complete_reply();
  test_batch_salvages_verified_partial();
  test_batch_rejects_misframed();
  test_batch_silent_does_not_retry();

  test_sampler_rotates();
  test_sampler_partial_still_publishes();

  printf("\n%d checks, %d failed\n", g_ran, g_fail);
  return g_fail ? 1 : 0;
}

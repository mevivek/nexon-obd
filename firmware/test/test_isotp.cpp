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

// b1 from pollAll(): rpm, speed, map, throttle, load, coolant.
static const uint8_t B1[6] = {0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05};

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

static void test_batch_retries_truncated() {
  printf("pollBatch: first attempt truncated, retry succeeds\n");
  resetBus();
  Live L;
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});   // truncated attempt
  queueGoodBatch();                                              // retry answers fully
  ok(pollBatch(L, B1, 6), "returns true after the retry");
  eq((int)L.rpm, 700, "rpm decoded from the retry");
  eq((int)L.coolant, 50, "coolant decoded from the retry");
}

static void test_batch_discards_partial() {
  printf("pollBatch: truncated twice\n");
  resetBus();
  Live L;
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});
  rx(0x7E8, {0x10, 0x0E, 0x41, 0x0C, 0x0A, 0xF0, 0x0D, 0x00});
  ok(!pollBatch(L, B1, 6), "returns false");
  // The point of the fix: half a batch is not applied. Previously rpm would have
  // been set from the first frame while coolant stayed NAN, so the dashboard drew
  // a live rpm next to five freshly blanked gauges.
  ok(isnan(L.rpm), "rpm left untouched");
  ok(isnan(L.coolant), "coolant left untouched");
}

static void test_batch_silent_does_not_retry() {
  printf("pollBatch: silent ECU\n");
  resetBus();
  Live L;
  uint32_t t0 = g_millis;
  ok(!pollBatch(L, B1, 6), "returns false");
  // One 400 ms window, not two: retrying a silent bus would triple the latency of
  // /data with the ignition off, since pollAll() runs three of these.
  ok(g_millis - t0 < 800, "did not burn a second timeout");
}

// ------------------------------------------------------------------ pollAll

static void test_pollall_partial_marks_ok() {
  printf("pollAll: one batch answers, two do not\n");
  resetBus();
  queueGoodBatch();            // b1 answers; b2 and b3 time out
  Live L = pollAll();
  ok(L.ok, "sample is still flagged ok");
  ok(!isnan(L.rpm), "b1 fields are populated");
  // This is what reaches the browser as null, and why the client holds the
  // previous value rather than rendering an em-dash over a good reading.
  ok(isnan(L.oil), "b2 fields are absent");
  ok(isnan(L.lambda), "b3 fields are absent");
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

  test_batch_complete();
  test_batch_retries_truncated();
  test_batch_discards_partial();
  test_batch_silent_does_not_retry();

  test_pollall_partial_marks_ok();

  printf("\n%d checks, %d failed\n", g_ran, g_fail);
  return g_fail ? 1 : 0;
}

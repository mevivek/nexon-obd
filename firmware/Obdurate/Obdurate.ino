// Obdurate - XIAO ESP32S3 + SN65HVD230 CAN transceiver, plugged into the OBD-II port.
//
// Two modes, one binary:
//   1. Live dashboard  - hosts a Wi-Fi AP and serves gauges at http://192.168.4.1/
//   2. UDS DID scanner - brute-forces service 0x22 across the identifier space
//
// Talks raw ISO 15765-4 (CAN 11-bit / 500 kbit) with a real ISO-TP layer, so it
// replaces the ELM327 rather than depending on it. Bluetooth is not used at all:
// the XIAO ESP32S3 is BLE-only and cannot speak the Classic SPP an ELM327 needs.
//
// SAFETY: this firmware only ever transmits diagnostic requests - mode 01 (live
// data), mode 03 (stored codes), mode 06 (on-board monitor results) and UDS service
// 0x22 (ReadDataByIdentifier), all of them reads - plus ISO-TP flow-control frames.
// It never sends arbitrary frames, never writes (0x2E), never runs routines (0x31),
// never resets an ECU (0x11), never changes diagnostic session (0x10) and never
// clears the car's own record (0x14).
//
// That is checked, not asserted: test_dashboard.mjs finds every request buffer from
// its call sites, reads its service byte out of this file, and fails the build on
// anything outside the list of reads. This comment claimed mode 09 for a long time
// while no 0x09 request existed anywhere in the sketch; writing the check is what
// found it.

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <vector>
#include "driver/twai.h"
#include "esp_system.h"
#include "obd_types.h"
#include "bus_yield.h"
#include "elm_ble.h"
#include "version.h"
#include "history.h"
#include "clock.h"
#include "didwatch.h"
#include "ui_paths.h"
#include "ui_fs.h"
#include "triplog.h"
#include <Update.h>
#include "boot_html.h"
#include "ui_html.h"
#include "ota_html.h"

// Two ways to reach the car, picked at runtime:
//   TR_CAN - SN65HVD230 transceiver on pins D1/D2, straight onto the bus. Fast.
//   TR_BLE - BLE GATT to the dual-mode ELM327 already plugged into the OBD port.
//            Slower, but needs no extra hardware at all.
enum Transport { TR_NONE, TR_CAN, TR_BLE };
static Transport activeTransport = TR_NONE;

// ---------------------------------------------------------------- config

static const gpio_num_t PIN_CAN_TX = GPIO_NUM_2;   // XIAO pad D1
static const gpio_num_t PIN_CAN_RX = GPIO_NUM_3;   // XIAO pad D2

static const char *AP_SSID = "Obdurate";
static const char *AP_PASS = "changeme1234";          // >= 8 chars, change if you like

// A note on the NVS namespaces, which are still "nexonscan", "nexonwatch",
// "nexontrip" and "nexonhist" after the rename and are staying that way.
//
// They are storage keys, not branding: nothing shows them to anyone. Renaming them
// orphans everything a board already has - and one of those is scanSaveState()'s
// position, which is the resume point of a sweep that takes over half an hour on
// CAN and the better part of a day over BLE. A board mid-sweep would come up
// believing it had never started. The trend history and the trip sequence go the
// same way, quietly, on the first boot after an update.
//
// A cosmetic rename that silently destroys days of scanning is a bad trade, and NVS
// namespaces are capped at 15 characters, so there is no room to be clever about
// migrating. They keep the old names.

static const uint32_t ID_ECM_REQ = 0x7E0;          // engine ECU request
static const uint32_t ID_ECM_RSP = 0x7E8;          // engine ECU response
static const uint32_t ID_TCM_REQ = 0x7E1;          // transmission
static const uint32_t ID_TCM_RSP = 0x7E9;

// Deep-sleep after this long with no ECU response, so the car battery survives
// the thing being left plugged in. OBD pin 16 is permanently live.
static const uint32_t IDLE_SLEEP_MS = 10UL * 60UL * 1000UL;
static const uint64_t SLEEP_WAKE_US = 30ULL * 1000000ULL;   // re-check every 30 s

// A second floor, under the idle timer rather than beside it.
//
// The idle timer answers "the car is off", which is the ordinary case. It does not
// answer "the battery is going flat", and those come apart precisely where it
// matters: an ECU that keeps answering with the engine not running - ignition on at
// the roadside, a long diagnostic session parked, a module that stays awake - resets
// lastEcuOkMs on every reply, so the ten-minute guard never arms and the board draws
// from a battery nothing is charging for as long as that lasts.
//
// A lead-acid battery at rest sits near 12.6 V. 11.8 V is roughly a quarter charged
// and about where a cold start stops being a certainty. Past that, nothing this board
// does is worth the car not starting.
static const float    BATT_SLEEP_V       = 11.8f;
// Cranking pulls the rail to nine volts and below for a second or so, which is the
// one moment the reading is low and sleeping would be exactly wrong. Thirty seconds
// continuously below the floor is well past any crank, and past the sag from an
// electric fan or a heated screen starting up.
static const uint32_t BATT_SLEEP_HOLD_MS = 30000;
// The engine turning is proof something is charging, whatever the rail reads.
static const float    BATT_ENGINE_RPM    = 300.0f;

// Boot forensics.
//
// A recorder that runs unattended has to be able to answer "what happened while I
// was not looking". From the page, a board that has quietly panicked and restarted
// forty times looks exactly like one that has been up all week - same version, same
// readings, a trip log full of short files nobody can explain. A brownout in
// particular is a car-electrical event worth seeing, and it is invisible today.
//
// The counter lives in RTC memory, which does not survive a power cut - and that is
// correct rather than a limitation, because it counts deep-sleep wakes and those
// are precisely the restarts RTC memory does survive. A cold boot resets it, which
// esp_reset_reason() can say for certain, so no magic word is needed here.
RTC_DATA_ATTR static uint32_t g_bootWakes;

static const char *resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "power";
    case ESP_RST_DEEPSLEEP: return "wake";
    case ESP_RST_SW:        return "software";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int-wdt";
    case ESP_RST_TASK_WDT:  return "task-wdt";
    case ESP_RST_WDT:       return "wdt";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_EXT:       return "external";
    default:                return "unknown";
  }
}

// The XIAO ESP32S3 has no power LED - the only visible indicator is the user LED
// on GPIO21, and it is active LOW. Without this the board looks dead even when
// it is working, which is no good when it is wedged under the dashboard.
#ifndef LED_BUILTIN
#define LED_BUILTIN 21
#endif
static const uint8_t LED_PIN = LED_BUILTIN;

// Heartbeat encodes state at a glance:
//   slow 1 Hz  - alive, Wi-Fi up, but no ECU response (ignition off / not wired)
//   fast 5 Hz  - talking to the ECU
//   double-blink - DID scan in progress
static void heartbeat(bool ecuOk, bool scanning) {
  static uint32_t last = 0;
  static uint8_t phase = 0;
  uint32_t period = scanning ? 120 : (ecuOk ? 100 : 500);
  if (millis() - last < period) return;
  last = millis();
  phase++;
  bool on;
  if (scanning) on = (phase % 6) < 2;            // blip-blip-pause
  else          on = (phase & 1);
  digitalWrite(LED_PIN, on ? LOW : HIGH);        // active LOW
}

WebServer server(80);

// ---------------------------------------------------------------- HTTP fairness

// Set while inside a request handler. WebServer keeps a single current client, so
// re-entering handleClient() from within a handler would corrupt it. handleDtc is
// the one handler that waits on the bus, and it therefore does not yield - which is
// why its timeouts are kept short.
static bool g_inHandler = false;

// Set for the duration of one ISO-TP exchange. A handler reached from webYield() is
// running underneath a half-finished reassembly, so it must not start a second
// exchange on top of it.
static bool g_busBusy = false;

static void serveHttp() {
  g_inHandler = true;
  server.handleClient();
  g_inHandler = false;
}

// Called from the transports' wait loops - see bus_yield.h for why the time is
// given back to the response deadline.
uint32_t webYield() {
  if (g_inHandler) return 0;
  uint32_t t0 = millis();
  serveHttp();
  return millis() - t0;
}

// ---------------------------------------------------------------- CAN / ISO-TP

static bool canUp = false;

static bool canBegin() {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(PIN_CAN_TX, PIN_CAN_RX, TWAI_MODE_NORMAL);
  g.rx_queue_len = 48;
  g.tx_queue_len = 16;
  twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) return false;
  return true;
}

// Drain until the bus has actually gone quiet, not just until the queue happens to
// be empty this instant.
//
// A request that timed out mid-reassembly leaves its consecutive frames still in
// flight. A single non-blocking drain returns before they land, so they arrive
// inside the *next* request's read loop, where a stale CF with the wrong sequence
// number kills a perfectly good exchange - one failed poll turning into a run of
// them, which is what made the status text flicker between live and "no response".
static void canFlush() {
  twai_message_t m;
  uint32_t quietSince = millis();
  while (millis() - quietSince < 4) {
    if (twai_receive(&m, pdMS_TO_TICKS(1)) == ESP_OK) quietSince = millis();
  }
}

static bool canSend(uint32_t id, const uint8_t *d, uint8_t len) {
  twai_message_t m = {};
  m.identifier = id;
  m.data_length_code = 8;
  for (int i = 0; i < 8; i++) m.data[i] = (i < len) ? d[i] : 0x55;   // 0x55 pad
  return twai_transmit(&m, pdMS_TO_TICKS(30)) == ESP_OK;
}

// One request, one reassembled response. Handles single frame, first frame +
// flow control + consecutive frames, and the 0x78 "responsePending" negative reply.
// Returns payload length, or -1 on timeout, -2 on a real negative response, or
// -3 when reassembly started but never completed.
//
// -3 has to be distinct from a short payload. Returning however many bytes did
// arrive makes a truncated reply indistinguishable from a complete one, so the
// caller parses half a batch and treats the PIDs that never arrived as absent -
// which is what blanks the dashboard mid-drive.
static int canIsoTp(uint32_t reqId, uint32_t rspId,
                    const uint8_t *payload, uint8_t plen,
                    uint8_t *out, size_t outCap, uint32_t timeoutMs,
                    int *partial = nullptr) {
  if (partial) *partial = 0;
  // A single frame is eight bytes: one of PCI and seven of payload. Nothing here
  // sends a multi-frame request, so anything longer is a caller error - and it used
  // to be a silent one, because the memcpy below is into a stack buffer with no
  // bound. Every current caller passes a constant, and the largest of them - the
  // mode 01 batch at PID_B*, six PIDs plus the mode byte - is exactly 7. That is at
  // the limit with nothing spare, which is precisely the shape of a bug that waits:
  // a seventh PID in a batch, or packing two DIDs into one 0x22 request, smashes the
  // frame on the stack and nothing says so.
  if (plen > 7) return -1;
  uint8_t frame[8] = {0};
  frame[0] = plen;                                  // single-frame PCI
  memcpy(&frame[1], payload, plen);
  canFlush();
  if (!canSend(reqId, frame, plen + 1)) return -1;

  size_t got = 0, total = 0;
  bool multi = false;
  uint8_t nextSeq = 1;
  uint32_t deadline = millis() + timeoutMs;
  uint32_t extended = 0;

  while ((int32_t)(deadline - millis()) > 0) {
    twai_message_t m;
    // Nothing on the bus this instant: serve any waiting HTTP request rather than
    // spinning, and give the deadline back the time that took.
    if (twai_receive(&m, pdMS_TO_TICKS(5)) != ESP_OK) { busWaitYield(deadline, extended); continue; }
    if (m.identifier != rspId) continue;

    uint8_t pci = m.data[0] >> 4;

    if (pci == 0x0) {                               // single frame
      uint8_t len = m.data[0] & 0x0F;
      if (len > 7) return -1;
      // negative response?
      if (len >= 3 && m.data[1] == 0x7F) {
        if (m.data[3] == 0x78) { deadline = millis() + timeoutMs + 200; continue; }  // pending
        return -2;
      }
      if (len > outCap) return -3;                  // will not fit - do not half-copy it
      memcpy(out, &m.data[1], len);
      return (int)len;
    }
    else if (pci == 0x1) {                          // first frame
      total = (((size_t)(m.data[0] & 0x0F)) << 8) | m.data[1];
      if (total > outCap) return -3;                // would truncate during reassembly
      multi = true;
      got = min((size_t)6, total);
      memcpy(out, &m.data[2], got);
      uint8_t fc[3] = {0x30, 0x00, 0x00};           // clear to send, no block, no delay
      canSend(reqId, fc, 3);
      nextSeq = 1;
      deadline = millis() + timeoutMs + 300;
    }
    else if (pci == 0x2 && multi) {                 // consecutive frame
      if ((m.data[0] & 0x0F) != nextSeq) return -3; // dropped or reordered frame
      nextSeq = (nextSeq + 1) & 0x0F;
      size_t n = min((size_t)7, total - got);
      memcpy(out + got, &m.data[1], n);
      got += n;
      if (got >= total) return (int)got;
    }
  }
  if (multi && partial) *partial = (int)got;        // salvageable if the caller can verify it
  return multi ? -3 : -1;                           // a partial reassembly is not a result
}

// ---------------------------------------------------------------- BLE transport

static uint32_t bleCurHeader = 0;

static int hexNib(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

// Same request/response contract as canIsoTp, but spoken as ELM327 text over BLE.
// Headers are left ON and the reply lines are demultiplexed by responder ID here,
// because this clone's ATCRA receive filter does not actually filter.
static int bleIsoTp(uint32_t reqId, uint32_t rspId,
                    const uint8_t *payload, uint8_t plen,
                    uint8_t *out, size_t outCap, uint32_t timeoutMs,
                    int *partial = nullptr) {
  if (partial) *partial = 0;
  if (!elmConnected) return -1;

  if (bleCurHeader != reqId) {
    char h[16];
    snprintf(h, sizeof(h), "ATSH %03X", (unsigned)reqId);
    elmCommand(h, 800);
    bleCurHeader = reqId;
  }

  char cmd[40];
  int n = 0;
  for (uint8_t i = 0; i < plen && n < (int)sizeof(cmd) - 3; i++)
    n += snprintf(cmd + n, sizeof(cmd) - n, "%02X", payload[i]);

  String resp = elmCommand(String(cmd), timeoutMs);
  if (resp.length() == 0) return -1;
  if (resp.indexOf("UNABLE") >= 0 || resp.indexOf("NO DATA") >= 0) return -1;

  char want[4];
  snprintf(want, sizeof(want), "%03X", (unsigned)rspId);

  size_t got = 0, total = 0;
  bool multi = false, negative = false, broken = false;
  uint8_t nextSeq = 1;

  int start = 0;
  while (start < (int)resp.length()) {
    int nl = resp.indexOf('\r', start);
    int nl2 = resp.indexOf('\n', start);
    if (nl < 0 || (nl2 >= 0 && nl2 < nl)) nl = nl2;
    String line = (nl < 0) ? resp.substring(start) : resp.substring(start, nl);
    start = (nl < 0) ? resp.length() : nl + 1;

    line.replace(" ", "");
    line.trim();
    if (line.length() < 5) continue;
    if (!line.startsWith(want)) continue;

    String body = line.substring(3);
    int hi = hexNib(body[0]), lo = hexNib(body[1]);
    if (hi < 0 || lo < 0) continue;
    uint8_t pci = (uint8_t)((hi << 4) | lo);

    // decode the remaining hex characters of this line into bytes
    uint8_t tmp[32];
    size_t tn = 0;
    for (size_t i = 2; i + 1 < body.length() && tn < sizeof(tmp); i += 2) {
      int a = hexNib(body[i]), b = hexNib(body[i + 1]);
      if (a < 0 || b < 0) break;
      tmp[tn++] = (uint8_t)((a << 4) | b);
    }

    if ((pci & 0xF0) == 0x00) {                 // single frame
      size_t len = pci & 0x0F;
      if (len >= 3 && tn >= 3 && tmp[0] == 0x7F) { negative = true; continue; }
      if (len > tn || len > outCap) { broken = true; continue; }   // line cut short
      memcpy(out, tmp, len);
      return (int)len;
    } else if ((pci & 0xF0) == 0x10) {          // first frame: 12-bit length
      if (tn < 1) continue;
      total = (((size_t)(pci & 0x0F)) << 8) | tmp[0];
      if (total > outCap) { broken = true; continue; }
      multi = true;
      got = min(tn - 1, total);
      memcpy(out, tmp + 1, got);
      nextSeq = 1;
    } else if ((pci & 0xF0) == 0x20 && multi) { // consecutive frame
      // Sequence has to be checked here, not just the byte count: this clone drops
      // whole responses (see FINDINGS), and a missing middle frame otherwise slots
      // the following frame's bytes into the gap and corrupts everything after it.
      if ((pci & 0x0F) != nextSeq) { broken = true; continue; }
      nextSeq = (nextSeq + 1) & 0x0F;
      size_t cnt = min(tn, total - got);
      memcpy(out + got, tmp, cnt);
      got += cnt;
      if (got >= total) return (int)got;
    }
  }

  if (negative) return -2;
  if (multi && partial) *partial = (int)got;    // salvageable if the caller can verify it
  return (multi || broken) ? -3 : -1;           // started but never completed
}

// Dispatcher - everything above the transport layer calls this.
static int obdIsoTp(uint32_t reqId, uint32_t rspId,
                    const uint8_t *payload, uint8_t plen,
                    uint8_t *out, size_t outCap, uint32_t timeoutMs,
                    int *partial = nullptr) {
  // The same seven-byte single-frame limit canIsoTp enforces, stated once at the
  // door so both transports refuse an over-long request identically rather than one
  // truncating it into a valid-looking shorter request.
  if (plen == 0 || plen > 7) return -1;
  // One exchange at a time. The wait loops below serve HTTP, so a handler can run
  // underneath a half-finished reassembly; a second request issued from there would
  // interleave its frames with ours and corrupt both.
  g_busBusy = true;
  int r = (activeTransport == TR_BLE)
        ? bleIsoTp(reqId, rspId, payload, plen, out, outCap, timeoutMs, partial)
        : canIsoTp(reqId, rspId, payload, plen, out, outCap, timeoutMs, partial);
  g_busBusy = false;
  return r;
}

// ---------------------------------------------------------------- mode 01

// Data-field byte count per SAE J1979 PID.
static uint8_t pidLen(uint8_t pid) {
  switch (pid) {
    case 0x0C: case 0x1F: case 0x3C: case 0x42: case 0x5E:
    case 0x43: case 0x63: return 2;
    case 0x34: return 4;
    default:   return 1;
  }
}

static void applyPid(Live &L, uint8_t pid, const uint8_t *d) {
  float A = d[0], B = d[1];
  switch (pid) {
    case 0x04: L.load     = A * 100.0f / 255.0f; break;
    case 0x05: L.coolant  = A - 40;              break;
    case 0x06: L.stft     = (A - 128) * 100.0f / 128.0f; break;
    case 0x07: L.ltft     = (A - 128) * 100.0f / 128.0f; break;
    case 0x0B: L.map_     = A;                   break;
    case 0x0C: L.rpm      = (256 * A + B) / 4.0f; break;
    case 0x0D: L.speed    = A;                   break;
    case 0x0E: L.timing   = A / 2.0f - 64.0f;    break;
    case 0x0F: L.iat      = A - 40;              break;
    case 0x11: L.throttle = A * 100.0f / 255.0f; break;
    case 0x1F: L.runtime  = 256 * A + B;         break;
    case 0x2F: L.fuel     = A * 100.0f / 255.0f; break;
    case 0x33: L.baro     = A;                   break;
    case 0x34: L.lambda   = (256 * A + B) / 32768.0f; break;
    case 0x3C: L.cat      = (256 * A + B) / 10.0f - 40.0f; break;
    case 0x42: L.volt     = (256 * A + B) / 1000.0f; break;
    case 0x46: L.ambient  = A - 40;              break;
    case 0x5C: L.oil      = A - 40;              break;
    case 0x5E: L.fuelRate = (256 * A + B) / 20.0f; break;
    // Driver demand -> ECU decision -> delivered torque. Scalings are the J1979
    // ones; they have not been checked against this car, which is what the torque
    // question in FINDINGS is about. A wrong *length* would be caught by
    // mode01Walk, but a wrong scaling would not, so treat the numbers as
    // provisional until they have been watched under load.
    case 0x43: L.absLoad     = (256 * A + B) * 100.0f / 255.0f; break;
    case 0x49: L.pedalD      = A * 100.0f / 255.0f; break;
    case 0x4A: L.pedalE      = A * 100.0f / 255.0f; break;
    case 0x4C: L.cmdThrottle = A * 100.0f / 255.0f; break;
    case 0x61: L.torqDem     = A - 125.0f;          break;
    case 0x62: L.torqAct     = A - 125.0f;          break;
    case 0x63: L.torqRef     = 256 * A + B;         break;
  }
}

// Walk a mode-01 reply as (pid, data...) pairs.
//
// The payload is self-describing, so a short reply can be *checked* rather than
// either trusted or thrown away: every pid must be one we asked for, and its data
// bytes must actually be present. A reply cut off mid-message therefore still
// yields the pairs that arrived intact, while a misframed one is rejected outright
// because a pid we never requested means the bytes are not what they claim to be.
//
// This matters on the BLE path, where a reply arriving without the ELM's '>' prompt
// is truncated by definition. Discarding those wholesale left the dashboard with
// almost nothing to show and dragged polling down to a fraction of a hertz.
// Applying whichever pairs verify is both safe and far more useful - the dashboard
// holds the remaining fields at their previous reading.
static int mode01Walk(const uint8_t *buf, int len,
                      const uint8_t *pids, uint8_t n, Live *out) {
  if (len < 2 || buf[0] != 0x41) return -1;
  int i = 1, applied = 0;
  while (i < len) {
    uint8_t pid = buf[i++];
    bool asked = false;
    for (uint8_t k = 0; k < n; k++) if (pids[k] == pid) { asked = true; break; }
    if (!asked) return -1;                 // misframed - none of it is trustworthy
    uint8_t w = pidLen(pid);
    if (i + w > len) break;                // cut mid-value: keep the pairs before it
    if (out) {
      uint8_t d[4] = {0, 0, 0, 0};
      memcpy(d, &buf[i], w);
      applyPid(*out, pid, d);
    }
    i += w;
    applied++;
  }
  return applied;
}

// One batched mode-01 request carrying up to 6 PIDs.
//
// A reply is accepted when at least one (pid, data) pair verifies, whether or not
// the ISO-TP reassembly completed. Only a reply yielding nothing is retried, and a
// silent (-1) or refused (-2) ECU is not retried at all: there is nothing to wait
// for, and a second full timeout on all three batches makes /data crawl with the
// ignition off.
static bool pollBatch(Live &L, const uint8_t *pids, uint8_t n,
                      uint8_t *keep = nullptr, uint8_t *keepLen = nullptr) {
  uint8_t req[7];
  req[0] = 0x01;
  memcpy(&req[1], pids, n);

  const uint32_t tmo = (activeTransport == TR_BLE) ? 1200 : 400;
  uint8_t buf[64], best[64];
  int bestLen = 0, bestGot = 0;

  for (int attempt = 0; attempt < 2; attempt++) {
    int partial = 0;
    int len = obdIsoTp(ID_ECM_REQ, ID_ECM_RSP, req, n + 1, buf, sizeof(buf), tmo, &partial);
    if (len == -3 && partial > 0) len = partial;   // truncated, but worth checking
    if (len == -1 || len == -2) break;             // silent or refused: nothing to wait for

    if (len >= 2) {
      int got = mode01Walk(buf, len, pids, n, nullptr);
      if (got >= n) {                              // every pid we asked for
        mode01Walk(buf, len, pids, n, &L);
        if (keep && keepLen) { memcpy(keep, buf, (size_t)len); *keepLen = (uint8_t)len; }
        return true;
      }
      if (got > bestGot) {                         // keep the fullest verified reply
        bestGot = got;
        bestLen = len;
        memcpy(best, buf, (size_t)len);
      }
    }
  }

  // Retrying did not produce a complete batch, so use the most complete verified
  // reply we did see rather than reporting nothing at all.
  if (bestGot > 0) {
    mode01Walk(best, bestLen, pids, n, &L);
    if (keep && keepLen) { memcpy(keep, best, (size_t)bestLen); *keepLen = (uint8_t)bestLen; }
    return true;
  }
  return false;
}

static float g_baro = NAN;
// Engine reference torque (PID 63) is a constant for the engine, and PIDs 61/62
// report torque as a percentage of it - so it is read once and cached, like baro,
// rather than spending a slot in every rotation.
static float g_torqRef = NAN;

// The three batched mode-01 requests that make up one sample.
static const uint8_t PID_B1[6] = {0x0C, 0x0D, 0x0B, 0x11, 0x04, 0x05};
static const uint8_t PID_B2[6] = {0x5C, 0x0F, 0x42, 0x06, 0x07, 0x5E};
static const uint8_t PID_B3[6] = {0x34, 0x3C, 0x0E, 0x1F, 0x46, 0x2F};
// Driver demand and the engine's answer to it. Grouped together and polled at b1's
// cadence because these are the fastest-moving values on the car - a pedal input
// sampled every few seconds tells you nothing.
static const uint8_t PID_B4[6] = {0x49, 0x4A, 0x4C, 0x61, 0x62, 0x43};

// Which batch to poll on each turn.
//
// b1 carries everything the driver actually watches - rpm, speed, MAP, throttle,
// load, coolant, and so both sparkline heroes - so it gets half the turns. Oil
// temperature, battery voltage and catalyst temperature do not move fast enough to
// justify equal billing, and on BLE every batch is a full ELM round trip, so equal
// billing is exactly what was holding the interesting numbers to a third of the
// achievable rate.
// b1 and b4 are the fast pair - what the car is doing and what the driver asked for.
// b2 and b3 are temperatures, trims and the like, which do not need equal billing.
static const uint8_t SAMPLE_ORDER[6] = {0, 3, 1, 0, 3, 2};

// Longest a cached batch may keep contributing to a published sample. Past this it
// is dropped to NAN rather than presented as current - the dashboard then holds it
// briefly and finally shows an em-dash, instead of a stale number reading as live.
//
// This has to be derived from how often a batch is actually polled, not fixed. b2
// and b3 come round once every four batches, so a flat 3 s only holds if a batch
// completes in under 750 ms. Over BLE a batch is comfortably longer than that, and
// those two batches then expire before their next turn - blanking twelve of the
// twenty rows on every cycle. Three cycles of headroom, floored so a fast CAN link
// still drops genuinely dead data promptly, and capped so a stall cannot leave
// minutes-old numbers on screen.
static const uint32_t SAMPLE_STALE_MIN_MS = 3000;
static const uint32_t SAMPLE_STALE_MAX_MS = 20000;

static uint32_t sampleStaleMs(uint32_t cycleMs) {
  uint32_t w = cycleMs * 3;
  if (w < SAMPLE_STALE_MIN_MS) w = SAMPLE_STALE_MIN_MS;
  if (w > SAMPLE_STALE_MAX_MS) w = SAMPLE_STALE_MAX_MS;
  return w;
}

static const uint8_t *sampleBatchPids(uint8_t b) {
  return (b == 0) ? PID_B1 : (b == 1) ? PID_B2 : (b == 2) ? PID_B3 : PID_B4;
}
static const uint8_t SAMPLE_BATCHES = 4;

// Rebuild a sample from whichever cached batches are still fresh.
//
// Caching the accepted bytes rather than merging three Live structs means the
// staleness rule is one timestamp per batch, and re-walking is the same verified
// parse that accepted them in the first place.
static bool sampleMerge(Live &out, const uint8_t bufs[4][40], const uint8_t *lens,
                        const uint32_t *stamps, uint32_t now, uint32_t staleMs) {
  bool any = false;
  for (uint8_t b = 0; b < SAMPLE_BATCHES; b++) {
    if (!lens[b] || !stamps[b]) continue;
    if (now - stamps[b] > staleMs) continue;
    if (mode01Walk(bufs[b], lens[b], sampleBatchPids(b), 6, &out) > 0) any = true;
  }
  return any;
}

// ---------------------------------------------------------------- mode 06 monitors

// Mode 06 reports the ECU's own on-board test results: what each monitor measured
// and the limits it is judged against. The car supports it (FINDINGS records
// `46 00 C0000001`) and nothing has ever asked for it.
//
// A support mask comes back as `46 MM b0 b1 b2 b3` - 32 bits covering the next 32
// monitor ids, most significant bit first. The last bit is the id of the *next*
// support mask, which is how the ranges chain: 00 -> 20 -> 40 and so on.
static uint8_t monMaskMids(const uint8_t *buf, int len, uint8_t base,
                           uint8_t *out, uint8_t cap) {
  if (len < 6 || buf[0] != 0x46 || buf[1] != base) return 0;
  uint8_t n = 0;
  for (uint8_t i = 0; i < 32 && n < cap; i++)
    if (buf[2 + (i >> 3)] & (uint8_t)(0x80 >> (i & 7))) out[n++] = (uint8_t)(base + 1 + i);
  return n;
}

// Results are repeating nine-byte records: mid, tid, uas, then value, min and max
// as 16-bit words. A reply can carry several, and a trailing part-record is
// ignored rather than half-read.
static uint8_t monParse(const uint8_t *buf, int len, MonRec *out, uint8_t cap) {
  if (len < 1 || buf[0] != 0x46) return 0;
  uint8_t n = 0;
  for (int i = 1; i + 8 < len && n < cap; i += 9, n++) {
    out[n].mid   = buf[i];
    out[n].tid   = buf[i + 1];
    out[n].uas   = buf[i + 2];
    out[n].value = (uint16_t)((buf[i + 3] << 8) | buf[i + 4]);
    out[n].lo    = (uint16_t)((buf[i + 5] << 8) | buf[i + 6]);
    out[n].hi    = (uint16_t)((buf[i + 7] << 8) | buf[i + 8]);
  }
  return n;
}

// ---------------------------------------------------------------- DID scanner

struct ScanState {
  bool     running = false;
  bool     stalled = false;      // ECU stopped answering; holding position
  uint8_t  ecu = 0;
  uint32_t cur = 0, from = 0, to = 0xFFFF;
  uint32_t tried = 0, negatives = 0;
  uint32_t startedMs = 0;
} scan;

// A sweep is tens of thousands of requests - the better part of a day over BLE - so
// it has to survive the car being switched off, and it must not keep sweeping when
// the ECU has stopped answering.
//
// A timeout and a negative response mean opposite things here. A negative response
// is the ECU saying "no such identifier", which is a result worth recording. A
// timeout is no answer at all, and a run of them means the ignition went off. Those
// identifiers were never actually asked, and writing them down as "no response"
// would turn an unswept range into one that looks swept and empty - the same class
// of silent wrong answer as the ATCRA bug in FINDINGS.
static const uint16_t SCAN_STALL_AFTER = 25;    // consecutive timeouts
static const uint32_t SCAN_PROBE_MS    = 3000;  // how often to test a stalled bus
static uint16_t scanSilent = 0;
static uint32_t scanProbeAt = 0;

// The hit list used to be a std::vector on the heap, capped at 3000 entries - about
// 84 KB of a 320 KB heap, competing with the web server and the TLS-free but still
// hungry Wi-Fi stack. It lives in PSRAM now, where 8 MB sits otherwise unused, and
// the cap can be generous instead of a compromise. Without PSRAM it falls back to a
// modest heap allocation rather than refusing to scan.
static Hit     *scanHits   = nullptr;
static uint16_t scanHitCap = 0;
static uint16_t scanHitN   = 0;
static bool     scanHitsPsram = false;

static void scanHitsBegin() {
  const uint16_t want = 4000;
  if (psramFound()) {
    scanHits = (Hit *)ps_malloc(sizeof(Hit) * want);
    if (scanHits) { scanHitCap = want; scanHitsPsram = true; }
  }
  if (!scanHits) {
    const uint16_t fallback = 400;
    scanHits = (Hit *)malloc(sizeof(Hit) * fallback);
    scanHitCap = scanHits ? fallback : 0;
  }
  Serial.printf("[mem] psram %s, scan hits cap %u (%s)\n",
                psramFound() ? "present" : "absent", scanHitCap,
                scanHitsPsram ? "psram" : "heap");
}

static Preferences scanPrefs;
static const char *SCAN_HITS_FILE = "/scanhits.csv";

// Position is tiny and goes to NVS. Hits go to the filesystem as they are found, so
// they are durable the moment they exist rather than at the end of a sweep that may
// never come.
static void scanSaveState() {
  if (!scanPrefs.begin("nexonscan", false)) return;
  scanPrefs.putBool("run", scan.running);
  scanPrefs.putUChar("ecu", scan.ecu);
  scanPrefs.putULong("from", scan.from);
  scanPrefs.putULong("to", scan.to);
  scanPrefs.putULong("cur", scan.cur);
  scanPrefs.putULong("tried", scan.tried);
  scanPrefs.putULong("neg", scan.negatives);
  scanPrefs.end();
}

static void scanAppendHit(const Hit &h) {
  if (!tripFsUp) return;
  File f = LittleFS.open(SCAN_HITS_FILE, FILE_APPEND);
  if (!f) return;
  f.printf("%c,%04X,%u,", h.ecu ? 'T' : 'E', h.did, h.len);
  for (uint8_t k = 0; k < h.len; k++) f.printf("%02X", h.data[k]);
  f.print('\n');
  f.close();
}

static void scanLoadHits() {
  if (!tripFsUp || !LittleFS.exists(SCAN_HITS_FILE)) return;
  File f = LittleFS.open(SCAN_HITS_FILE, FILE_READ);
  if (!f) return;
  while (f.available() && scanHitN < scanHitCap) {
    String line = f.readStringUntil('\n');
    if (line.length() < 6) continue;
    Hit h;
    h.ecu = (line[0] == 'T') ? 1 : 0;
    h.did = (uint16_t)strtoul(line.substring(2, 6).c_str(), nullptr, 16);
    int c2 = line.indexOf(',', 7);
    if (c2 < 0) continue;
    String hex = line.substring(c2 + 1);
    h.len = (uint8_t)min((size_t)(hex.length() / 2), sizeof(h.data));
    for (uint8_t k = 0; k < h.len; k++)
      h.data[k] = (uint8_t)strtoul(hex.substring(k * 2, k * 2 + 2).c_str(), nullptr, 16);
    scanHits[scanHitN++] = h;
  }
  f.close();
  Serial.printf("[scan] %u hits restored from flash\n", scanHitN);
}

static void scanBegin() {
  if (!scanPrefs.begin("nexonscan", true)) return;
  bool wasRunning = scanPrefs.getBool("run", false);
  scan.ecu       = scanPrefs.getUChar("ecu", 0);
  scan.from      = scanPrefs.getULong("from", 0);
  scan.to        = scanPrefs.getULong("to", 0xFFFF);
  scan.cur       = scanPrefs.getULong("cur", 0);
  scan.tried     = scanPrefs.getULong("tried", 0);
  scan.negatives = scanPrefs.getULong("neg", 0);
  scanPrefs.end();
  if (!wasRunning || scan.cur > scan.to) { scan.running = false; return; }

  // Resume rather than wait to be asked. A sweep is started deliberately and takes
  // hours; having it silently abandon itself every time the car is switched off
  // would make finishing one impossible. The Live page shows it is running.
  scanLoadHits();
  scan.running = true;
  scan.startedMs = millis();
  Serial.printf("[scan] resuming %s at %04X (%lu already tried)\n",
                scan.ecu ? "TCM" : "ECM", (unsigned)scan.cur, (unsigned long)scan.tried);
}

// Time-boxed rather than counted. A fixed count of identifiers is a wildly
// different amount of wall-clock per transport - 40 DIDs is about a second on CAN
// but roughly 22 s over BLE, during which nothing answers the web server and the
// board looks hung. A millisecond budget behaves the same on both.
static void scanStep(uint32_t budgetMs) {
  uint32_t reqId = scan.ecu ? ID_TCM_REQ : ID_ECM_REQ;
  uint32_t rspId = scan.ecu ? ID_TCM_RSP : ID_ECM_RSP;
  uint32_t started = millis();

  // Stalled means the ECU stopped answering. Hold position and probe occasionally
  // rather than sweeping thousands of identifiers that were never really asked.
  if (scan.stalled) {
    if (millis() - scanProbeAt < SCAN_PROBE_MS) return;
    scanProbeAt = millis();
    uint8_t probe[2] = {0x01, 0x00};
    uint8_t pbuf[16];
    if (obdIsoTp(reqId, rspId, probe, 2, pbuf, sizeof(pbuf),
                 activeTransport == TR_BLE ? 1200 : 400) > 0) {
      scan.stalled = false;
      scanSilent = 0;
      Serial.println("[scan] ECU answering again - resuming");
    }
    return;
  }

  while (scan.running && millis() - started < budgetMs) {
    if (scan.cur > scan.to) { scan.running = false; break; }

    uint16_t did = (uint16_t)scan.cur++;
    scan.tried++;

    uint8_t req[3] = {0x22, (uint8_t)(did >> 8), (uint8_t)(did & 0xFF)};
    uint8_t buf[64];
    int len = obdIsoTp(reqId, rspId, req, 3, buf, sizeof(buf),
                       activeTransport == TR_BLE ? 550 : 25);

    // Truncated reply: retry once with a longer window. A DID that answers at all
    // is the find here, so dropping it over a lost frame would undercount the sweep
    // exactly the way a single ELM327 pass already does (FINDINGS).
    if (len == -3) len = obdIsoTp(reqId, rspId, req, 3, buf, sizeof(buf),
                                  activeTransport == TR_BLE ? 900 : 50);

    // A negative response is the ECU answering; a timeout is not. Only the former
    // counts as having swept this identifier.
    if (len == -2) { scanSilent = 0; scan.negatives++; continue; }
    if (len == -1) {
      if (++scanSilent >= SCAN_STALL_AFTER) {
        scan.cur = did;                 // un-consume it: it was never really asked
        scan.tried--;
        scan.stalled = true;
        scanProbeAt = millis();
        scanSaveState();
        Serial.printf("[scan] %u silent in a row at %04X - stalling, not recording\n",
                      scanSilent, (unsigned)did);
        return;
      }
      continue;
    }
    scanSilent = 0;
    if (len < 3) continue;
    if (buf[0] != 0x62) continue;
    if (((buf[1] << 8) | buf[2]) != did) continue;

    Hit h;
    h.did = did;
    h.ecu = scan.ecu;
    h.len = (uint8_t)min((size_t)(len - 3), sizeof(h.data));
    memcpy(h.data, &buf[3], h.len);
    if (scanHitN < scanHitCap) scanHits[scanHitN++] = h;
    scanAppendHit(h);                   // durable the moment it is found
  }
}

// ---------------------------------------------------------------- DID watch

static Preferences watchPrefs;

static void watchSave() {
  if (!watchPrefs.begin("nexonwatch", false)) return;
  uint8_t blob[WATCH_MAX * 3];
  size_t n = watchEncode(watch, watchN, blob, sizeof(blob));
  watchPrefs.putBytes("set", blob, n);
  watchPrefs.putULong("period", watchPeriodMs);
  watchPrefs.end();
}

static void watchLoad() {
  if (!watchPrefs.begin("nexonwatch", true)) return;
  uint8_t blob[WATCH_MAX * 3];
  size_t n = watchPrefs.getBytes("set", blob, sizeof(blob));
  watchN = watchDecode(blob, n, watch, WATCH_MAX);
  watchPeriodMs = watchPrefs.getULong("period", 1000);
  watchPrefs.end();
  if (watchPeriodMs < WATCH_PERIOD_MIN) watchPeriodMs = WATCH_PERIOD_MIN;
  if (watchPeriodMs > WATCH_PERIOD_MAX) watchPeriodMs = WATCH_PERIOD_MAX;
  if (watchN) Serial.printf("[watch] %u identifiers, every %lums\n",
                            watchN, (unsigned long)watchPeriodMs);
}

// One identifier per period, round robin. Deliberately modest: every read is an
// extra bus exchange, and BLE only affords about six a second in total, so a set of
// eight at the default 1 s costs roughly a sixth of the budget. The page states
// that cost rather than leaving the live rate to quietly sag.
//
// Paused entirely while a sweep runs. A sweep is already hours long and shares the
// bus with the sampler; adding a third claimant would do both jobs badly.
static void watchStep() {
  if (!watchN || scan.running) return;
  if (millis() - watchLastMs < watchPeriodMs) return;
  watchLastMs = millis();

  if (watchTurn >= watchN) watchTurn = 0;
  WatchDid &w = watch[watchTurn];
  watchTurn = (uint8_t)((watchTurn + 1) % watchN);

  uint32_t reqId = w.ecu ? ID_TCM_REQ : ID_ECM_REQ;
  uint32_t rspId = w.ecu ? ID_TCM_RSP : ID_ECM_RSP;
  uint8_t req[3] = {0x22, (uint8_t)(w.did >> 8), (uint8_t)(w.did & 0xFF)};
  uint8_t buf[40];
  int len = obdIsoTp(reqId, rspId, req, 3, buf, sizeof(buf),
                     activeTransport == TR_BLE ? 550 : 25);
  if (len == -3) len = obdIsoTp(reqId, rspId, req, 3, buf, sizeof(buf),
                                activeTransport == TR_BLE ? 900 : 50);

  // 62 <did hi> <did lo> <data...>. A reply about a different identifier is this
  // adapter demultiplexing badly, not an answer - drop it rather than filing the
  // bytes under the wrong name, which would poison the correlation silently.
  if (len < 4 || buf[0] != 0x62) return;
  if ((((uint16_t)buf[1] << 8) | buf[2]) != w.did) return;

  uint8_t n = (uint8_t)(len - 3);
  if (n > sizeof(w.data)) n = sizeof(w.data);
  memcpy(w.data, &buf[3], n);
  w.len   = n;
  w.stamp = millis();
}

// Monitor discovery and refresh run in loop() like everything else that touches the
// bus, and only while someone is actually looking at the page - a request to /mon
// arms it for MON_WANTED_MS. Polling monitors continuously would spend bus time on
// values that change over minutes, at the expense of the ones that change now.
static const uint8_t  MON_MAX        = 24;
static const uint8_t  MON_MIDS_MAX   = 16;
static const uint32_t MON_PERIOD_MS  = 1500;
static const uint32_t MON_WANTED_MS  = 30000;

static MonRec   monRec[MON_MAX];
static uint8_t  monCount = 0;
static uint8_t  monMids[MON_MIDS_MAX];
static uint8_t  monMidCount = 0;
static uint8_t  monNext = 0;
static uint8_t  monDiscBase = 0x00;
static bool     monDiscovered = false;
static uint32_t monWantedMs = 0;
static uint32_t monLastMs = 0;

// Replace this monitor's records rather than appending, so a refresh updates in
// place instead of growing the table every pass.
static void monStore(uint8_t mid, const MonRec *recs, uint8_t n) {
  uint8_t w = 0;
  for (uint8_t i = 0; i < monCount; i++)
    if (monRec[i].mid != mid) monRec[w++] = monRec[i];
  monCount = w;
  for (uint8_t i = 0; i < n && monCount < MON_MAX; i++) monRec[monCount++] = recs[i];
}

static void monStep() {
  if (scan.running) return;
  if (!monWantedMs || millis() - monWantedMs > MON_WANTED_MS) return;
  if (millis() - monLastMs < MON_PERIOD_MS) return;
  if (activeTransport == TR_NONE) return;
  monLastMs = millis();

  uint8_t buf[128];
  const uint32_t tmo = (activeTransport == TR_BLE) ? 1200 : 400;

  if (!monDiscovered) {
    uint8_t req[2] = {0x06, monDiscBase};
    int len = obdIsoTp(ID_ECM_REQ, ID_ECM_RSP, req, 2, buf, sizeof(buf), tmo);
    uint8_t got[32];
    uint8_t n = (len > 0) ? monMaskMids(buf, len, monDiscBase, got, 32) : 0;
    bool more = false;
    for (uint8_t i = 0; i < n; i++) {
      if (got[i] == (uint8_t)(monDiscBase + 0x20)) { more = true; continue; }  // range marker
      if (monMidCount < MON_MIDS_MAX) monMids[monMidCount++] = got[i];
    }
    if (more && monDiscBase < 0xA0) monDiscBase = (uint8_t)(monDiscBase + 0x20);
    else { monDiscovered = true; monNext = 0; }
    Serial.printf("[mon] base %02X -> %u ids (%u total)%s\n",
                  monDiscBase, n, monMidCount, monDiscovered ? " done" : "");
    return;
  }

  if (!monMidCount) return;
  uint8_t mid = monMids[monNext];
  monNext = (uint8_t)((monNext + 1) % monMidCount);

  uint8_t req[2] = {0x06, mid};
  int len = obdIsoTp(ID_ECM_REQ, ID_ECM_RSP, req, 2, buf, sizeof(buf), tmo);
  if (len < 1) return;
  MonRec recs[12];
  uint8_t n = monParse(buf, len, recs, 12);
  if (n) monStore(mid, recs, n);
}

// ---------------------------------------------------------------- HTTP

static void jsonNum(String &s, const char *k, float v, int dp) {
  s += "\"";
  s += k;
  s += "\":";
  if (isnan(v)) s += "null"; else s += String(v, dp);
  s += ",";
}

static const char *transportName();

static uint32_t lastEcuOkMs;
static bool     everSawEcu = false;

// The newest complete sample, refreshed by the sampler in loop(). /data serves this
// rather than polling the ECU inline, so a page request is never stuck behind a bus
// exchange and switching pages is immediate.
static Live     g_live;
static uint32_t g_liveMs = 0;
static uint32_t g_seq    = 0;      // increments per published sample

// Transport re-pick backoff.
//
// The adapter is powered from the OBD port and stays alive with the car switched
// off; the board is on the accessory socket and does not. So on every start the
// board comes up against an ELM327 that may still be holding the BLE link to a
// device that vanished without ever disconnecting, and the first connect can fail
// through no fault of the wiring. A flat retry interval meant a dead dashboard for
// that whole interval at every ignition - so start impatient and ease off.
static const uint32_t PICK_MIN_MS = 2000;
static const uint32_t PICK_MAX_MS = 20000;

static uint32_t pickBackoff(uint32_t cur) {
  uint32_t next = cur ? cur * 2 : PICK_MIN_MS;
  return next > PICK_MAX_MS ? PICK_MAX_MS : next;
}

// ---------------------------------------------------------------- trip totals
//
// Fuel economy is the number that says something about a drive, and it cannot be
// read off the bus - it has to be integrated, from speed (PID 0D) and fuel rate
// (PID 5E), both of which this ECU supports. Accumulated on the board rather than
// on the page, so closing the browser or locking the phone does not lose the drive.
//
// Totals start at zero every time the board powers up. Given the accessory-socket
// supply that is exactly one drive, which is the span an average is worth over.
//
// A power cut is the end of a drive; a deep-sleep wake is not. On the permanently
// live pin 16 the board sleeps after IDLE_SLEEP_MS and wakes through setup() every
// SLEEP_WAKE_US, so plain statics would reset the drive's totals mid-drive - and
// the dashboard's mileage, the "right now" figure and the trip_km/trip_l columns
// all read from these, so every one of them would inherit the reset. RTC slow
// memory carries them over a wake for free and is still cleared by a power cut,
// which is exactly the distinction wanted.
//
// Same magic idiom as history.h and clock.h: RTC memory is garbage on a cold boot,
// so nothing here may be trusted until the magic says it was written by this build.
#define TRIPINT_MAGIC 0x4E584903UL
RTC_DATA_ATTR static uint32_t tripIntMagic;
RTC_DATA_ATTR static float    g_tripKm;
RTC_DATA_ATTR static float    g_tripL;
// Deliberately not in RTC memory. It is the timestamp the next interval is measured
// from, and a sleep is precisely the gap TRIP_INT_MAX_MS exists to refuse to
// integrate across - so it must come back zeroed and make the first sample after a
// wake start a fresh interval rather than close the one that spans the sleep.
static uint32_t tripIntAt = 0;

static void tripIntBegin() {
  if (tripIntMagic == TRIPINT_MAGIC) return;   // carried across a deep-sleep wake
  tripIntMagic = TRIPINT_MAGIC;
  g_tripKm = 0.0f;
  g_tripL  = 0.0f;
}

// A longer gap than this is not an interval anything is known about - a BLE
// dropout, a scan taking the bus, a wake from sleep. Integrating across it would
// invent distance and fuel that were never measured.
static const uint32_t TRIP_INT_MAX_MS = 5000;

// Both inputs or neither. Counting distance while the fuel rate is missing would
// quietly bias the average optimistic, and that is the one direction a mileage
// figure must never drift.
static void tripIntegrate(float speedKmh, float rateLph, uint32_t now) {
  uint32_t prev = tripIntAt;
  tripIntAt = now;
  if (!prev) return;                          // first sample: no interval yet
  uint32_t dt = now - prev;
  if (dt == 0 || dt > TRIP_INT_MAX_MS) return;
  if (isnan(speedKmh) || isnan(rateLph)) return;
  if (speedKmh < 0 || rateLph < 0) return;    // a decode that went wrong
  g_tripKm += speedKmh * dt / 3600000.0f;
  g_tripL  += rateLph  * dt / 3600000.0f;
}

// How long the rail has been under BATT_SLEEP_V without a break, or 0 for not low.
static uint32_t g_battLow = 0;

// The battery floor, as a pure step so the rule can be tested rather than driven at
// a real battery - which is a test that takes a flat car to run once.
//
// Returns the new run start: 0 means the run is broken, otherwise the moment it
// began. Sleeping is that being old enough, which the caller decides.
static uint32_t battLowStep(uint32_t lowSince, float volt, float rpm, uint32_t now) {
  // Never on absent data. An unread voltage is not a low voltage and an unknown
  // engine state is not a stopped engine. This is the same rule voltFlag() follows
  // on the page, where it is load-bearing in the most literal way - `null < 12.2`
  // is true in JavaScript, and getting it wrong there reported a healthy charging
  // system as broken. Getting it wrong here would switch the board off mid-drive.
  if (isnan(volt) || isnan(rpm)) return 0;
  // The engine turning is proof something is charging, whatever the rail reads -
  // and cranking is exactly when it reads lowest.
  if (rpm >= BATT_ENGINE_RPM) return 0;
  if (volt >= BATT_SLEEP_V) return 0;
  // millis() is 0 for the first millisecond after boot, and 0 is the sentinel for
  // "not low", so the run would never start if it began there.
  return lowSince ? lowSince : (now ? now : 1);
}

static uint32_t pickWaitMs = PICK_MIN_MS;

// One cached reply per batch, with the moment it arrived.
static uint8_t  sampBuf[4][40];
static uint8_t  sampLen[4]   = {0, 0, 0, 0};
static uint32_t sampStamp[4] = {0, 0, 0, 0};
static uint8_t  sampTurn     = 0;
static uint32_t sampBatchMs  = 0;    // how long the last batch took, for the log
static uint32_t sampCycleMs  = 0;    // measured duration of one SAMPLE_ORDER pass
static uint32_t sampCycleAt  = 0;

// One batch per turn, and a fresh sample published after every one of them.
//
// Previously a sample needed all three batches before anything reached the page, so
// the update rate was one third of the batch rate - under 1 Hz on BLE. Publishing
// after each batch, with the other two carried forward from cache while they are
// still fresh, means the page updates at the batch rate and the values in b1 refresh
// twice as often as the rest.
// While a scan runs it gets most of the bus, but not all of it. A full 0000-FFFF
// sweep is over half an hour on CAN and the better part of a day over BLE, and
// freezing the dashboard for that long is not a reasonable trade for the ~15 % of
// scan throughput this costs. One batch every couple of seconds keeps the live
// values moving, slowly, and keeps the page honest about being alive.
static const uint32_t SCAN_SHARE_MS = 2000;
static uint32_t sampSharedMs = 0;

static void samplerStep() {
  if (scan.running) {
    if (millis() - sampSharedMs < SCAN_SHARE_MS) return;
    sampSharedMs = millis();
  }

  const uint8_t turns = sizeof(SAMPLE_ORDER) / sizeof(SAMPLE_ORDER[0]);
  uint8_t b = SAMPLE_ORDER[sampTurn];
  sampTurn = (uint8_t)((sampTurn + 1) % turns);
  if (sampTurn == 0) {                 // a full pass just finished - time it
    uint32_t now = millis();
    if (sampCycleAt) sampCycleMs = now - sampCycleAt;
    sampCycleAt = now;
  }

  Live scratch;
  uint8_t buf[40], len = 0;
  uint32_t t0 = millis();
  bool okb = pollBatch(scratch, sampleBatchPids(b), 6, buf, &len);
  sampBatchMs = millis() - t0;

  if (okb && len) {
    memcpy(sampBuf[b], buf, len);
    sampLen[b]   = len;
    sampStamp[b] = millis();
  }

  Live pub;
  bool any = sampleMerge(pub, sampBuf, sampLen, sampStamp, millis(),
                         sampleStaleMs(sampCycleMs));

  if (any && isnan(g_baro)) {
    Live t;
    static const uint8_t b0[] = {0x33};
    if (pollBatch(t, b0, 1)) g_baro = t.baro;
  }
  pub.baro = g_baro;
  pub.ok   = any;

  if (any) tripIntegrate(pub.speed, pub.fuelRate, millis());
  pub.tripKm = g_tripKm;
  pub.tripL  = g_tripL;

  if (any) {
    g_live   = pub;
    g_liveMs = millis();
    g_seq++;
    lastEcuOkMs = millis();
    everSawEcu  = true;
    histTick(g_live);
    // Beside histTick, and for the same reason: both record a published sample, and
    // this branch is the only place one exists. Not from loop() - g_live keeps its
    // last good sample with ok still set once the ECU stops answering, so a caller
    // out there would write a row a second of carried-forward values for as long as
    // the car was silent, which is the one thing the trip log must never do. Each
    // owns its own period gate, so being called per sample rather than per second
    // costs a comparison.
    tripTick(g_live);
  }
}

// Scan progress, emitted on both the fresh and stale branches.
//
// This used to live only on the ok:true path, which is precisely the path that
// cannot be taken while a scan is running - so the progress bar sat at 0 % for the
// entire sweep and the header transport read as an em-dash.
static void jsonScan(String &s) {
  uint32_t total = scan.to - scan.from + 1;
  s += ",\"scan\":";
  s += scan.running ? "true" : "false";
  if (scan.running) {
    s += ",\"scanPct\":";
    s += String(total ? (scan.tried * 100.0f / total) : 0.0f, 2);
    s += ",\"scanTried\":";
    s += scan.tried;
    s += ",\"scanTotal\":";
    s += total;
    s += ",\"scanEcu\":\"";
    s += scan.ecu ? "TCM" : "ECM";
    s += "\"";
  }
}

// The sampling receipt: what the board actually achieved, rather than what it was
// asked for.
//
// Every number here already existed. sampCycleMs, sampBatchMs, sampStamp[] and
// sampleStaleMs() are computed on every pass and printed to the serial log, where
// nobody in a car can see them, and then thrown away. So the page has been drawing
// values with no way to say how fast they really arrive or how old the oldest of
// them is.
//
// That is the most under-reported number in this whole class of tool. The ELM327
// request/response round trip puts a cheap clone somewhere around five PIDs a
// second, and no consumer app shows the rate actually being achieved - so people set
// a tenth-of-a-second logging interval, get values that change once a second, and
// have no way to find out which one is the truth. Publishing it costs about sixty
// bytes a poll.
//
// Emitted on both the fresh and the stale path, like jsonScan. How fast the sampler
// is managing to go is exactly as interesting when nothing is coming back.
static void jsonQuality(String &s) {
  uint32_t now = millis();
  s += ",\"q\":{\"cycleMs\":";
  s += sampCycleMs;
  s += ",\"batchMs\":";
  s += sampBatchMs;
  s += ",\"staleMs\":";
  s += sampleStaleMs(sampCycleMs);
  s += ",\"hz\":";
  // Published samples per second. One is published per batch and a pass is
  // SAMPLE_ORDER turns long, so the measured pass time divides by its own length.
  // Null rather than zero until a full pass has been timed: the rate is not yet
  // known, which is a different statement from the rate being nothing.
  const uint8_t turns = sizeof(SAMPLE_ORDER) / sizeof(SAMPLE_ORDER[0]);
  if (sampCycleMs) s += String(turns * 1000.0f / sampCycleMs, 2);
  else             s += "null";
  s += ",\"bAge\":[";
  for (uint8_t i = 0; i < SAMPLE_BATCHES; i++) {
    if (i) s += ',';
    // A batch that has never answered is null, not an enormous age. "No reading yet"
    // and "a very old reading" are different things and the page shows them
    // differently - the same rule the values themselves follow.
    if (sampStamp[i]) s += (now - sampStamp[i]);
    else              s += "null";
  }
  s += "],\"share\":";
  s += scan.running ? "true" : "false";
  s += "}";
}

// How this run of the firmware started, and how long it has been going.
//
// Emitted on both paths, like jsonScan and jsonQuality: a board that cannot talk to
// the car is exactly when you most want to know whether it has just rebooted.
static void jsonBoot(String &s) {
  s += ",\"boot\":{\"reason\":\"";
  s += resetReasonName();
  s += "\",\"up\":";
  s += millis();
  s += ",\"wakes\":";
  s += g_bootWakes;
  s += "}";
}

static void handleData() {
  String s = "{";
  bool fresh = g_seq && (millis() - g_liveMs < 4000);

  if (!fresh) {
    s += "\"ok\":false,\"fw\":\"" FW_VERSION "\",\"tr\":\"";
    s += transportName();
    s += "\",\"error\":\"";
    s += scan.running ? "waiting - scanner has the bus"
                      : "no response from ECU (ignition off?)";
    s += "\"";
    jsonScan(s);
    jsonQuality(s);
    jsonBoot(s);
    s += "}";
    server.send(200, "application/json", s);
    return;
  }

  Live L = g_live;
  s += "\"ok\":true,\"fw\":\"" FW_VERSION "\",\"tr\":\"";
  s += transportName();
  s += "\",\"seq\":";
  s += g_seq;
  s += ",\"age\":";
  s += (millis() - g_liveMs);
  s += ",\"epoch\":";
  s += (long long)clockNowMs();
  jsonScan(s);
  jsonQuality(s);
  jsonBoot(s);
  s += ",\"v\":{";
  jsonNum(s, "rpm", L.rpm, 0);        jsonNum(s, "speed", L.speed, 0);
  jsonNum(s, "map", L.map_, 0);       jsonNum(s, "baro", L.baro, 0);
  jsonNum(s, "throttle", L.throttle, 1); jsonNum(s, "load", L.load, 1);
  jsonNum(s, "coolant", L.coolant, 0);jsonNum(s, "oil", L.oil, 0);
  jsonNum(s, "iat", L.iat, 0);        jsonNum(s, "ambient", L.ambient, 0);
  jsonNum(s, "volt", L.volt, 2);      jsonNum(s, "stft", L.stft, 1);
  jsonNum(s, "ltft", L.ltft, 1);      jsonNum(s, "lambda", L.lambda, 3);
  jsonNum(s, "cat", L.cat, 1);        jsonNum(s, "timing", L.timing, 1);
  jsonNum(s, "fuelRate", L.fuelRate, 2); jsonNum(s, "fuel", L.fuel, 1);
  jsonNum(s, "runtime", L.runtime, 0);
  jsonNum(s, "pedalD", L.pedalD, 1);  jsonNum(s, "pedalE", L.pedalE, 1);
  jsonNum(s, "cmdThrottle", L.cmdThrottle, 1);
  jsonNum(s, "torqDem", L.torqDem, 1);jsonNum(s, "torqAct", L.torqAct, 1);
  jsonNum(s, "torqRef", L.torqRef, 0);jsonNum(s, "absLoad", L.absLoad, 1);
  jsonNum(s, "tripKm", L.tripKm, 3);  jsonNum(s, "tripL",   L.tripL, 4);
  s.remove(s.length() - 1);           // trailing comma
  s += "}}";
  server.send(200, "application/json", s);
}

// The browser hands over the time on every page load, so the board can stamp what
// it records. Re-sent each load rather than once, because the internal oscillator
// drifts and correcting it costs nothing.
static void handleTime() {
  if (server.hasArg("ms")) clockSetFrom(strtoll(server.arg("ms").c_str(), nullptr, 10));
  String s = "{\"set\":";
  s += clockSet() ? "true" : "false";
  s += ",\"epoch\":";
  s += (long long)clockNowMs();
  s += "}";
  server.send(200, "application/json", s);
}

static void handleScanStart() {
  scan.running   = true;
  scan.ecu       = server.hasArg("ecu") ? (uint8_t)server.arg("ecu").toInt() : 0;
  scan.from      = server.hasArg("from") ? strtoul(server.arg("from").c_str(), nullptr, 16) : 0x0000;
  scan.to        = server.hasArg("to")   ? strtoul(server.arg("to").c_str(),   nullptr, 16) : 0xFFFF;
  scan.cur       = scan.from;
  scan.tried     = 0;
  scan.negatives = 0;
  scan.startedMs = millis();
  scan.stalled   = false;
  scanSilent     = 0;
  scanHitN = 0;
  if (tripFsUp) LittleFS.remove(SCAN_HITS_FILE);   // a new sweep starts a new record
  scanSaveState();
  server.send(200, "application/json", "{\"ok\":true}");
}

static void handleScanStop() {
  scan.running = false;
  scan.stalled = false;
  scanSaveState();
  server.send(200, "application/json", "{\"ok\":true}");
}

// Chunked, like /history and for the same reason: a completed sweep can hold
// thousands of hits, and building that into one String would need more contiguous
// heap than the board has to spare while also serving the page that asked for it.
static void handleScanStatus() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");

  char hex[8];
  snprintf(hex, sizeof(hex), "%04X", (unsigned)(scan.cur > 0xFFFF ? 0xFFFF : scan.cur));
  String head = "{\"running\":";
  head += scan.running ? "true" : "false";
  head += ",\"ecu\":\"";
  head += scan.ecu ? "TCM" : "ECM";
  head += "\",\"cur\":\"";
  head += hex;
  head += "\",\"tried\":";  head += scan.tried;
  head += ",\"total\":";     head += (scan.to - scan.from + 1);
  head += ",\"negatives\":"; head += scan.negatives;
  head += ",\"elapsed\":";   head += (millis() - scan.startedMs) / 1000;
  head += ",\"cap\":";       head += scanHitCap;
  head += ",\"stalled\":";   head += scan.stalled ? "true" : "false";
  head += ",\"resumed\":";   head += scan.tried > scanHitN ? "true" : "false";
  head += ",\"hits\":[";
  server.sendContent(head);

  String chunk;
  for (uint16_t i = 0; i < scanHitN; i++) {
    const Hit &h = scanHits[i];
    if (i) chunk += ",";
    snprintf(hex, sizeof(hex), "%04X", h.did);
    chunk += "{\"did\":\"";  chunk += hex;
    chunk += "\",\"ecu\":\""; chunk += (h.ecu ? "TCM" : "ECM");
    chunk += "\",\"len\":";   chunk += h.len;
    chunk += ",\"hex\":\"";
    for (uint8_t k = 0; k < h.len; k++) { char b[4]; snprintf(b, sizeof(b), "%02X", h.data[k]); chunk += b; }
    chunk += "\",\"ascii\":\"";
    for (uint8_t k = 0; k < h.len; k++) {
      char c = (char)h.data[k];
      if (c == '"' || c == '\\') chunk += '.';
      else chunk += (c >= 32 && c < 127) ? c : '.';
    }
    chunk += "\"}";
    if (chunk.length() > 1024) { server.sendContent(chunk); chunk = ""; }
  }
  chunk += "]}";
  server.sendContent(chunk);
  server.sendContent("");
}

// Stored + pending DTCs, both ECUs.
// The only handler that talks to the bus, which makes it the only one that can
// block the server for as long as an ECU is willing to stay silent. It runs inside
// handleClient(), so it cannot yield (see bus_yield.h) - hence the short timeouts.
// Two ECUs x request + retry used to add up to eight seconds of an unresponsive
// board, which is most of what made a tab switch feel like a page load.
static void handleDtc() {
  if (g_busBusy) {                 // reached from webYield(), mid-reassembly
    server.send(200, "application/json", "{\"busy\":true,\"ecus\":[]}");
    return;
  }
  String s = "{\"ecus\":[";
  const uint32_t req[2] = {ID_ECM_REQ, ID_TCM_REQ};
  const uint32_t rsp[2] = {ID_ECM_RSP, ID_TCM_RSP};
  for (int e = 0; e < 2; e++) {
    if (e) s += ",";
    s += "{\"name\":\"";
    s += (e ? "TCM" : "ECM");
    s += "\",\"codes\":[";
    uint8_t req03[1] = {0x03};
    uint8_t buf[64];
    int len = obdIsoTp(req[e], rsp[e], req03, 1, buf, sizeof(buf),
                       activeTransport == TR_BLE ? 900 : 300);
    // A half-read DTC list would report fewer codes than are actually stored, so a
    // truncated reply gets one retry rather than being parsed as far as it goes.
    // 900 + 1200 still clears ATST (400 ms) with room to spare, and caps the worst
    // case at ~4 s across both ECUs instead of ~8 s.
    if (len == -3) len = obdIsoTp(req[e], rsp[e], req03, 1, buf, sizeof(buf),
                                  activeTransport == TR_BLE ? 1200 : 500);
    bool first = true;
    if (len >= 2 && buf[0] == 0x43) {
      uint8_t count = buf[1];
      for (uint8_t i = 0; i < count && (size_t)(2 + i * 2 + 1) < (size_t)len; i++) {
        uint16_t raw = (buf[2 + i * 2] << 8) | buf[3 + i * 2];
        if (!raw) continue;
        const char sys[] = {'P', 'C', 'B', 'U'};
        char code[8];
        snprintf(code, sizeof(code), "%c%01X%03X", sys[(raw >> 14) & 3], (raw >> 12) & 3, raw & 0x0FFF);
        if (!first) s += ",";
        s += "\"";
        s += code;
        s += "\"";
        first = false;
      }
    }
    s += "]}";
  }
  s += "]}";
  server.send(200, "application/json", s);
}

static void handleMonitors() {
  monWantedMs = millis();          // arms monStep() for the next half minute
  String s = "{\"ready\":";
  s += monDiscovered ? "true" : "false";
  s += ",\"ids\":";
  s += monMidCount;
  s += ",\"recs\":[";
  for (uint8_t i = 0; i < monCount; i++) {
    const MonRec &m = monRec[i];
    if (i) s += ",";
    char hex[8];
    s += "{\"mid\":\"";  snprintf(hex, sizeof(hex), "%02X", m.mid); s += hex;
    s += "\",\"tid\":\""; snprintf(hex, sizeof(hex), "%02X", m.tid); s += hex;
    s += "\",\"uas\":\""; snprintf(hex, sizeof(hex), "%02X", m.uas); s += hex;
    s += "\",\"v\":";  s += m.value;
    s += ",\"lo\":";    s += m.lo;
    s += ",\"hi\":";    s += m.hi;
    s += "}";
  }
  s += "]}";
  server.send(200, "application/json", s);
}

static void handleTripList() {
  String s = "{\"fs\":";
  s += tripFsUp ? "true" : "false";
  s += ",\"used\":";  s += (uint32_t)(tripFsUp ? LittleFS.usedBytes() : 0);
  s += ",\"total\":"; s += (uint32_t)(tripFsUp ? LittleFS.totalBytes() : 0);
  s += ",\"live\":\"";
  s += tripName[0] ? tripName : "";
  s += "\",\"trips\":[";
  if (tripFsUp) {
    File dir = LittleFS.open("/");
    bool first = true;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      if (!tripIsLogNameLoose(f.name())) continue;   // not the sweep's hits, not the UI
      if (!first) s += ",";
      first = false;
      s += "{\"name\":\"";
      if (f.name()[0] != '/') s += "/";
      s += f.name();
      s += "\",\"size\":";
      s += (uint32_t)f.size();
      s += "}";
    }
    dir.close();
  }
  s += "]}";
  server.send(200, "application/json", s);
}

// Only files this firmware wrote are servable, and only from the root - the name
// comes from a query string, so it is checked rather than trusted.
static bool tripNameOk(const String &n) {
  if (n.length() < 6 || n.length() > 20) return false;
  if (n[0] != '/' || n.indexOf("..") >= 0 || n.lastIndexOf('/') != 0) return false;
  // Only actual trip logs. This is reached from a query string, so it decides both
  // what can be downloaded and what can be deleted - and /scanhits.csv used to
  // satisfy it, which made the sweep's results removable from the trips page.
  return tripIsLogName(n.c_str());
}

static void handleTripGet() {
  String n = server.arg("f");
  if (!tripNameOk(n) || !LittleFS.exists(n)) { server.send(404, "text/plain", "no such trip"); return; }
  File f = LittleFS.open(n, FILE_READ);
  if (!f) { server.send(500, "text/plain", "open failed"); return; }
  server.sendHeader("Content-Disposition", "attachment; filename=\"" + n.substring(1) + "\"");
  server.streamFile(f, "text/csv");
  f.close();
}

static void handleTripDelete() {
  String n = server.arg("f");
  if (!tripNameOk(n)) { server.send(400, "application/json", "{\"ok\":false}"); return; }
  if (tripName[0] && n == tripName) tripClose();     // never delete the open file
  bool ok = LittleFS.remove(n);
  server.send(200, "application/json", ok ? "{\"ok\":true}" : "{\"ok\":false}");
}

// Trend history, oldest first. Chunked because the full hour is ~14 KB of JSON and
// assembling that in one String risks the heap on a board this size.
static void handleHistory() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");

  char head[96];
  // endEpoch is the wall-clock time of the newest sample, so the client can put the
  // chart on a real axis. Zero when nobody has told the board what time it is.
  snprintf(head, sizeof(head), "{\"period\":%lu,\"n\":%u,\"endEpoch\":%lld,",
           (unsigned long)(HIST_PERIOD_MS / 1000), histCount,
           (long long)clockAtMs(histLastPush));
  server.sendContent(head);

  const char *names[4] = {"rpm", "speed", "boost", "coolant"};
  for (int series = 0; series < 4; series++) {
    String chunk = "\"";
    chunk += names[series];
    chunk += "\":[";
    for (uint16_t i = 0; i < histCount; i++) {
      const HistSlot &h = histBuf[histIndex(i)];
      int16_t raw = series == 0 ? h.rpm : series == 1 ? h.speed
                  : series == 2 ? h.boost : h.coolant;
      if (i) chunk += ",";
      if (raw == HIST_NONE) chunk += "null";
      else if (series == 2) chunk += String(raw / 100.0f, 2);   // centibar -> bar
      else chunk += raw;
      if (chunk.length() > 1024) { server.sendContent(chunk); chunk = ""; }
    }
    chunk += (series == 3) ? "]}" : "],";
    server.sendContent(chunk);
  }
  server.sendContent("");
}

// ---------------------------------------------------------------- OTA

// Browser-driven OTA. The ESP32 writes into the inactive OTA partition and only
// switches over once Update.end() verifies the image, so a failed or interrupted
// upload leaves the running firmware untouched.
static void handleOtaUpload() {
  HTTPUpload &up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    scan.running = false;                       // never flash mid-scan
    tripClose();                                // and land the log before rebooting
    Serial.printf("[ota] start: %s\n", up.filename.c_str());
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) Update.printError(Serial);
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (Update.write(up.buf, up.currentSize) != up.currentSize) Update.printError(Serial);
  } else if (up.status == UPLOAD_FILE_END) {
    if (Update.end(true)) Serial.printf("[ota] wrote %u bytes, rebooting\n", up.totalSize);
    else                  Update.printError(Serial);
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    Serial.println("[ota] aborted");
  }
}

static void handleOtaDone() {
  bool bad = Update.hasError();
  server.sendHeader("Connection", "close");
  server.send(200, "application/json", bad ? "{\"ok\":false}" : "{\"ok\":true}");
  if (!bad) { delay(600); ESP.restart(); }
}

// The watched identifiers and their latest readings, plus enough live values to
// correlate against without the page having to poll /data as well.
static void handleWatchList() {
  uint32_t now = millis();
  String s = "{\"max\":";
  s += WATCH_MAX;
  s += ",\"period\":";
  s += watchPeriodMs;
  s += ",\"cycle\":";
  s += watchCycleMs();
  s += ",\"scanning\":";
  s += scan.running ? "true" : "false";
  s += ",\"dids\":[";
  for (uint8_t i = 0; i < watchN; i++) {
    const WatchDid &w = watch[i];
    char nm[12];
    watchColName(nm, sizeof(nm), w, false);
    if (i) s += ",";
    s += "{\"name\":\"";  s += nm;
    s += "\",\"did\":\"";
    char hex[8];
    snprintf(hex, sizeof(hex), "%04X", (unsigned)w.did);
    s += hex;
    s += "\",\"ecu\":\""; s += (w.ecu ? "TCM" : "ECM");
    s += "\",\"len\":";   s += w.len;
    s += ",\"fresh\":";   s += watchFresh(w, now) ? "true" : "false";
    if (w.len) {
      s += ",\"val\":";  s += watchValue(w);
      s += ",\"hex\":\"";
      for (uint8_t k = 0; k < w.len; k++) {
        snprintf(hex, sizeof(hex), "%02X", w.data[k]);
        s += hex;
      }
      s += "\",\"age\":"; s += (now - w.stamp);
    }
    s += "}";
  }
  s += "],\"v\":{";
  Live L = g_live;
  bool fresh = g_seq && (millis() - g_liveMs < 4000);
  jsonNum(s, "rpm",     fresh ? L.rpm : NAN, 0);
  jsonNum(s, "speed",   fresh ? L.speed : NAN, 0);
  jsonNum(s, "coolant", fresh ? L.coolant : NAN, 0);
  jsonNum(s, "load",    fresh ? L.load : NAN, 1);
  jsonNum(s, "throttle", fresh ? L.throttle : NAN, 1);
  jsonNum(s, "iat",     fresh ? L.iat : NAN, 0);
  s.remove(s.length() - 1);            // trailing comma
  s += "}}";
  server.send(200, "application/json", s);
}

static void handleWatchSet() {
  WatchDid next[WATCH_MAX];
  uint8_t n = 0;
  if (server.hasArg("d")) n = watchParseList(server.arg("d").c_str(), next, WATCH_MAX);

  uint32_t p = watchPeriodMs;
  if (server.hasArg("period")) p = (uint32_t)strtoul(server.arg("period").c_str(), nullptr, 10);

  bool changed = watchApply(next, n, p);
  if (changed) {
    watchSave();
    Serial.printf("[watch] set to %u identifiers, every %lums\n",
                  watchN, (unsigned long)watchPeriodMs);
  }
  String s = "{\"ok\":true,\"n\":";
  s += watchN;
  s += ",\"period\":";
  s += watchPeriodMs;
  s += ",\"changed\":";
  s += changed ? "true" : "false";
  s += "}";
  server.send(200, "application/json", s);
}

// ---------------------------------------------------------------- static assets
//
// A page only changes when the firmware does, so a tab switch should be a
// revalidation - a 304 with no body - rather than a re-download of 10-27 KB. The
// stylesheet is the same ~7 KB on all five pages, so it is served once from its own
// version-stamped URL and marked immutable: after the first page of a given build
// the browser stops asking for it entirely.
#define UI_ETAG "\"" FW_VERSION "\""

static bool ifNoneMatch() {
  return server.header("If-None-Match") == UI_ETAG;
}

static void sendPage(const char *html) {
  server.sendHeader("ETag", UI_ETAG);
  server.sendHeader("Cache-Control", "no-cache");     // revalidate, do not blind-cache
  if (ifNoneMatch()) { server.send(304, "text/html", ""); return; }
  server.send_P(200, "text/html", html);
}

static void handleUiCss() {
  server.sendHeader("ETag", UI_ETAG);
  server.sendHeader("Cache-Control", "public, max-age=31536000, immutable");
  if (ifNoneMatch()) { server.send(304, "text/css", ""); return; }
  server.send_P(200, "text/css", UI_CSS_BODY);
}

// ---------------------------------------------------------------- frontend bundle
//
// Files built by an ordinary frontend toolchain and uploaded to /w, served here.
// See ui_paths.h for why this exists at all; the short version is that a UI
// compiled into flash costs a 1.3 MB reflash to change a line of CSS.

static File   uiUp;
static bool   uiUpOpen  = false;
static size_t uiUpWrote = 0;
static size_t uiUpBase  = 0;         // bundle size excluding the file being written
static const char *uiUpErr = nullptr;

// Gzipped copy first: the build emits both, and over this link the compressed one
// is always the right answer.
static bool uiTrySend(const char *path) {
  char fp[80];
  for (int gz = 1; gz >= 0; gz--) {
    if (!uiFsPath(fp, sizeof(fp), path, gz)) return false;
    if (!LittleFS.exists(fp)) continue;
    File f = LittleFS.open(fp, FILE_READ);
    if (!f) continue;
    // Do NOT set Content-Encoding here. streamFile() -> _streamFileCore() already
    // adds it for a name ending in .gz, and WebServer::sendHeader appends without
    // deduplicating - so setting it too sends the header twice, the browser reads
    // "gzip, gzip", decompresses once, fails on the second pass and renders the
    // compressed bytes as text. That is what shipped in 1.11.0.
    // Asset names carry a content hash, so they can be cached forever. index.html
    // names the others, so it must not be - a deploy would never be picked up.
    server.sendHeader("Cache-Control", uiImmutable(path)
                      ? "public, max-age=31536000, immutable" : "no-cache");
    server.streamFile(f, uiContentType(path));
    f.close();
    return true;
  }
  return false;
}

static void handleUiManifest() {
  size_t total = LittleFS.totalBytes(), used = LittleFS.usedBytes();
  String s = "{\"installed\":";
  s += uiInstalled() ? "true" : "false";
  s += ",\"bytes\":";  s += (uint32_t)uiBytesUsed();
  s += ",\"max\":";    s += (uint32_t)UI_MAX_BYTES;
  s += ",\"free\":";   s += (uint32_t)(total > used ? total - used : 0);
  s += ",\"files\":[";
  File dir = LittleFS.open(UI_DIR);
  if (dir && dir.isDirectory()) {
    bool first = true;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      if (f.isDirectory()) continue;
      if (!first) s += ",";
      first = false;
      s += "{\"name\":\"";
      s += f.name();
      s += "\",\"size\":";
      s += (uint32_t)f.size();
      s += "}";
    }
    dir.close();
  }
  s += "]}";
  server.send(200, "application/json", s);
}

static void handleUiClear() {
  uiClear();
  server.send(200, "application/json", "{\"ok\":true}");
}

// Multipart streaming, one file per request - same shape as the OTA upload. The
// target name is the multipart filename, checked rather than trusted.
static void handleUiUpload() {
  HTTPUpload &up = server.upload();

  if (up.status == UPLOAD_FILE_START) {
    uiUpOpen = false; uiUpWrote = 0; uiUpErr = nullptr;

    // Not the name the client sent: see uiStoreName. A phone that renamed the
    // download to index-1.11.1.html.gz would otherwise install a bundle the
    // firmware cannot find, and report "no frontend installed" over the top of it.
    char stored[64];
    if (!uiStoreName(up.filename.c_str(), stored, sizeof(stored))) {
      uiUpErr = "bad filename";
      Serial.printf("[ui] rejected upload name %s\n", up.filename.c_str());
      return;
    }

    char fp[80];
    if (!uiFsPath(fp, sizeof(fp), stored, false)) {
      uiUpErr = "bad filename";
      return;
    }
    if (strcmp(stored, up.filename.c_str()) != 0)
      Serial.printf("[ui] %s stored as %s\n", up.filename.c_str(), stored);
    LittleFS.mkdir(UI_DIR);

    // Budget check up front. Replacing an existing file does not count its old
    // size against the budget, or re-uploading the same bundle would fail once it
    // was more than half the cap.
    size_t existing = 0;
    if (LittleFS.exists(fp)) { File o = LittleFS.open(fp, FILE_READ); if (o) { existing = o.size(); o.close(); } }
    size_t usedNow = uiBytesUsed();
    uiUpBase = usedNow > existing ? usedNow - existing : 0;

    uiUp = LittleFS.open(fp, FILE_WRITE);
    uiUpOpen = (bool)uiUp;
    if (!uiUpOpen) { uiUpErr = "could not open file"; return; }
    Serial.printf("[ui] receiving %s\n", fp);
    return;
  }

  if (up.status == UPLOAD_FILE_WRITE && uiUpOpen) {
    // The filesystem is shared with trip logs. Refuse rather than let a bundle
    // squeeze out the recording space, and refuse before the write, not after.
    if (uiUpBase + uiUpWrote + up.currentSize > UI_MAX_BYTES) {
      uiUpErr = "bundle over budget";
    } else if (LittleFS.totalBytes() - LittleFS.usedBytes() < TRIP_FREE_MIN) {
      uiUpErr = "filesystem full";
    }
    if (uiUpErr) { uiUp.close(); uiUpOpen = false; return; }

    if (uiUp.write(up.buf, up.currentSize) != up.currentSize) {
      uiUpErr = "write failed";
      uiUp.close();
      uiUpOpen = false;
      return;
    }
    uiUpWrote += up.currentSize;
    return;
  }

  if (up.status == UPLOAD_FILE_END && uiUpOpen) {
    uiUp.close();
    uiUpOpen = false;
    Serial.printf("[ui] wrote %u bytes\n", (unsigned)uiUpWrote);
    return;
  }

  if (up.status == UPLOAD_FILE_ABORTED) {
    if (uiUpOpen) uiUp.close();
    uiUpOpen = false;
    uiUpErr = "aborted";
  }
}

static void handleUiUploadDone() {
  String s = "{\"ok\":";
  s += uiUpErr ? "false" : "true";
  if (uiUpErr) { s += ",\"error\":\""; s += uiUpErr; s += "\""; }
  s += ",\"bytes\":";
  s += (uint32_t)uiUpWrote;
  s += "}";
  server.send(200, "application/json", s);
}

// Anything not matched by a registered route. An API path that got here is a
// genuine 404 and must say so in JSON - falling through to the bundle would hand
// back an HTML document with status 200 for a request that expected JSON. Anything
// else is either a bundle asset or a client-side route.
static void handleNotFound() {
  String uri = server.uri();
  if (uiIsApiPath(uri.c_str())) {
    server.send(404, "application/json", "{\"ok\":false,\"error\":\"no such endpoint\"}");
    return;
  }
  if (uiTrySend(uri.c_str())) return;
  if (uiInstalled() && uiTrySend("/index.html")) return;
  server.send(404, "text/plain", "not found");
}

// ---------------------------------------------------------------- transport pick

static const char *transportName() {
  switch (activeTransport) {
    case TR_CAN: return "can";
    case TR_BLE: return "ble";
    default:     return "none";
  }
}

// Cheap liveness probe: mode 01 PID 00 is mandatory on every OBD-II ECU.
static bool ecuProbe() {
  uint8_t req[2] = {0x01, 0x00};
  uint8_t buf[16];
  return obdIsoTp(ID_ECM_REQ, ID_ECM_RSP, req, 2, buf, sizeof(buf),
                  activeTransport == TR_BLE ? 1200 : 400) > 0;
}

// Prefer the wired CAN transceiver when it is present and the bus answers;
// otherwise fall back to the BLE ELM327 already sitting in the OBD port.
static void chooseTransport() {
  if (canUp) {
    activeTransport = TR_CAN;
    if (ecuProbe()) { Serial.println("[obd] transport = CAN (transceiver)"); return; }
  }
  activeTransport = TR_BLE;
  bleCurHeader = 0;
  if (elmConnect()) {
    if (ecuProbe()) { Serial.println("[obd] transport = BLE ELM327"); return; }
    Serial.println("[obd] BLE ELM327 connected but ECU silent (ignition off?)");
    return;
  }
  Serial.println("[obd] no transport available");
  activeTransport = canUp ? TR_CAN : TR_NONE;
}

// ---------------------------------------------------------------- setup / loop

void setup() {
  Serial.begin(115200);
  Serial.println("[fw] Obdurate " FW_VERSION);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);        // solid on through boot, so power is visible
  delay(300);

  canUp = canBegin();
  Serial.println(canUp ? "[can] TWAI up @500k" : "[can] TWAI init FAILED");

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("[ap] ");
  Serial.print(AP_SSID);
  Serial.print(" -> http://");
  Serial.println(WiFi.softAPIP());

  // ETag revalidation needs the request header kept; WebServer discards everything
  // it was not told to collect.
  static const char *collect[] = {"If-None-Match"};
  server.collectHeaders(collect, 1);

  // The bundle when one is installed, the fallback when not. That fallback is the
  // safety property: an interrupted deploy, a corrupt filesystem or a first flash
  // all leave the board showing a reading and a way forward, not nothing.
  server.on("/",            []() {
    if (uiInstalled() && uiTrySend("/index.html")) return;
    sendPage(BOOT_HTML);
  });
  server.on("/ui.css",      handleUiCss);
  server.on("/update", HTTP_GET, []() { sendPage(OTA_HTML); });
  server.on("/update", HTTP_POST, handleOtaDone, handleOtaUpload);
  server.on("/data",        handleData);
  server.on("/dtc",         handleDtc);
  server.on("/history",     handleHistory);
  server.on("/mon",         handleMonitors);
  server.on("/time",        handleTime);
  server.on("/trips/list",  handleTripList);
  server.on("/trips/get",   handleTripGet);
  server.on("/trips/del",   handleTripDelete);
  server.on("/watch/list",  handleWatchList);
  server.on("/watch/set",   handleWatchSet);
  // The pages these served now live in the bundle, behind hash routes. Redirect
  // rather than 404: these are bookmarks, and the nav on the two pages still built
  // into flash points at them.
  for (const char *p : {"/monitors", "/trips", "/watch", "/scan"})
    server.on(p, [p]() {
      String to = uiInstalled() ? String("/#") + p : String("/");
      server.sendHeader("Location", to);
      server.send(302, "text/plain", "");
    });

  server.on("/ui",          []() { sendPage(UI_ADMIN_HTML); });
  server.on("/ui/manifest", handleUiManifest);
  server.on("/ui/clear",    handleUiClear);
  server.on("/ui/upload", HTTP_POST, handleUiUploadDone, handleUiUpload);
  server.onNotFound(handleNotFound);
  server.on("/scan/start",  handleScanStart);
  server.on("/scan/stop",   handleScanStop);
  server.on("/scan/status", handleScanStatus);
  server.begin();

  // RTC memory holds garbage on a cold boot, so the wake counter only means
  // anything when this start was itself a wake - which esp_reset_reason() can say
  // for certain, so this needs no magic word of its own.
  if (esp_reset_reason() != ESP_RST_DEEPSLEEP) g_bootWakes = 0;
  Serial.printf("[boot] reset=%s wakes=%lu\n",
                resetReasonName(), (unsigned long)g_bootWakes);

  scanHitsBegin();
  watchLoad();          // before tripBegin: the watch set decides the CSV columns
  tripIntBegin();       // before tripBegin: the totals are columns on the first row
  tripBegin();
  scanBegin();          // resumes an interrupted sweep, needs the filesystem up
  histBegin();
  lastEcuOkMs = millis();
  chooseTransport();
}

// Everything that has to happen before the power goes, in one place because there
// is now more than one reason to go and the expensive mistake is a path that forgets
// one of them. tripClose() in particular: the file is buffered, and a sleep that
// skips it drops up to TRIP_FLUSH_MS of the drive that was just recorded.
static void powerDown(const char *why) {
  Serial.printf("[pwr] %s - deep sleep after %lus, %lu wakes\n",
                why, (unsigned long)(millis() / 1000UL), (unsigned long)g_bootWakes);
  histSave();
  tripClose();
  g_bootWakes++;          // RTC memory, so it counts across the sleep it is entering
  twai_stop();
  twai_driver_uninstall();
  esp_sleep_enable_timer_wakeup(SLEEP_WAKE_US);
  esp_deep_sleep_start();
}

// Requests served per turn. A page load is the document, /time, and the page's
// first poll; taking one per turn put a full bus exchange between each of them and
// made a tab switch feel like a page load. Four covers a load in a single turn,
// and costs nothing when idle - each spare call is one non-blocking accept.
static const int HTTP_DRAIN = 4;

void loop() {
  for (int i = 0; i < HTTP_DRAIN; i++) serveHttp();
  samplerStep();          // the bus waits inside here serve HTTP too - bus_yield.h
  watchStep();            // one watched identifier per period, paused during a scan
  monStep();              // only does anything while the monitors page is open
  heartbeat(millis() - lastEcuOkMs < 3000, scan.running);

  if (scan.running) {
    if (!scan.stalled) lastEcuOkMs = millis();   // a stalled scan is not activity
    scanStep(250);                // then hand the web server a turn
    static uint32_t scanCkpt = 0;
    if (millis() - scanCkpt > 5000) { scanCkpt = millis(); scanSaveState(); }
  }

  // Periodic status line. setup() output is lost because the USB CDC
  // re-enumerates at boot, so a running board must announce itself repeatedly
  // or there is no way to tell it apart from one stuck in the ROM loader.
  static uint32_t lastLog = 0;
  if (millis() - lastLog > 3000) {
    lastLog = millis();
    Serial.printf("[alive] up=%lus tr=%s can=%s ble=%s ap=%s clients=%u ecu=%s scan=%s "
                  "batch=%lums cycle=%lums stale=%lums\n",
                  millis() / 1000UL,
                  transportName(),
                  canUp ? "ok" : "FAIL",
                  elmConnected ? "up" : "down",
                  WiFi.softAPIP().toString().c_str(),
                  WiFi.softAPgetStationNum(),
                  (millis() - lastEcuOkMs < 3000) ? "ok" : "silent",
                  scan.running ? "running" : "idle",
                  (unsigned long)sampBatchMs,
                  (unsigned long)sampCycleMs,
                  (unsigned long)sampleStaleMs(sampCycleMs));
  }

  // Re-pick the transport while nothing is answering: covers the ELM327 dropping
  // its BLE link, a stale link held over from before the board lost power, or a
  // transceiver being wired in later.
  static uint32_t lastPick = 0;
  if (!scan.running && millis() - lastEcuOkMs > 3000 && millis() - lastPick > pickWaitMs) {
    lastPick = millis();
    Serial.printf("[obd] no data for %lums - re-picking transport (next in %lums)\n",
                  (unsigned long)(millis() - lastEcuOkMs), (unsigned long)pickWaitMs);
    chooseTransport();
    pickWaitMs = pickBackoff(pickWaitMs);
  }

  // Battery guard: nothing from the car for a while means the ignition is off.
  // Only arms once the ECU has actually answered at least once, otherwise a
  // bench board with no transceiver wired would sleep mid-test and look dead.
  if (everSawEcu && millis() - lastEcuOkMs > IDLE_SLEEP_MS) powerDown("idle");

  // The battery floor, under the idle timer rather than beside it. Only ever on a
  // fresh sample: g_live keeps its last values once the ECU stops answering, and a
  // voltage from ten minutes ago must not put the board to sleep now - that case is
  // the idle timer's, and it is already running.
  bool freshSample = g_seq && (millis() - g_liveMs < 4000);
  g_battLow = battLowStep(g_battLow,
                          freshSample ? g_live.volt : NAN,
                          freshSample ? g_live.rpm : NAN,
                          millis());
  if (g_battLow && millis() - g_battLow >= BATT_SLEEP_HOLD_MS) {
    char why[48];
    snprintf(why, sizeof(why), "battery %.2f V, engine stopped", (double)g_live.volt);
    powerDown(why);
  }
}

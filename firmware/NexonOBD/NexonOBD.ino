// NexonOBD - XIAO ESP32S3 + SN65HVD230 CAN transceiver, plugged into the OBD-II port.
//
// Two modes, one binary:
//   1. Live dashboard  - hosts a Wi-Fi AP and serves gauges at http://192.168.4.1/
//   2. UDS DID scanner - brute-forces service 0x22 across the identifier space
//
// Talks raw ISO 15765-4 (CAN 11-bit / 500 kbit) with a real ISO-TP layer, so it
// replaces the ELM327 rather than depending on it. Bluetooth is not used at all:
// the XIAO ESP32S3 is BLE-only and cannot speak the Classic SPP an ELM327 needs.
//
// SAFETY: this firmware only ever transmits diagnostic requests (mode 01/03/09 and
// UDS service 0x22 reads) plus ISO-TP flow-control frames. It never sends
// arbitrary frames, never writes (0x2E), never runs routines (0x31), never resets
// an ECU (0x11) and never changes diagnostic session (0x10).

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <vector>
#include "driver/twai.h"
#include "obd_types.h"
#include "elm_ble.h"
#include "version.h"
#include "history.h"
#include <Update.h>
#include "dashboard_html.h"
#include "scan_html.h"
#include "mon_html.h"
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

static const char *AP_SSID = "NexonOBD";
static const char *AP_PASS = "nexon1234";          // >= 8 chars, change if you like

static const uint32_t ID_ECM_REQ = 0x7E0;          // engine ECU request
static const uint32_t ID_ECM_RSP = 0x7E8;          // engine ECU response
static const uint32_t ID_TCM_REQ = 0x7E1;          // transmission
static const uint32_t ID_TCM_RSP = 0x7E9;

// Deep-sleep after this long with no ECU response, so the car battery survives
// the thing being left plugged in. OBD pin 16 is permanently live.
static const uint32_t IDLE_SLEEP_MS = 10UL * 60UL * 1000UL;
static const uint64_t SLEEP_WAKE_US = 30ULL * 1000000ULL;   // re-check every 30 s

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
  uint8_t frame[8] = {0};
  frame[0] = plen;                                  // single-frame PCI
  memcpy(&frame[1], payload, plen);
  canFlush();
  if (!canSend(reqId, frame, plen + 1)) return -1;

  size_t got = 0, total = 0;
  bool multi = false;
  uint8_t nextSeq = 1;
  uint32_t deadline = millis() + timeoutMs;

  while ((int32_t)(deadline - millis()) > 0) {
    twai_message_t m;
    if (twai_receive(&m, pdMS_TO_TICKS(5)) != ESP_OK) continue;
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
  if (activeTransport == TR_BLE)
    return bleIsoTp(reqId, rspId, payload, plen, out, outCap, timeoutMs, partial);
  return canIsoTp(reqId, rspId, payload, plen, out, outCap, timeoutMs, partial);
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
  uint8_t  ecu = 0;
  uint32_t cur = 0, from = 0, to = 0xFFFF;
  uint32_t tried = 0, negatives = 0;
  uint32_t startedMs = 0;
  std::vector<Hit> hits;
} scan;

// Time-boxed rather than counted. A fixed count of identifiers is a wildly
// different amount of wall-clock per transport - 40 DIDs is about a second on CAN
// but roughly 22 s over BLE, during which nothing answers the web server and the
// board looks hung. A millisecond budget behaves the same on both.
static void scanStep(uint32_t budgetMs) {
  uint32_t reqId = scan.ecu ? ID_TCM_REQ : ID_ECM_REQ;
  uint32_t rspId = scan.ecu ? ID_TCM_RSP : ID_ECM_RSP;
  uint32_t started = millis();

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

    if (len == -2) { scan.negatives++; continue; }
    if (len < 3) continue;
    if (buf[0] != 0x62) continue;
    if (((buf[1] << 8) | buf[2]) != did) continue;

    Hit h;
    h.did = did;
    h.ecu = scan.ecu;
    h.len = (uint8_t)min((size_t)(len - 3), sizeof(h.data));
    memcpy(h.data, &buf[3], h.len);
    if (scan.hits.size() < 3000) scan.hits.push_back(h);
  }
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

  if (any) {
    g_live   = pub;
    g_liveMs = millis();
    g_seq++;
    lastEcuOkMs = millis();
    everSawEcu  = true;
    histTick(g_live);
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
  jsonScan(s);
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
  s.remove(s.length() - 1);           // trailing comma
  s += "}}";
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
  scan.hits.clear();
  server.send(200, "application/json", "{\"ok\":true}");
}

static void handleScanStop() {
  scan.running = false;
  server.send(200, "application/json", "{\"ok\":true}");
}

static void handleScanStatus() {
  String s = "{\"running\":";
  s += scan.running ? "true" : "false";
  s += ",\"ecu\":\"";
  s += scan.ecu ? "TCM" : "ECM";
  s += "\",\"cur\":\"";
  char hex[8];
  snprintf(hex, sizeof(hex), "%04X", (unsigned)(scan.cur > 0xFFFF ? 0xFFFF : scan.cur));
  s += hex;
  s += "\",\"tried\":";  s += scan.tried;
  s += ",\"total\":";    s += (scan.to - scan.from + 1);
  s += ",\"negatives\":";s += scan.negatives;
  s += ",\"elapsed\":";  s += (millis() - scan.startedMs) / 1000;
  s += ",\"hits\":[";
  for (size_t i = 0; i < scan.hits.size(); i++) {
    const Hit &h = scan.hits[i];
    if (i) s += ",";
    snprintf(hex, sizeof(hex), "%04X", h.did);
    s += "{\"did\":\"";  s += hex;
    s += "\",\"ecu\":\""; s += (h.ecu ? "TCM" : "ECM");
    s += "\",\"len\":";   s += h.len;
    s += ",\"hex\":\"";
    for (uint8_t k = 0; k < h.len; k++) { char b[4]; snprintf(b, sizeof(b), "%02X", h.data[k]); s += b; }
    s += "\",\"ascii\":\"";
    for (uint8_t k = 0; k < h.len; k++) {
      char c = (char)h.data[k];
      if (c == '"' || c == '\\') s += '.';
      else s += (c >= 32 && c < 127) ? c : '.';
    }
    s += "\"}";
  }
  s += "]}";
  server.send(200, "application/json", s);
}

// Stored + pending DTCs, both ECUs.
static void handleDtc() {
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
                       activeTransport == TR_BLE ? 1500 : 300);
    // A half-read DTC list would report fewer codes than are actually stored, so a
    // truncated reply gets one retry rather than being parsed as far as it goes.
    if (len == -3) len = obdIsoTp(req[e], rsp[e], req03, 1, buf, sizeof(buf),
                                  activeTransport == TR_BLE ? 2500 : 600);
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

// Trend history, oldest first. Chunked because the full hour is ~14 KB of JSON and
// assembling that in one String risks the heap on a board this size.
static void handleHistory() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");

  char head[96];
  snprintf(head, sizeof(head), "{\"period\":%lu,\"n\":%u,",
           (unsigned long)(HIST_PERIOD_MS / 1000), histCount);
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
  Serial.println("[fw] NexonOBD " FW_VERSION);
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

  server.on("/",            []() { server.send_P(200, "text/html", DASHBOARD_HTML); });
  server.on("/scan",        []() { server.send_P(200, "text/html", SCAN_HTML); });
  server.on("/update", HTTP_GET, []() { server.send_P(200, "text/html", OTA_HTML); });
  server.on("/update", HTTP_POST, handleOtaDone, handleOtaUpload);
  server.on("/data",        handleData);
  server.on("/dtc",         handleDtc);
  server.on("/history",     handleHistory);
  server.on("/mon",         handleMonitors);
  server.on("/monitors",    []() { server.send_P(200, "text/html", MON_HTML); });
  server.on("/scan/start",  handleScanStart);
  server.on("/scan/stop",   handleScanStop);
  server.on("/scan/status", handleScanStatus);
  server.begin();

  histBegin();
  lastEcuOkMs = millis();
  chooseTransport();
}

void loop() {
  server.handleClient();
  samplerStep();          // one batch per turn, so the server keeps its responsiveness
  monStep();              // only does anything while the monitors page is open
  heartbeat(millis() - lastEcuOkMs < 3000, scan.running);

  if (scan.running) {
    scanStep(250);                // then hand the web server a turn
    lastEcuOkMs = millis();       // scanning counts as activity
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
  if (everSawEcu && millis() - lastEcuOkMs > IDLE_SLEEP_MS) {
    Serial.println("[pwr] idle - deep sleep");
    histSave();
    twai_stop();
    twai_driver_uninstall();
    esp_sleep_enable_timer_wakeup(SLEEP_WAKE_US);
    esp_deep_sleep_start();
  }
}

// Fake CAN bus and fake ELM327, so the extracted transport code can be driven
// through frame sequences that are impossible to stage against a real car:
// dropped consecutive frames, reordered sequence numbers, replies that stop
// halfway. Those are exactly the cases that used to surface as blank gauges.
#pragma once

#include "Arduino.h"

uint32_t g_millis = 0;

// ---------------------------------------------------------------- TWAI
#define ESP_OK 0
#define ESP_FAIL -1
#define pdMS_TO_TICKS(x) (x)

struct twai_message_t {
  uint32_t identifier = 0;
  uint8_t  data_length_code = 8;
  uint8_t  data[8] = {0};
};

// Frames the test has queued for the driver to hand back.
std::deque<twai_message_t> g_rx;
// Frames the code under test transmitted - lets a test assert the flow-control
// frame really was sent before consecutive frames were accepted.
std::vector<twai_message_t> g_tx;

inline int twai_receive(twai_message_t *m, uint32_t ticks) {
  if (!g_rx.empty()) {
    *m = g_rx.front();
    g_rx.pop_front();
    g_millis += 1;
    return ESP_OK;
  }
  g_millis += ticks ? ticks : 1;   // nothing waiting: let the deadline advance
  return ESP_FAIL;
}

inline bool canSend(uint32_t id, const uint8_t *d, uint8_t len) {
  twai_message_t m;
  m.identifier = id;
  for (int i = 0; i < 8; i++) m.data[i] = (i < len) ? d[i] : 0x55;
  g_tx.push_back(m);
  return true;
}
inline void canFlush() { }

// ---------------------------------------------------------------- ELM327
bool          elmConnected = true;
uint32_t      bleCurHeader = 0;
std::deque<String> g_elmReplies;      // canned responses, oldest first
std::vector<String> g_elmSent;        // commands the code under test issued

inline String elmCommand(const String &cmd, uint32_t timeoutMs = 1500) {
  (void)timeoutMs;
  g_elmSent.push_back(cmd);
  g_millis += 5;
  if (cmd.startsWith("AT")) return String("OK\r>");   // setup chatter
  if (g_elmReplies.empty()) return String();
  String r = g_elmReplies.front();
  g_elmReplies.pop_front();
  return r;
}

// ---------------------------------------------------------------- sketch globals
enum Transport { TR_NONE, TR_CAN, TR_BLE };
Transport activeTransport = TR_CAN;

static const uint32_t ID_ECM_REQ = 0x7E0;
static const uint32_t ID_ECM_RSP = 0x7E8;
static const uint32_t ID_TCM_REQ = 0x7E1;
static const uint32_t ID_TCM_RSP = 0x7E9;

float g_baro = NAN;

#include "../NexonOBD/obd_types.h"

inline void resetBus() {
  g_rx.clear();
  g_tx.clear();
  g_elmReplies.clear();
  g_elmSent.clear();
  g_millis = 1000;
  activeTransport = TR_CAN;
  g_baro = NAN;
}

// Queue one CAN frame for the driver to return.
inline void rx(uint32_t id, std::vector<uint8_t> bytes) {
  twai_message_t m;
  m.identifier = id;
  for (size_t i = 0; i < 8; i++) m.data[i] = i < bytes.size() ? bytes[i] : 0x55;
  g_rx.push_back(m);
}

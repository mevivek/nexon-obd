#pragma once
#include <Arduino.h>
#include <BLEDevice.h>
#include "bus_yield.h"

// BLE transport to a dual-mode ELM327 clone.
//
// The adapter exposes Bluetooth Classic SPP *and* a BLE GATT interface on a
// separate address (Classic MAC with the top bit of octet 0 set - 01:.. -> 81:..).
// Verified on this unit: name "OBDBLE", service FFF0 with FFF1 (notify, responses)
// and FFF2 (write, commands). That matters because the ESP32-S3 has no Bluetooth
// Classic radio at all, so BLE is the only way it can reach this adapter.

static const char *ELM_BLE_ADDR = "81:23:45:67:89:ba";   // BLE address, not the Classic one
static BLEUUID ELM_SVC((uint16_t)0xFFF0);
static BLEUUID ELM_RX ((uint16_t)0xFFF1);                // notify -> us
static BLEUUID ELM_TX ((uint16_t)0xFFF2);                // write  -> adapter

static BLEClient             *elmClient = nullptr;
static BLERemoteCharacteristic *elmTxChar = nullptr;
static BLERemoteCharacteristic *elmRxChar = nullptr;

static volatile bool elmConnected = false;
static String        elmBuf;                              // filled from the notify callback

static void elmNotifyCb(BLERemoteCharacteristic *c, uint8_t *data, size_t len, bool isNotify) {
  for (size_t i = 0; i < len; i++) elmBuf += (char)data[i];
  if (elmBuf.length() > 2048) elmBuf.remove(0, elmBuf.length() - 2048);
}

class ElmClientCb : public BLEClientCallbacks {
  void onConnect(BLEClient *) override { elmConnected = true; }
  void onDisconnect(BLEClient *) override { elmConnected = false; }
};

// Send one command, collect until the ELM prompt '>' or timeout.
static String elmCommand(const String &cmd, uint32_t timeoutMs = 1500) {
  if (!elmConnected || !elmTxChar) return "";
  elmBuf = "";
  String out = cmd + "\r";
  elmTxChar->writeValue((uint8_t *)out.c_str(), out.length(), false);   // write without response

  // The adapter takes up to ATST (400 ms) to answer and the buffer fills from a
  // notify callback, so this wait is pure dead time - spend it serving the web
  // server instead. busWaitYield extends the deadline by whatever that costs, so a
  // page load cannot turn into a phantom ELM timeout. See bus_yield.h.
  uint32_t deadline = millis() + timeoutMs;
  uint32_t extended = 0;
  while ((int32_t)(deadline - millis()) > 0) {
    if (elmBuf.indexOf('>') >= 0) break;
    delay(1);
    busWaitYield(deadline, extended);
  }
  String r = elmBuf;
  r.replace(">", "");
  return r;
}

static bool elmConnect() {
  if (elmConnected) return true;

  if (!elmClient) {
    BLEDevice::init("");
    // A batched mode-01 reply is ~80 characters, which at the 23-byte default MTU is
    // four or five notifications, each waiting for its own connection event. A
    // larger MTU collapses that into one or two.
    BLEDevice::setMTU(247);
    elmClient = BLEDevice::createClient();
    elmClient->setClientCallbacks(new ElmClientCb());
  }
  BLEAddress addr(ELM_BLE_ADDR, BLE_ADDR_PUBLIC);
  if (!elmClient->connect(addr)) return false;

  // The connection interval is the floor on every round trip: at a default of
  // 40-50 ms a request and its reply cannot beat about a tenth of a second no matter
  // how quickly the ECU answers, and a sample is several of those. Ask for
  // 7.5-15 ms. The adapter is free to refuse, in which case nothing is worse than
  // it was. Units are 1.25 ms for the intervals and 10 ms for the supervision
  // timeout.
  elmClient->updateConnParams(6, 12, 0, 400);
  elmClient->setMTU(247);

  BLERemoteService *svc = elmClient->getService(ELM_SVC);
  if (!svc) { elmClient->disconnect(); return false; }
  elmTxChar = svc->getCharacteristic(ELM_TX);
  elmRxChar = svc->getCharacteristic(ELM_RX);
  if (!elmTxChar || !elmRxChar) { elmClient->disconnect(); return false; }

  if (elmRxChar->canNotify()) elmRxChar->registerForNotify(elmNotifyCb);
  elmConnected = true;

  // Same init the laptop needed: ATSP0 auto-detect fails on this car, so the
  // protocol is pinned, and headers stay ON because ATCRA filtering is broken
  // on this clone - ECU replies get demultiplexed by header in software.
  // ATST is the adapter's own patience, and it has to be shorter than ours or the
  // firmware gives up while the ELM is still waiting on the ECU - we then read a
  // buffer with no '>' prompt, i.e. a truncated reply, and lose the whole batch.
  // ATST FF is 255 x 4 ms = 1020 ms, which was longer than the 900 ms read window.
  // 0x64 x 4 ms = 400 ms leaves clear headroom, so the adapter always answers -
  // even if the answer is NO DATA - before the read times out.
  const char *init[] = {"ATZ", "ATE0", "ATL0", "ATS0", "ATH1", "ATSP6", "ATAT2", "ATST 64"};
  for (size_t i = 0; i < sizeof(init) / sizeof(init[0]); i++) {
    elmCommand(init[i], i == 0 ? 3000 : 1200);
    delay(30);
  }
  return true;
}

static void elmDisconnect() {
  if (elmClient && elmConnected) elmClient->disconnect();
  elmConnected = false;
}

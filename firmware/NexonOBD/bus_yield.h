#pragma once
#include <Arduino.h>

// Keeping the web server responsive while the board is waiting on the car.
//
// Every ISO-TP exchange is dead time: on BLE the transport sits in delay(1) for up
// to 1.2 s waiting for the ELM327's prompt, and on CAN it spins on a 5 ms receive.
// The web server used to get its turn only between exchanges, so a tab switch -
// which is three requests, the document plus /time plus the page's first poll -
// could wait several seconds. That is what made switching pages look like a page
// load rather than a page swap.
//
// So the wait loops serve HTTP instead of sleeping. Time spent doing that was taken
// from the wait, not from the car: the reply is still queued behind us either way
// (the TWAI driver's RX queue, or the ELM notify buffer that fills from a callback),
// so the response deadline moves out by however long the yield took. Without that,
// serving a page would consume the ECU's patience window and show up as a phantom
// timeout - exactly the failure the batch retry logic exists to paper over.

// Defined in the sketch, which owns the WebServer. Serves whatever is queued and
// returns the milliseconds that took. Returns 0 when it is not safe to serve
// anything - notably when the caller is already inside a request handler, because
// WebServer tracks a single current client and cannot be re-entered.
uint32_t webYield();

// The extension is bounded so that one slow handler - a trip download, an OTA
// upload - cannot hold a bus exchange open for as long as it likes.
static const uint32_t YIELD_EXTEND_MAX_MS = 3000;

inline void busWaitYield(uint32_t &deadline, uint32_t &extended) {
  uint32_t took = webYield();
  if (!took || extended >= YIELD_EXTEND_MAX_MS) return;
  uint32_t add = (took < YIELD_EXTEND_MAX_MS - extended) ? took
                                                         : YIELD_EXTEND_MAX_MS - extended;
  extended += add;
  deadline += add;
}

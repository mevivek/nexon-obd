#pragma once
#include <Arduino.h>

// These live in a header rather than the .ino on purpose: the Arduino build
// auto-generates function prototypes and injects them above the sketch body, so
// any type used in a signature must already be visible from an #include.

// One decoded sample of mode-01 live data. NAN means "ECU did not report it".
struct Live {
  float rpm = NAN, speed = NAN, map_ = NAN, baro = NAN, throttle = NAN, load = NAN;
  float coolant = NAN, oil = NAN, iat = NAN, ambient = NAN, volt = NAN;
  float stft = NAN, ltft = NAN, lambda = NAN, cat = NAN, timing = NAN;
  float fuelRate = NAN, fuel = NAN, runtime = NAN;
  // Driver demand through to engine response. Torque is reported as a percentage of
  // the engine's reference torque (PID 63), which is a constant read once.
  float pedalD = NAN, pedalE = NAN, cmdThrottle = NAN;
  float torqDem = NAN, torqAct = NAN, torqRef = NAN, absLoad = NAN;
  bool  ok = false;
};

// One on-board monitor test result from mode 06.
//
// Values and limits are kept raw. The unit-and-scaling id (uas) says how to convert
// them, and that table is long and only partly documented - but the useful reading
// does not need it: a test passes when its value sits between its own limits, and
// how much room is left is a fraction of that window. Both are unit-free.
struct MonRec {
  uint8_t  mid, tid, uas;
  uint16_t value, lo, hi;
};

// One UDS identifier that answered service 0x22 with a positive (0x62) response.
struct Hit {
  uint16_t did;
  uint8_t  ecu;          // 0 = ECM, 1 = TCM
  uint8_t  len;
  uint8_t  data[24];
};

#pragma once
#include <Arduino.h>
#include <string.h>

// One board, one car.
//
// Everything this board accumulates is about a particular vehicle. The sweep's hits
// are that car's identifier space, the register is verdicts about that car's ECU,
// the correlations are fits against that car's readings, and the trip logs are that
// car's drives. None of it carries a vehicle in the record itself - a hit is a DID
// and some bytes - so mixing two cars' data into one file does not produce a
// detectable error. It produces a file that is quietly wrong forever.
//
// The restore path already refuses this from one direction: a backup from another
// car will not load. This is the same rule from the other direction - the board
// must not ACCUMULATE into the wrong car's data either, which is the easier of the
// two to do by accident, because it needs nobody to press anything. Plug the board
// into a second car and it would happily append.
//
// So the binding is explicit. The board stores the key of the car it belongs to,
// and while the car in front of it is a different car it records NOTHING.
//
// WHAT "RECORDS NOTHING" COVERS
//
// The sweep, triage, the trip logs, the watch columns and the correlations - every
// path that writes a conclusion or a sample to flash. The live dashboard keeps
// working: it reads what the car is doing right now and persists none of it, so
// there is nothing for it to corrupt, and a board that showed a blank screen in the
// wrong car would be worse than useless at exactly the moment somebody wants to
// glance at a temperature.
//
// It also bounds the filesystem, which is the other half of why this is a rule
// rather than a warning. A 1.5 MB partition holding one car's sweep, register and
// trips is comfortable. The same partition accumulating a second car's is not, and
// the failure mode of filling it is a truncated write into a file that had no
// business growing.
//
// THREE ANSWERS, NOT TWO
//
// The important case is the one in the middle. A key is only known once mode 09 has
// answered, and a car that does not report a VIN or a calibration id never produces
// one - so "the keys do not match" and "there is no key to compare" are completely
// different facts, and only the first is a reason to stop recording.
//
// Reading absence as a mismatch would be the worse failure by a distance: it would
// silently switch off every recording path on any car whose ECU declines mode 09,
// and the symptom - a board that runs, shows live data, and quietly never writes a
// trip log - is one nobody would diagnose. Absent data breaks the rule, it does not
// satisfy it.

enum CarBind : uint8_t {
  CAR_NEW = 0,    // this board has never been bound to a car
  CAR_UNKNOWN,    // bound, but nothing has identified what is in front of it
  CAR_MATCH,      // bound, and this is that car
  CAR_FOREIGN,    // bound, and this is definitely a different car
};

static const char *carBindName(uint8_t s) {
  switch (s) {
    case CAR_UNKNOWN: return "unknown";
    case CAR_MATCH:   return "match";
    case CAR_FOREIGN: return "foreign";
    default:          return "new";
  }
}

/**
 * Which of the four, given the key the board is bound to and the key it can see.
 *
 * Pure, so the one decision the whole rule rests on is tested rather than driven
 * between two cars.
 */
static uint8_t carBindState(const char *bound, const char *seen) {
  const bool haveBound = bound && bound[0];
  const bool haveSeen  = seen  && seen[0];
  if (!haveBound) return CAR_NEW;
  if (!haveSeen)  return CAR_UNKNOWN;
  return strcmp(bound, seen) == 0 ? CAR_MATCH : CAR_FOREIGN;
}

/**
 * May the board write anything down right now?
 *
 * Only a positive mismatch says no. CAR_NEW records because a board nobody has
 * bound yet is the ordinary state of a board out of the box, and refusing to record
 * until somebody names a car would make the first drive produce nothing.
 * CAR_UNKNOWN records for the reason in the header: it is the state of every car
 * that will not answer mode 09, and it must not be a silent off switch.
 */
static bool carMayRecord(uint8_t state) {
  return state != CAR_FOREIGN;
}

/**
 * What the board is doing about it, in the words the page uses.
 *
 * Here rather than in the frontend because it is the same sentence on the built-in
 * fallback page and in the bundle, and because getting it wrong in one of the two
 * is how somebody concludes their board is broken when it is behaving exactly as
 * designed.
 */
static const char *carBindWhy(uint8_t state) {
  switch (state) {
    case CAR_FOREIGN:
      return "This is a different car from the one this board holds data for. "
             "Live readings work, but nothing is being recorded - a sweep, a "
             "register or a trip log from two cars in one file is wrong in a way "
             "nothing afterwards can detect.";
    case CAR_UNKNOWN:
      return "This car has not identified itself, so there is no way to tell "
             "whether it is the one this board is bound to. Recording continues - "
             "refusing to record on every car that declines mode 09 would be the "
             "worse mistake.";
    case CAR_MATCH:
      return "This is the car this board is bound to.";
    default:
      return "This board is not bound to a car yet. The first one it identifies "
             "becomes the one it keeps data for.";
  }
}

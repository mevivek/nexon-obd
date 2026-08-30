#pragma once
#include <Arduino.h>
#include "carbind.h"

// Deliberately does NOT include didmap.h, though it uses DidRec and DID_VARIES.
//
// didmap.h pulls in LittleFS, and the host suite compiles only the pure half of it -
// extract.py splits the file at its storage marker so the verdict rules can be
// tested without a filesystem. Including the whole thing here would drag LittleFS
// into a host build that has none, and the phases below are exactly the kind of
// decision that should be testable without a board. So the include order is the
// caller's job: the sketch includes didmap.h first, and the host includes the
// extracted half first.

// Running the whole investigation without being asked at every step.
//
// The manual workflow is four phases and three decisions, and the decisions are the
// same every time: sweep the identifier space, triage the hits to find which ones
// move, watch the ones that move, fit them against the live readings. Nobody
// choosing differently at any of those points is what makes it automatable - and
// the phases take hours each, so a person is not present at the moment one ends
// anyway. A prompt that appears mid-drive is a prompt that is missed, and the
// pipeline then stalls until somebody happens to open the page.
//
// So: advance on its own, and keep the whole state where a power cycle cannot lose
// it. The ignition going off IS a power cycle, and this pipeline is measured in
// drives.
//
// HOW LONG THIS ACTUALLY TAKES
//
// It matters that the page says so, because every phase looks stuck otherwise:
//
//   Sweep    ~30 minutes on CAN, the better part of a day over BLE.
//   Triage   ten clean reads of every hit. This adapter answers 40-58% of what it
//            is asked, so ten reads needs about twenty passes - budget an hour of
//            engine-on, not the six minutes a perfect link would take.
//   Watch    eight identifiers per drive, against roughly 66 that vary. That is
//            eight or nine drives, and there is no way to make it fewer: eight is
//            what the trip CSV can carry without the columns becoming unreadable.
//
// Days of driving, not minutes. A progress bar that implies otherwise is a bug.
//
// WHY ROTATION HAPPENS BETWEEN DRIVES
//
// Changing the watch set bumps watchGen, which rotates the trip log - the CSV gains
// a column pair per watched identifier, so a changed set cannot keep writing rows
// under a header that no longer describes them. Rotating mid-drive would therefore
// turn one drive into a pile of short files. So the set changes at tripBegin() and
// nowhere else, which also happens to be the natural boundary: one drive is one
// batch of eight, and a drive is the unit of varied conditions that makes a fit
// worth anything.

// The numbers are stored in NVS, so they are assigned rather than left to position:
// inserting a phase in pipeline order would renumber every one after it, and a board
// that lost power mid-run would come back in a different phase than it left. New
// phases go on the END whatever order they run in.
enum AutoPhase : uint8_t {
  AUTO_OFF    = 0,   // not running - the state of a board nobody has started
  AUTO_SWEEP  = 1,   // the engine ECU
  AUTO_TRIAGE = 2,
  AUTO_WATCH  = 3,
  AUTO_DONE   = 4,   // every varying identifier has been fitted
  AUTO_SWEEP2 = 5,   // the second ECU, between the sweep and triage
  AUTO_PHASE_MAX = AUTO_SWEEP2,
};

static const char *autoPhaseName(uint8_t p) {
  switch (p) {
    case AUTO_SWEEP:  return "sweep";
    case AUTO_SWEEP2: return "sweep2";
    case AUTO_TRIAGE: return "triage";
    case AUTO_WATCH:  return "watch";
    case AUTO_DONE:   return "done";
    default:          return "off";
  }
}

// Everything the transition depends on, gathered in one place so the decision is a
// pure function of observations rather than of whatever the globals happen to hold.
struct AutoFacts {
  bool     sweepDone = false;   // a full pass over the range has finished
  uint16_t records   = 0;       // identifiers in the register
  uint16_t triaged   = 0;       // records with enough reads for a verdict
  uint16_t varying   = 0;       // records that actually move
  uint16_t fitted    = 0;       // varying records that carry a correlation
  bool     mayRecord = true;    // carMayRecord() - see carbind.h

  // Did a second ECU answer a direct probe? Discovery asks 0x7E9 once per boot.
  //
  // This gates a whole extra sweep, and it is gated on a POSITIVE answer rather
  // than on the absence of a negative one - which is the opposite of the rule
  // everywhere else here, and deliberate. A sweep of an ECU that is not there does
  // not fail: it stalls, because 25 consecutive timeouts make the sweep hold
  // position rather than conclude an unswept range is empty. Holding is right for a
  // sweep and fatal for a pipeline, which would then wait for an ECU that will
  // never speak, forever, with no way to tell that from a car parked overnight.
  //
  // So: no answer means not swept, and the page says so rather than leaving it to
  // be inferred from a phase that never appears. The manual sweep still has a TCM
  // button for anyone who thinks the probe was wrong.
  bool     tcm       = false;
};

/**
 * The next phase, given the current one and what has been observed.
 *
 * A foreign car HOLDS rather than stops. The board is bound to one car and this is
 * not it, so nothing may be written - but the pipeline is a state of the car it
 * belongs to, and throwing it away because the board was borrowed for an afternoon
 * would cost the drives already spent. It resumes when the right car comes back.
 *
 * A sweep that finished with nothing is AUTO_DONE, not a retry. Zero hits after a
 * full pass is an answer - this ECU does not respond to service 0x22 - and looping
 * on it would spend the rest of the car's life re-asking a question already
 * answered.
 */
static uint8_t autoNext(uint8_t phase, const AutoFacts &f) {
  if (phase == AUTO_OFF || phase == AUTO_DONE) return phase;
  if (!f.mayRecord) return phase;

  switch (phase) {
    case AUTO_SWEEP:
      if (!f.sweepDone) return AUTO_SWEEP;
      // The second ECU is a separate identifier space at a separate address, and
      // the register keys records by (ecu, did) precisely so both can live in it.
      // Swept second because the engine is where everything interesting has been
      // found so far, and a pipeline that spends its first half hour on a
      // transmission is one nobody waits out.
      if (f.tcm) return AUTO_SWEEP2;
      return f.records ? AUTO_TRIAGE : AUTO_DONE;

    case AUTO_SWEEP2:
      if (!f.sweepDone) return AUTO_SWEEP2;
      return f.records ? AUTO_TRIAGE : AUTO_DONE;

    case AUTO_TRIAGE:
      // Every record, not most: a record short of its reads has no verdict at all,
      // and moving on would spend watch slots chosen from a partial list.
      if (f.records && f.triaged >= f.records) return f.varying ? AUTO_WATCH : AUTO_DONE;
      return AUTO_TRIAGE;

    case AUTO_WATCH:
      return (f.varying && f.fitted >= f.varying) ? AUTO_DONE : AUTO_WATCH;
  }
  return phase;
}

/** Progress through the current phase, 0..100, for a bar that does not lie. */
static uint8_t autoProgress(uint8_t phase, const AutoFacts &f, uint8_t sweepPct) {
  switch (phase) {
    case AUTO_SWEEP:
    case AUTO_SWEEP2: return sweepPct;
    case AUTO_TRIAGE: return f.records ? (uint8_t)((uint32_t)f.triaged * 100 / f.records) : 0;
    case AUTO_WATCH:  return f.varying ? (uint8_t)((uint32_t)f.fitted * 100 / f.varying) : 0;
    case AUTO_DONE:   return 100;
    default:          return 0;
  }
}

/**
 * Is this record still waiting for a drive's worth of watching?
 *
 * Only identifiers that move are worth a slot - a constant cannot correlate with
 * anything, and spending one of eight slots on one spends the scarcest thing here
 * on the least informative. That is the entire point of triage running first.
 */
static bool autoWantsWatch(const DidRec &r) {
  return r.state == DID_VARIES && r.corrRef >= CORR_REFS;
}

#pragma once
#include <Arduino.h>
#include <math.h>
#include "obd_types.h"

// Doing the fitting on the board instead of in a spreadsheet.
//
// The workflow this closes: a sweep finds that 1002 answers, triage finds that it
// moves, watching logs it in a column beside rpm and coolant - and then somebody
// opens the CSV and fits one against the other by hand. That last step is the only
// one a person was ever doing, it is the same arithmetic every time, and it is the
// reason a board that has collected everything needed to answer "what is 1002" still
// cannot say anything about it.
//
// A Pearson correlation is six running sums. Eight watched identifiers against six
// reference signals is forty-eight of them, which is nothing, and it turns "here is
// a CSV, go and fit it" into "1002 tracks coolant, r=0.97, over 4,200 samples".
//
// WHAT A CORRELATION IS NOT
//
// It is not an identification, and nothing here may present it as one. Three
// separate reasons, all of which have bitten real reverse-engineering work:
//
//   - Everything under a bonnet correlates with everything else. Oil temperature
//     tracks coolant temperature almost perfectly; both track runtime after a cold
//     start. A high r against coolant is equally consistent with "this is coolant
//     temperature", "this is oil temperature" and "this is anything else that warms
//     up", and the correlation cannot separate them.
//   - It says nothing about offset and scale. r is unchanged by both, so a perfect
//     correlation still leaves you not knowing whether the raw value is degrees, a
//     tenth of a degree, or degrees plus forty.
//   - It is only as good as the conditions sampled. An identifier watched entirely
//     at idle correlates with whatever else happened to drift at idle.
//
// So the register records the strongest reference and its r, and every place that
// is shown says "tracks", never "is". Identifying an identifier stays a human act -
// DID_IDENTIFIED outranks every machine verdict for exactly this reason.
//
// ABSENT DATA
//
// A sample pair is only accumulated when BOTH sides are present. A watched
// identifier that did not answer this cycle and a PID the car does not report are
// the same thing here, and folding either in as a zero would manufacture a
// correlation out of the gaps - which, given how often this adapter drops a reply,
// would be a correlation with the dropout pattern rather than with the car.

// The signals a watched identifier is fitted against.
//
// Six, chosen because they move independently of each other and cover the axes an
// unknown value is most likely to live on: engine speed, temperature, road speed,
// engine load, driver input and electrical system. Adding more is cheap in memory
// and expensive in false positives - with enough references something always
// correlates with something.
enum CorrRef : uint8_t {
  CORR_RPM = 0,
  CORR_COOLANT,
  CORR_SPEED,
  CORR_LOAD,
  CORR_THROTTLE,
  CORR_VOLT,
  CORR_REFS,
};

static const char *corrRefName(uint8_t i) {
  switch (i) {
    case CORR_RPM:      return "rpm";
    case CORR_COOLANT:  return "coolant";
    case CORR_SPEED:    return "speed";
    case CORR_LOAD:     return "load";
    case CORR_THROTTLE: return "throttle";
    case CORR_VOLT:     return "volt";
    default:            return "none";
  }
}

/** The reference value out of a sample, or NAN when the car did not report it. */
static float corrRefValue(const Live &L, uint8_t i) {
  switch (i) {
    case CORR_RPM:      return L.rpm;
    case CORR_COOLANT:  return L.coolant;
    case CORR_SPEED:    return L.speed;
    case CORR_LOAD:     return L.load;
    case CORR_THROTTLE: return L.throttle;
    case CORR_VOLT:     return L.volt;
    default:            return NAN;
  }
}

// Enough paired samples that r means something. Watching reads one identifier per
// period and a period is a second by default, so 120 is about two minutes of a
// drive - long enough for a temperature to have moved at all, short enough that a
// short trip still produces a verdict.
static const uint32_t CORR_MIN_N = 120;

// Where "tracks" starts. Deliberately high: with six references and hundreds of
// identifiers, a looser threshold reports coincidences at a rate that makes the
// whole table worthless.
static const float CORR_STRONG = 0.90f;

// Six running sums. Plain sums rather than Welford's method: the magnitudes here
// are bounded (rpm below 10000, so the squared sum over a long drive stays around
// 1e12) and a double carries about 9e15, so the numerical headroom is three orders
// of magnitude larger than anything a drive can produce.
struct Corr {
  uint32_t n  = 0;
  double   sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
};

static void corrReset(Corr &c) { c = Corr(); }

/** Fold in one pair. Either side absent means no pair, not a pair containing zero. */
static void corrAdd(Corr &c, float x, float y) {
  if (isnan(x) || isnan(y) || isinf(x) || isinf(y)) return;
  const double dx = x, dy = y;
  c.n++;
  c.sx += dx;  c.sy += dy;
  c.sxx += dx * dx;  c.syy += dy * dy;
  c.sxy += dx * dy;
}

/**
 * Pearson's r, or NAN when there is no answer to give.
 *
 * NAN for too few samples, and NAN when either side never moved - a constant column
 * has zero variance, r is 0/0, and the honest report is "cannot say" rather than a
 * zero that reads as "definitely unrelated". This is the same rule as everywhere
 * else here: absent data breaks the rule instead of satisfying it.
 */
static float corrR(const Corr &c) {
  if (c.n < CORR_MIN_N) return NAN;
  const double n = (double)c.n;
  const double cov = c.sxy - c.sx * c.sy / n;
  const double vx  = c.sxx - c.sx * c.sx / n;
  const double vy  = c.syy - c.sy * c.sy / n;
  if (vx <= 0 || vy <= 0) return NAN;
  const double d = sqrt(vx * vy);
  if (d <= 0) return NAN;
  double r = cov / d;
  // Rounding can push a perfect correlation a hair outside the range, and an r of
  // 1.0000001 shown to two decimal places is a number that makes a reader distrust
  // the whole table.
  if (r >  1.0) r =  1.0;
  if (r < -1.0) r = -1.0;
  return (float)r;
}

/**
 * The strongest reference for one identifier, by absolute r.
 *
 * Absolute because a value that falls as coolant rises is just as identified by
 * that relationship as one that rises with it - the sign is kept in the returned r
 * so the direction survives, but it must not decide which reference wins.
 *
 * Returns NAN and leaves `ref` at CORR_REFS when nothing reached CORR_MIN_N.
 */
static float corrBest(const Corr *row, uint8_t *ref) {
  float best = NAN;
  uint8_t at = CORR_REFS;
  for (uint8_t i = 0; i < CORR_REFS; i++) {
    const float r = corrR(row[i]);
    if (isnan(r)) continue;
    if (isnan(best) || fabsf(r) > fabsf(best)) { best = r; at = i; }
  }
  if (ref) *ref = at;
  return best;
}

/** r as the hundredths the register stores, or 0 with `ok` false when there is none. */
static int8_t corrToStored(float r, bool *ok) {
  if (isnan(r)) { if (ok) *ok = false; return 0; }
  if (ok) *ok = true;
  int v = (int)lroundf(r * 100.0f);
  if (v >  100) v =  100;
  if (v < -100) v = -100;
  return (int8_t)v;
}

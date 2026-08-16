// The "All values" table, ported verbatim from ROWS in dashboard_html.h.
//
// Every polled parameter with its PID, in PID-ish order rather than the driver's
// order the tiles above use. This is the diagnostic view: when a tile reads blank,
// this is where you look to see whether the parameter is missing or just not
// displayed, so it lists the field even when it is empty.
//
// Column meaning: [pid, name, key, unit, decimals]. `key` is the field in the merged
// sample — the pairing that matters, because a row showing another PID's number is
// worse than a blank one.

import { n } from '../../lib/format.js';

export const ROWS = [
  ['0C', 'Engine RPM', 'rpm', 'rpm', 0],
  ['0D', 'Vehicle speed', 'speed', 'km/h', 0],
  ['0B', 'Intake manifold pressure', 'map', 'kPa', 0],
  // Not a PID at all: MAP against barometric, computed in derive.js. Listed here
  // because it is the number on the tile and it has to be checkable.
  ['—', 'Boost (derived)', 'boost', 'bar', 2],
  ['04', 'Calculated load', 'load', '%', 1],
  ['11', 'Throttle position', 'throttle', '%', 1],
  ['05', 'Coolant temperature', 'coolant', '°C', 0],
  ['5C', 'Oil temperature', 'oil', '°C', 0],
  ['0F', 'Intake air temperature', 'iat', '°C', 0],
  ['46', 'Ambient air temperature', 'ambient', '°C', 0],
  ['06', 'Short term fuel trim B1', 'stft', '%', 1],
  ['07', 'Long term fuel trim B1', 'ltft', '%', 1],
  ['34', 'Lambda', 'lambda', '', 3],
  ['3C', 'Catalyst temp B1S1', 'cat', '°C', 1],
  ['0E', 'Timing advance', 'timing', '° BTDC', 1],
  ['5E', 'Fuel rate', 'fuelRate', 'L/h', 2],
  ['42', 'Module voltage', 'volt', 'V', 2],
  ['33', 'Barometric pressure', 'baro', 'kPa', 0],
  ['2F', 'Fuel tank level', 'fuel', '%', 1],
  // Raw seconds here, deliberately: the tile above shows 1h 4m 07s, this is the
  // number the ECU actually reported.
  ['1F', 'Engine run time', 'runtime', 's', 0],
  ['49', 'Accelerator pedal D', 'pedalD', '%', 1],
  ['4A', 'Accelerator pedal E', 'pedalE', '%', 1],
  ['4C', 'Commanded throttle actuator', 'cmdThrottle', '%', 1],
  ['61', 'Driver demanded torque', 'torqDem', '%', 1],
  ['62', 'Actual engine torque', 'torqAct', '%', 1],
  ['63', 'Engine reference torque', 'torqRef', 'N·m', 0],
  ['43', 'Absolute load value', 'absLoad', '%', 1],
];

/**
 * One rendered row per ROWS entry, in order.
 *
 * The firmware built the tbody once and then wrote `tr_<i>`'s textContent and
 * className on every poll; here the same rows are re-rendered and Preact patches the
 * text node in place. Same result, and the index-to-PID pairing cannot drift because
 * it is never written down twice.
 */
export function rowCells(v = {}, q = {}) {
  return ROWS.map(([pid, name, key, unit, dec], i) => ({
    i,
    pid,
    name,
    key,
    unit,
    text: n(v[key], dec),
    // A held reading is dimmed here exactly as it is on the tiles — in a table of
    // thirty numbers, the ones that are no longer being read are the ones you most
    // need to be able to pick out.
    cls: q[key] ? 'num stale' : 'num',
  }));
}

// One drive, read back off the board.
//
// The board serves the CSV it already recorded — /trips/get?f=<name> — and this
// page does the reading. Nothing was added to the firmware for it: the summary is
// two rows of that file subtracted, because triplog.h integrates trip_km and trip_l
// on the board precisely so that any span can be recovered that way.
//
// The file is fetched whole and parsed on the main thread. That is deliberate: a
// long drive is a few hundred kilobytes and a few thousand rows, which is a couple
// of milliseconds of String.split, and a Web Worker would mean a second bundle
// entry point in a build whose whole shape is one file. What does need bounding is
// what gets *drawn*, and that is detail.js's downsample.

import { useEffect, useState } from 'preact/hooks';
import { useShellStatus } from '../shell.jsx';
import { DASH, n } from '../lib/format.js';
import { sparkPath } from './live/spark.js';
import { IconBack, IconDownload } from '../icons.jsx';
import { tripHref, tripLabel } from './trips/trips.js';
import {
  parseTripCsv, tripSummary, series, boostSeries, downsample, durationText,
} from './trips/detail.js';

/** A figure and its unit, or an em-dash. Absent is not zero, here as everywhere. */
function Stat({ label, value, unit, note }) {
  return (
    <div class="tile">
      <div class="label">{label}</div>
      <div class="value">
        {value == null ? DASH : value}
        {value != null && unit ? <span class="unit">{unit}</span> : null}
      </div>
      {note ? <div class="note">{note}</div> : null}
    </div>
  );
}

/**
 * One trace over the whole drive.
 *
 * The geometry is spark.js's, unchanged — same pure function the Live tiles use,
 * stretched to a taller box. `zero` is passed for the same reason it is there:
 * speed and rpm read as flat when they are flat, while coolant and boost live in a
 * few degrees or a tenth of a bar and have to be scaled to what they did.
 */
function Trace({ label, values, unit, dp, color, zero }) {
  const points = downsample(values);
  const p = sparkPath(points, zero);
  const last = points.length ? points[points.length - 1] : null;
  const lo = points.length ? Math.min(...points) : null;
  const hi = points.length ? Math.max(...points) : null;

  return (
    <div class="card trace">
      <div class="top">
        <div class="label" style="margin:0">{label}</div>
        <b>{last == null ? DASH : n(last, dp)}</b>
        <span class="unit">{unit}</span>
        <span class="rng">
          {lo == null ? '' : `${n(lo, dp)} – ${n(hi, dp)}`}
        </span>
      </div>
      {p ? (
        <svg viewBox={p.viewBox} preserveAspectRatio="none" role="img"
             aria-label={`${label} over the drive`}>
          <polyline points={p.points} fill="none" style={`stroke:${color}`}
                    stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
                    vector-effect="non-scaling-stroke" />
        </svg>
      ) : (
        // Never a flat line at zero. Two different absences, said differently: the
        // board never recorded this column, or it recorded too little of it to draw
        // — and neither of them is a reading of nothing.
        <div class="note">
          {values.length === 0
            ? 'not recorded on this drive'
            : 'too few samples to plot'}
        </div>
      )}
    </div>
  );
}

export function TripDetail({ name }) {
  const [state, setState] = useState({ phase: 'loading', parsed: null, error: null });

  useEffect(() => {
    let live = true;
    setState({ phase: 'loading', parsed: null, error: null });
    fetch(tripHref(name), { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then((text) => {
        if (!live) return;
        const parsed = parseTripCsv(text);
        setState({ phase: 'ready', parsed, error: null });
      })
      .catch((e) => {
        if (!live) return;
        setState({ phase: 'error', parsed: null, error: String(e.message || e) });
      });
    return () => { live = false; };
  }, [name]);

  const { phase, parsed } = state;
  const s = parsed ? tripSummary(parsed) : null;

  useShellStatus(
    phase === 'error'
      ? { dot: 'dot dead', text: 'unreadable', sub: tripLabel(name) }
      : phase === 'loading'
        ? { dot: 'dot', text: 'reading…', sub: tripLabel(name) }
        : { dot: 'dot live', text: s.rows + ' rows', sub: tripLabel(name) },
  );

  return (
    <>
      <a class="back" href="#/trips"><IconBack />All trips</a>

      {phase === 'loading' && <div class="card"><div class="note">Reading the drive…</div></div>}

      {phase === 'error' && (
        <div class="card">
          <div class="value warn" style="font-size:18px">Could not read this trip</div>
          <div class="hint">
            {state.error}. The file may have been deleted, or rotated out to make room —
            the board removes the oldest drive when the partition runs short.
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <>
          <div class="tiles vital" style="margin-top:0">
            <Stat label="Distance" value={s.km == null ? null : s.km.toFixed(1)} unit="km" />
            <Stat label="Duration" value={durationText(s.seconds)}
                  note={s.clockSet ? null : 'clock was unset — measured on uptime'} />
            <Stat label="Mileage" value={s.kmPerL == null ? null : s.kmPerL.toFixed(1)} unit="km/L"
                  note={s.kmPerL == null ? 'too short to average' : null} />
            <Stat label="Fuel" value={s.litres == null ? null : s.litres.toFixed(2)} unit="L" />
          </div>

          <h2 class="sec">Peaks</h2>
          <div class="tiles">
            <Stat label="Max speed" value={s.maxSpeed == null ? null : n(s.maxSpeed, 0)} unit="km/h" />
            <Stat label="Max rpm" value={s.maxRpm == null ? null : n(s.maxRpm, 0)} unit="rpm" />
            <Stat label="Peak coolant" value={s.peakCoolant == null ? null : n(s.peakCoolant, 0)} unit="°C" />
            <Stat label="Peak oil" value={s.peakOil == null ? null : n(s.peakOil, 0)} unit="°C" />
          </div>

          <h2 class="sec">Over the drive</h2>
          <Trace label="Speed" values={series(parsed, 'speed')} unit="km/h" dp={0}
                 color="var(--aqua)" zero />
          <Trace label="Engine speed" values={series(parsed, 'rpm')} unit="rpm" dp={0}
                 color="var(--blue)" zero />
          <Trace label="Coolant" values={series(parsed, 'coolant_c')} unit="°C" dp={0}
                 color="var(--yellow)" />
          <Trace label="Boost" values={boostSeries(parsed)} unit="bar" dp={2}
                 color="var(--orange)" />

          <div class="card">
            <div class="row2">
              <div class="grow">
                <div class="nm">{tripLabel(name)}</div>
                <div class="sz">
                  {s.rows} rows
                  {parsed.meta.fw ? ' · recorded on v' + parsed.meta.fw : ''}
                  {parsed.skipped
                    // Worth saying rather than hiding: the last row of a real file is
                    // regularly half-written, because the ignition cuts between one
                    // ten-second flush and the next.
                    ? ` · ${parsed.skipped} incomplete row${parsed.skipped > 1 ? 's' : ''} skipped`
                    : ''}
                </div>
              </div>
              <div class="act">
                <a href={tripHref(name)} title="Download the CSV" aria-label="Download the CSV">
                  <IconDownload />
                </a>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default TripDetail;

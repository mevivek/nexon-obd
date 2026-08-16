// Trip logs. Ported from firmware/NexonOBD/trip_html.h.
//
// The board records a CSV row a second to its own filesystem while the ECU is
// answering. This lists what it has, downloads it, and deletes what you are done
// with — the partition is 1.5 MB, which is a few hours of driving.
//
// Styling note, as on Monitors: trip_html.h's page-local .row2/.grow/.nm/.sz/.act/
// .live rules now live in the page section of styles.css, so the markup below uses
// the firmware's own class names.

import { useState, useEffect, useCallback } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { useShellStatus } from '../shell.jsx';
import {
  TRIP_POLL_MS, confirmText, kb, sortTrips, storageText,
  tripDelHref, tripHref, tripLabel, tripStatus, usedPct,
} from './trips/trips.js';

function Trip({ f, live, onDelete }) {
  return (
    <div class="card">
      <div class="row2">
        <div class="grow">
          <div class="nm">
            {tripLabel(f.name)}
            {f.name === live && <span class="live"> &middot; recording</span>}
          </div>
          <div class="sz">{kb(f.size)}</div>
        </div>
        <div class="act">
          <a href={tripHref(f.name)}>Download</a>
          <button class="ghost" onClick={() => onDelete(f.name)}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export function Trips() {
  useClockSync();

  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  // Kept in a ref-like closure so both the interval and the delete handler can call
  // the same fetch — deleting re-polls immediately rather than waiting out the
  // interval, as the firmware page did.
  const poll = useCallback(async () => {
    try {
      const j = await (await fetch('/trips/list', { cache: 'no-store' })).json();
      setData(j);
      setErr(false);
      return j;
    } catch (e) {
      setErr(true);
      return null;
    }
  }, []);

  useEffect(() => {
    let live = true;
    const run = () => { if (live) poll(); };
    run();
    const t = setInterval(run, TRIP_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [poll]);

  const del = useCallback(async (name) => {
    if (!confirm(confirmText(name))) return;
    try {
      await fetch(tripDelHref(name), { cache: 'no-store' });
    } catch (e) {
      // The re-poll below is what tells you whether it actually went.
    }
    poll();
  }, [poll]);

  // No client-side filtering: /trips/list now returns only real trip logs.
  const trips = sortTrips(data && data.trips);

  useShellStatus(tripStatus(data, err));

  return (
    <>
      <div class="card">
        <div class="row2">
          <div class="grow">
            <div class="label" style="margin:0 0 4px">Storage</div>
            <div class="bar2" style="margin:0"><i style={'width:' + usedPct(data)} /></div>
          </div>
        </div>
        <div class="note" style="margin-top:8px">{storageText(data)}</div>
        <div class="hint">
          A row a second while the engine is answering, written to the board's own
          filesystem. Roughly half a megabyte an hour, so the partition holds a few
          hours &mdash; the oldest trip is deleted automatically when space runs
          short.<br /><br />
          Rows carry both wall-clock time and uptime. The board learns the time from
          whichever page you open, so a drive that starts before you open one has an
          unset clock for those first rows &mdash; the header of each file records
          which.
        </div>
      </div>

      {trips.map((f) => (
        <Trip key={f.name} f={f} live={data && data.live} onDelete={del} />
      ))}

      {/* Only once a list has actually arrived — an empty page during the first
          fetch would claim there are no trips before anything has been read. */}
      {data && !trips.length && (
        <div class="card">
          <div style="color:var(--muted);font-size:14px">
            No trips recorded yet. One starts as soon as the ECU answers.
          </div>
        </div>
      )}
    </>
  );
}

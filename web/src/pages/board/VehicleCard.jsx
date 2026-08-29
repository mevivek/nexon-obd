// What car this is, and which tiles it can fill.
//
// This is the answer to a question the dashboard could not previously be asked. A
// blank tile has always had two possible causes - the car does not publish that
// reading, or nothing is answering right now - and they look identical. Discovery
// separates them, and this card is where that separation is visible.
//
// It polls only while the walk is unfinished. Once /vehicle says done, the answers
// cannot change without a reboot, so continuing to ask would be spending bus-free
// HTTP turns on a constant.

import { useState, useEffect } from 'preact/hooks';
import {
  identityRows, pidTally, pidText, unsupportedPids, tcmText, blocksText,
} from './vehicle.js';

// `onVehicle` hands the payload up rather than only a status. The backup card keys
// on the same identity this one displays, and two cards polling one endpoint on a
// single-core board that is also serving a car is exactly what bus_yield.h exists
// to stop - so this is the only reader of /vehicle on the page.
export function VehicleCard({ onVehicle }) {
  const [veh, setVeh] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    let timer = null;

    const read = () => {
      fetch('/vehicle', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => {
          if (!live) return;
          setVeh(j);
          setErr(null);
          // Stop asking once there is nothing left to learn.
          if (!j.done) timer = setTimeout(read, 2000);
        })
        .catch((e) => {
          if (!live) return;
          setErr(String(e));
          timer = setTimeout(read, 4000);
        });
    };
    read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (onVehicle) onVehicle(veh, err);
  }, [veh, err]);

  const t = pidTally(veh);
  const blank = unsupportedPids(veh);

  return (
    <div class="card">
      <h2 class="sec">Identity</h2>
      <div class="hint" style="margin-top:0">
        Read once per boot from the engine ECU: the mode 01 support bitmaps, then
        mode 09 for the identity. Nothing here changes what the board polls - it is
        a report, not a reconfiguration.
      </div>

      <div class="ref" style="margin-top:12px">
        {identityRows(veh).map((r) => (
          <div key={r.label}>
            <div class="label">{r.label}</div>
            <div class="value">{r.value}</div>
            {r.note ? <div class="note">{r.note}</div> : null}
          </div>
        ))}
      </div>

      <h2 class="sec">Readings this car supports</h2>
      <div class="msg">{pidText(t)}</div>
      {blank.length ? (
        <div class="note">
          Blank because the car does not publish them: {blank.map((p) => 'PID ' + p).join(', ')}.
        </div>
      ) : null}
      <div class="note">{blocksText(veh)}</div>

      <h2 class="sec">Other modules</h2>
      <div class="note">{tcmText(veh)}</div>

      {veh && !veh.done ? (
        <div class="hint">
          The walk runs only while the ECU is answering, so with the ignition off it
          waits rather than concluding. Start the engine and it finishes in about ten
          seconds.
        </div>
      ) : null}
    </div>
  );
}

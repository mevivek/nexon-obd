// The autopilot panel.
//
// Sweep, triage and watch used to be three buttons somebody pressed in order, hours
// apart, with the correlation done afterwards in a spreadsheet. Nobody chooses
// differently at any of those points, which is what makes it automatable - and the
// phases outlast anyone's attention, so a prompt between them is a prompt that gets
// missed and a pipeline that stalls.
//
// The panel's whole job is to keep a process measured in DRIVES from looking like a
// broken one. Every phase says what it is doing and what it costs, and when nothing
// is happening the board's own reason is shown in preference to anything this page
// could guess.

import { useState, useEffect } from 'preact/hooks';
import {
  autoStatus, autoText, autoCounts, drivesLeft, phaseIndex, PHASES, FIT_NOTE,
  tcmText,
} from './auto.js';

export function AutoCard({ onStatus }) {
  const [j, setJ] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let live = true;
    let timer = null;
    const read = () => {
      fetch('/auto', { cache: 'no-store' })
        .then((r) => r.json())
        .then((x) => { if (live) { setJ(x); setErr(null); } })
        .catch((e) => { if (live) setErr(String(e)); })
        .finally(() => { if (live) timer = setTimeout(read, 2000); });
    };
    read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => { if (onStatus) onStatus(autoStatus(j, err)); }, [j, err]);

  async function post(path) {
    setBusy(true);
    try {
      await fetch(path, { cache: 'no-store' });
    } catch (e) { /* the poll above reports the real state a moment later */ }
    setArmed(false);
    setBusy(false);
  }

  const running = j && j.phase !== 'off';
  const step = phaseIndex(j && j.phase);

  return (
    <div class="card">
      <h2 class="sec">Autopilot</h2>

      {running ? (
        <>
          {/* Which of the three, so the bar below is read against the right scale -
              31% of a sweep is half an hour, 31% of watching is six drives. */}
          {step ? (
            <div class="label">
              Step {step} of {PHASES.length} — {PHASES[step - 1].label}
            </div>
          ) : null}
          <div class="bar2"><i style={'width:' + (j.pct || 0) + '%'} /></div>
          <div class="msg">{autoText(j)}</div>
          <div class="note">{autoCounts(j)}</div>
          {drivesLeft(j) ? <div class="note">{drivesLeft(j)}</div> : null}
          {tcmText(j) ? <div class="note">{tcmText(j)}</div> : null}
        </>
      ) : (
        <>
          <div class="msg">{autoText(j || { phase: 'off' })}</div>
          <div class="hint" style="margin-top:8px">
            {PHASES.map((p) => (
              <div key={p.id} style="margin-bottom:6px">
                <b>{p.label}</b> — {p.what} <i>{p.cost}.</i>
              </div>
            ))}
            It runs unattended and survives the ignition, so there is nothing to come
            back and press. Leave the board in the car and drive.
          </div>
        </>
      )}

      <div class="btns">
        {running ? (
          <button disabled={busy} onClick={() => (armed ? post('/auto/stop') : setArmed(true))}>
            {armed ? 'Really stop the run?' : 'Stop'}
          </button>
        ) : (
          <button disabled={busy} onClick={() => post('/auto/start')}>
            Start the pipeline
          </button>
        )}
      </div>
      {armed ? (
        <div class="note">
          Stopping keeps everything found so far. The sweep resumes from its position
          if you start again.
        </div>
      ) : null}

      {j && j.fitted ? <div class="hint">{FIT_NOTE}</div> : null}
    </div>
  );
}

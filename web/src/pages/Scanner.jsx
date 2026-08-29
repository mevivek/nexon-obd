// UDS DID scanner. Ported from firmware/Obdurate/scan_html.h.
//
// Service 0x22 reads only — this page cannot issue any state-changing service, and
// the wording throughout says so on purpose. Everything it shows comes from
// /scan/status; the sweep itself is driven by the board, which is why the page can
// be opened, closed and reopened mid-run without touching it.
//
// A note on styling, following Monitors.jsx: scan_html.h's page-local .row>div,
// .btns and #res rules now live in the page section of styles.css. The two .row
// rules are scoped there to `.scan`, which is why the controls card below carries
// that class — the Watch page shares the .row class and has no such rules of its
// own, so an unscoped copy would re-flow it.

import { useState, useEffect, useRef } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { useShellStatus } from '../shell.jsx';
import { DASH } from '../lib/format.js';
import {
  ratePerSec, rateText, etaText, percent, progressText, scanStatus, spacedHex,
  hitsCsv, CSV_NAME,
} from './scanner/scan.js';

// A running sweep is watched; an idle board is left alone. The interval used to be
// created only inside the firmware's Start handler, so opening the page mid-sweep
// showed one frozen snapshot and the only way to get moving numbers was to press
// Start — which wipes the run.
const POLL_RUNNING_MS = 1000;
const POLL_IDLE_MS = 4000;

export function Scanner() {
  useClockSync();

  const [ecu, setEcu] = useState('0');
  const [from, setFrom] = useState('0000');
  const [to, setTo] = useState('FFFF');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  // Start is reflected the moment it is pressed, not a round trip later.
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  // The page must be live however the scan was started — it may have been kicked
  // off from another phone, or before this tab was opened, since the board runs it.
  useEffect(() => {
    let live = true, timer = null, seq = 0;

    async function poll() {
      const my = ++seq;                  // a manual poll supersedes one in flight
      clearTimeout(timer);
      let next = POLL_IDLE_MS;
      try {
        const j = await (await fetch('/scan/status', { cache: 'no-store' })).json();
        if (!live || my !== seq) return;
        setData(j);
        setErr(false);
        setBusy(false);
        next = j.running ? POLL_RUNNING_MS : POLL_IDLE_MS;
      } catch (e) {
        // The hits already on screen stay there; only the header changes. A dropped
        // poll does not mean the identifiers it already found stopped answering.
        if (!live || my !== seq) return;
        setErr(true);
      }
      timer = setTimeout(poll, next);
    }

    pollRef.current = poll;
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  const hits = (data && data.hits) || [];
  // Optimistic while Start is in flight: the board is the authority, but a button
  // that waits a round trip to look pressed gets pressed twice — and Start resets
  // cur, tried, negatives and clears the hit list on the board.
  const running = busy || !!(data && data.running);
  useShellStatus(scanStatus(data, err));
  const rps = data ? ratePerSec(data.tried, data.elapsed) : 0;

  async function start() {
    setBusy(true);
    const q = `?ecu=${ecu}&from=${from}&to=${to}`;
    try { await fetch('/scan/start' + q); } catch (e) { /* the poll reports it */ }
    if (pollRef.current) pollRef.current();
  }

  async function stop() {
    try { await fetch('/scan/stop'); } catch (e) { /* likewise */ }
    if (pollRef.current) pollRef.current();
  }

  // Built and downloaded in the browser. The board is never asked for a file — it
  // has better things to do with its one thread — and nothing leaves the phone.
  function csv() {
    if (!hits.length) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([hitsCsv(hits)], { type: 'text/csv' }));
    a.download = CSV_NAME;
    a.click();
  }

  return (
    <>
      <div class="card scan">
        <div class="row">
          <div>
            <label for="ecu">ECU</label>
            <select id="ecu" value={ecu} disabled={running}
                    onChange={(e) => setEcu(e.currentTarget.value)}>
              <option value="0">ECM &mdash; engine (7E0/7E8)</option>
              <option value="1">TCM &mdash; transmission (7E1/7E9)</option>
            </select>
          </div>
          <div>
            <label for="from">From</label>
            <input type="text" id="from" value={from} disabled={running}
                   onInput={(e) => setFrom(e.currentTarget.value)} />
          </div>
          <div>
            <label for="to">To</label>
            <input type="text" id="to" value={to} disabled={running}
                   onInput={(e) => setTo(e.currentTarget.value)} />
          </div>
        </div>

        {/* Start resets cur, tried, negatives and clears the hit list on the board,
            and none of that is persisted anywhere — so leaving the button live
            during a sweep put a stray tap between you and losing the whole thing. */}
        <div class="btns">
          <button disabled={running} onClick={start}>
            {running ? 'Scanning…' : 'Start scan'}
          </button>
          <button class="ghost" disabled={!running} onClick={stop}>Stop</button>
          <button class="ghost" disabled={!hits.length} onClick={csv}>CSV</button>
        </div>

        <div class="bar2">
          <i style={'width:' + percent(data && data.tried, data && data.total) + '%'} />
        </div>
        {/* Counts, then the percentage. Over a 65,536-identifier sweep the figure
            sits on "0.5%" for ten minutes at a time, so a percentage on its own
            reads as stuck — and the instinctive response to a stuck sweep is to
            press Start, which discards it. The counts move on every request. */}
        <div class="note">{progressText(data && data.tried, data && data.total)}</div>

        {data && data.stalled && (
          <div class="hint" style="color:var(--warning)">
            The ECU has stopped answering &mdash; ignition off, most likely. The sweep is holding
            its place rather than recording identifiers it never really asked, and picks up again
            on its own when the car answers. Progress is saved, so switching off is safe.
          </div>
        )}

        <div class="meta">
          <span>at <b>{data ? data.cur : DASH}</b></span>
          <span>tried <b>{data ? data.tried : 0}</b></span>
          <span>hits <b>{hits.length}</b></span>
          <span>negatives <b>{data ? data.negatives : 0}</b></span>
          <span>elapsed <b>{data ? data.elapsed : 0}</b>s</span>
          <span>rate <b>{data ? rateText(rps) : DASH}</b>/s</span>
          <span>left <b>{data ? etaText(rps, data.tried, data.total) : DASH}</b></span>
        </div>

        <div class="hint">
          A scan keeps running if you leave this page or close the browser &mdash;
          it is driven by the board, not by this tab. The scanner takes most of the bus, so
          live dashboard values keep updating but slowly. Use Stop to end it &mdash; starting a
          new scan discards the identifiers found so far.<br /><br />
          Progress and hits are saved as the sweep runs, so it resumes where it left off after
          the car is switched off or the board is reflashed &mdash; a full pass no longer has to
          happen in one sitting.<br /><br />
          Service 0x22 is a read. This page never sends 0x2E (write), 0x31 (routine),
          0x11 (reset) or 0x10 (session change). A full 0000&ndash;FFFF pass is 65,536 requests.
          Run it parked.
        </div>
      </div>

      <div class="card tw">
        <table id="res">
          <caption>Responding identifiers</caption>
          <thead>
            <tr>
              <th>ECU</th><th>DID</th><th class="num">Bytes</th><th>ASCII</th><th>Hex</th>
            </tr>
          </thead>
          <tbody>
            {hits.length ? hits.map((h) => (
              <tr key={h.ecu + h.did}>
                <td>{h.ecu}</td>
                <td class="mono">{h.did}</td>
                <td class="num">{h.len}</td>
                <td class="mono brk">{h.ascii}</td>
                <td class="mono brk">{spacedHex(h.hex)}</td>
              </tr>
            )) : (
              <tr>
                <td colspan="5" style="color:var(--muted)">
                  {data || err ? 'Nothing yet.' : 'No scan run yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

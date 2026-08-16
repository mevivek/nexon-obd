// UDS DID scanner. Ported from firmware/NexonOBD/scan_html.h.
//
// Service 0x22 reads only — this page cannot issue any state-changing service, and
// the wording throughout says so on purpose. Everything it shows comes from
// /scan/status; the sweep itself is driven by the board, which is why the page can
// be opened, closed and reopened mid-run without touching it.

import { useEffect, useRef, useState } from 'preact/hooks';
import { DASH } from '../lib/format.js';
import {
  ratePerSec, rateText, etaText, percent, progressText, spacedHex, hitsCsv, CSV_NAME,
} from './scanner/scan.js';

// The page's own rules, as they were in the firmware's <style> block. They live
// with the page rather than in styles.css because they are this layout's, and the
// element is unmounted with the page. `#res` became a class so the markup carries
// no ids into a single-page app.
const PAGE_CSS = `
.scan .row>div{flex:1 1 120px;min-width:0}
.scan .row>div:first-child{flex:1 1 100%}
.scan .row select,.scan .row input{width:100%}
.scan .btns{display:flex;gap:8px;margin-top:10px}
.scan .btns button{flex:1;padding:10px 8px}
/* Results scroll sideways rather than wrapping hex into an unreadable block. */
.scan-res{min-width:470px}
`;

/** Poll fast enough to watch a sweep move, slow enough to leave the bus alone. */
const POLL_RUNNING = 1000;
const POLL_IDLE = 4000;

export function Scanner() {
  const [ecu, setEcu] = useState('0');
  const [from, setFrom] = useState('0000');
  const [to, setTo] = useState('FFFF');
  const [st, setSt] = useState(null);
  const [dead, setDead] = useState(false);
  // Start is reflected the moment it is pressed, not a round trip later.
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  // The page must be live however the scan was started — it may have been kicked
  // off from another phone, or before this tab was opened, since the board runs it.
  // The firmware's interval used to be created only inside the Start handler, so
  // opening this page mid-sweep showed one frozen snapshot and the only way to get
  // moving numbers was to press Start, which wipes the run.
  useEffect(() => {
    let alive = true, timer = null, seq = 0;

    async function tick() {
      const my = ++seq;                  // a manual poll supersedes one in flight
      clearTimeout(timer);
      let next = POLL_IDLE;
      try {
        const j = await (await fetch('/scan/status', { cache: 'no-store' })).json();
        if (!alive || my !== seq) return;
        setSt(j);
        setDead(false);
        setBusy(false);
        next = j.running ? POLL_RUNNING : POLL_IDLE;
      } catch (e) {
        if (!alive || my !== seq) return;
        setDead(true);
      }
      timer = setTimeout(tick, next);
    }

    pollRef.current = tick;
    tick();

    // The board has no clock of its own. Whichever page you open hands over the
    // time, so anything it records carries a real timestamp.
    fetch('/time?ms=' + Date.now(), { cache: 'no-store' }).catch(() => {});

    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const hits = (st && st.hits) || [];
  // Optimistic while Start is in flight: the board is the authority, but a button
  // that waits a round trip to look pressed gets pressed twice.
  const running = busy || !!(st && st.running);
  const stalled = !!(st && st.stalled);

  const rps = st ? ratePerSec(st.tried, st.elapsed) : 0;

  // Stalled is not idle and not scanning: the sweep is alive and holding position
  // because the ECU stopped answering. Saying "scanning" would imply progress that
  // is deliberately not happening.
  const state = dead ? 'ESP32 unreachable'
    : stalled ? 'waiting for ECU'
      : running ? 'scanning' : 'idle';
  const dot = dead ? 'dead' : stalled ? 'stale' : running ? 'live' : '';

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

  function csv() {
    if (!hits.length) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([hitsCsv(hits)], { type: 'text/csv' }));
    a.download = CSV_NAME;
    a.click();
  }

  return (
    <div class="scan">
      <style>{PAGE_CSS}</style>

      <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
        <span class="sub">service 0x22</span>
        <div class="status"><span class={'dot ' + dot} /><span>{state}</span></div>
      </div>

      <div class="card">
        <div class="row">
          <div>
            <label for="ecu">ECU</label>
            <select id="ecu" value={ecu} disabled={running}
                    onChange={(e) => setEcu(e.currentTarget.value)}>
              <option value="0">ECM — engine (7E0/7E8)</option>
              <option value="1">TCM — transmission (7E1/7E9)</option>
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
          <button id="go" disabled={running} onClick={start}>
            {running ? 'Scanning…' : 'Start scan'}
          </button>
          <button id="stop" class="ghost" disabled={!running} onClick={stop}>Stop</button>
          <button id="csv" class="ghost" disabled={!hits.length} onClick={csv}>CSV</button>
        </div>

        <div class="bar2">
          <i style={{ width: percent(st && st.tried, st && st.total) + '%' }} />
        </div>
        {/* Counts first: over a 65,536-identifier sweep the percentage sits on the
            same figure for ten minutes at a time and the page reads as stuck. */}
        <div class="note">{progressText(st && st.tried, st && st.total)}</div>

        {stalled && (
          <div class="hint" style="color:var(--warning)">
            The ECU has stopped answering — ignition off, most likely. The sweep is holding
            its place rather than recording identifiers it never really asked, and picks up again
            on its own when the car answers. Progress is saved, so switching off is safe.
          </div>
        )}

        <div class="meta">
          <span>at <b>{st ? st.cur : DASH}</b></span>
          <span>tried <b>{st ? st.tried : 0}</b></span>
          <span>hits <b>{hits.length}</b></span>
          <span>negatives <b>{st ? st.negatives : 0}</b></span>
          <span>elapsed <b>{st ? st.elapsed : 0}</b>s</span>
          <span>rate <b>{st ? rateText(rps) : DASH}</b>/s</span>
          <span>left <b>{st ? etaText(rps, st.tried, st.total) : DASH}</b></span>
        </div>

        <div class="hint">
          A scan keeps running if you leave this page or close the browser —
          it is driven by the board, not by this tab. The scanner takes most of the bus, so
          live dashboard values keep updating but slowly. Use Stop to end it — starting a
          new scan discards the identifiers found so far.<br /><br />
          Progress and hits are saved as the sweep runs, so it resumes where it left off after
          the car is switched off or the board is reflashed — a full pass no longer has to
          happen in one sitting.<br /><br />
          Service 0x22 is a read. This page never sends 0x2E (write), 0x31 (routine),
          0x11 (reset) or 0x10 (session change). A full 0000–FFFF pass is 65,536 requests.
          Run it parked.
        </div>
      </div>

      <div class="card tw">
        <table class="scan-res">
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
                  {st || dead ? 'Nothing yet.' : 'No scan run yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

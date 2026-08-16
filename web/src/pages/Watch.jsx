// DID watch. Ported from firmware/NexonOBD/watch_html.h.
//
// The scanner finds identifiers that answer; it cannot say what they hold. This
// reads a chosen handful continuously and puts them next to rpm, coolant and load,
// so a value that moves with one of them gives itself away. The same readings go
// into the trip CSV as extra columns for anything too subtle to see by eye.
//
// A note on styling, following Monitors.jsx: watch_html.h carried a page-local
// <style> block for .ref, .w, .wh, .wn, .wv, .wx, .pick and .full, none of which is
// in the shared stylesheet. Rather than add rules to styles.css — ported verbatim
// from ui_css.h and not this port's to change — they are reproduced as inline style
// attributes, byte for byte from the firmware's declarations.

import { useState, useEffect, useRef } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { n, DASH } from '../lib/format.js';
import { parseCsv, mergeHits, watchName, loadStoredHits, saveStoredHits } from './watch/hits.js';
import { pushReadings, sparkPoints } from './watch/series.js';
import { addTyped, costText, WATCH_MAX } from './watch/picker.js';
import { watchStatus } from './watch/status.js';

const MONO = 'ui-monospace,SFMono-Regular,Consolas,monospace';

// .ref, .ref div and .ref .value — narrower than the shared .tiles minimum, because
// six reference gauges have to fit across a phone beside the values being hunted.
const REF = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px';
const REF_CELL = 'min-width:0';
const REF_VALUE = 'font-size:19px';

// .w — one watched identifier.
const W = 'background:var(--surface);border:1px solid var(--ring);border-radius:12px;'
  + 'padding:10px 12px;margin-bottom:8px;overflow:hidden';
const WH = 'display:flex;align-items:baseline;gap:8px';
const WN = `font-family:${MONO};font-size:13px;font-weight:650`;
const WV = 'margin-left:auto;font-size:22px;font-weight:650;letter-spacing:-.02em;'
  + 'font-variant-numeric:tabular-nums';
const WX = `font-family:${MONO};font-size:11px;color:var(--muted)`;

// .pick and its labels — a scrolling tray, because a sweep can turn up hundreds.
const PICK = 'display:flex;flex-wrap:wrap;gap:6px;max-height:210px;overflow-y:auto;'
  + 'margin-top:9px;padding:2px';
const PICK_LABEL = 'display:flex;align-items:center;gap:5px;margin:0;padding:5px 8px;'
  + 'background:var(--raised);border:1px solid var(--base);border-radius:8px;'
  + `font-family:${MONO};font-size:12px;`
  + 'font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;';
const PICK_OFF = PICK_LABEL + 'color:var(--ink2)';
const PICK_ON = PICK_LABEL + 'border-color:var(--blue);color:var(--ink)';
const PICK_INPUT = 'margin:0;width:auto;padding:0';
// .full
const FULL = `width:100%;font-family:${MONO}`;

/** Faster than any identifier is read, so a new reply is never sat on. */
const POLL_MS = 700;

/** How many sweep hits are offered as checkboxes. A full pass would be 65,536. */
const PICK_MAX = 400;

/** One reference gauge. The unit rides with the value, and only when there is one. */
function Ref({ label, v, d, unit }) {
  const t = n(v, d);
  return (
    <div style={REF_CELL}>
      <div class="label">{label}</div>
      <div class="value" style={REF_VALUE}>
        {t}{t !== DASH && unit ? <span class="unit">{unit}</span> : null}
      </div>
    </div>
  );
}

export function Watch() {
  useClockSync();

  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [hits, setHits] = useState([]);
  const [period, setPeriod] = useState('1000');
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState(null);

  // Traces live across polls, so they are refs rather than state: a re-render must
  // not restart a history that took a minute of driving to collect.
  const histRef = useRef({});
  const ageRef = useRef({});
  const keyRef = useRef('');
  const adoptedRef = useRef(false);
  const pollRef = useRef(null);

  useEffect(() => {
    let live = true;

    async function poll() {
      try {
        const j = await (await fetch('/watch/list', { cache: 'no-store' })).json();
        if (!live) return;
        // Adopt what the board is already watching, once. The set survives a reboot
        // and may have been chosen from another phone, so the page has to arrive at
        // whatever is already running rather than assert an empty selection over it.
        if (!adoptedRef.current) {
          adoptedRef.current = true;
          setSel(new Set((j.dids || []).map((d) => d.name)));
          setPeriod(String(j.period));
        }
        // Traces are discarded only when the *set* changes. The firmware rebuilt the
        // markup on every poll to begin with, which replaced the svg elements and
        // left every sparkline permanently empty.
        const key = (j.dids || []).map((d) => d.name).join(',');
        if (key !== keyRef.current) {
          keyRef.current = key;
          histRef.current = {};
          ageRef.current = {};
        }
        pushReadings(histRef.current, ageRef.current, j.dids);
        setData(j);
        setErr(false);
      } catch (e) {
        // The values already on screen stay; only the header changes.
        if (live) setErr(true);
      }
    }

    pollRef.current = poll;
    poll();
    const t = setInterval(poll, POLL_MS);

    // A file loaded on an earlier visit, before the board is asked anything.
    const stored = loadStoredHits();
    if (stored.length) setHits((h) => mergeHits(h, stored));

    // The scanner's results are the natural source of identifiers to watch, so they
    // are offered as checkboxes rather than leaving you to copy hex off another page.
    fetch('/scan/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (live) setHits((h) => mergeHits(h, (j.hits || []).slice(0, PICK_MAX))); })
      .catch(() => { /* no board, no board hits — a loaded file still works */ });

    return () => { live = false; clearInterval(t); };
  }, []);

  const dids = (data && data.dids) || [];
  const max = (data && data.max) || WATCH_MAX;
  const v = (data && data.v) || {};
  const status = watchStatus(data, err);
  const cost = costText(+period, sel.size);

  async function apply(list) {
    setMsg({ cls: 'msg', text: 'applying…' });
    try {
      const r = await (await fetch(
        '/watch/set?period=' + period + '&d=' + encodeURIComponent(list),
        { cache: 'no-store' },
      )).json();
      // Changing the set starts a new trip CSV, because the columns are fixed when
      // the file is opened. Saying so is the difference between that being a
      // documented consequence and it being a surprise in the log.
      setMsg({
        cls: 'msg ok',
        text: r.changed ? `Watching ${r.n}. A new trip CSV was started.`
          : `Watching ${r.n}. Nothing changed.`,
      });
      setTyped('');
      histRef.current = {};
      ageRef.current = {};
      keyRef.current = '';
      if (pollRef.current) pollRef.current();
    } catch (e) {
      setMsg({ cls: 'msg err', text: 'Could not reach the board.' });
    }
  }

  function onApply() {
    const next = addTyped(sel, typed, max);
    setSel(next);
    apply([...next].join(','));
  }

  function onClear() {
    setSel(new Set());
    apply('');
  }

  function toggle(k, on) {
    if (on && sel.size >= max) {
      setMsg({ cls: 'msg err', text: `At most ${max} at a time.` });
      return;                            // the box un-ticks itself on the re-render
    }
    const s = new Set(sel);
    if (on) s.add(k); else s.delete(k);
    setSel(s);
  }

  // Read by the browser's own FileReader. Nothing is uploaded, and the board is
  // never told a file was opened.
  function onFile(e) {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const found = parseCsv(String(r.result));
      setHits((prev) => {
        const merged = mergeHits(prev, found);
        // Kept in the browser so a reload does not send you back to the file picker.
        // A convenience list, not a source of truth — the board owns the hits it
        // found itself, and this never writes to it.
        saveStoredHits(merged);
        return merged;
      });
      setMsg({
        cls: 'msg ok',
        text: found.length ? `Loaded ${found.length} identifiers from ${f.name}.`
          : `No identifiers found in ${f.name}.`,
      });
    };
    r.readAsText(f);
  }

  return (
    <>
      <h2 class="sec">DID watch &middot; service 0x22</h2>

      {/* The shell's own status pill is scaffolding, so the page states its
          connection here, in the firmware page's wording. */}
      <div class="row" style="align-items:center;gap:6px;margin-bottom:10px;font-size:12px;color:var(--ink2)">
        <span class={status.dot} />
        <span>{status.text}</span>
      </div>

      {data && data.scanning && (
        <div class="card">
          <div class="msg warn">A sweep has the bus &mdash; watching is paused until it stops.</div>
        </div>
      )}

      <h2 class="sec">Reference</h2>
      <div class="card">
        <div style={REF}>
          <Ref label="RPM" v={v.rpm} d={0} />
          <Ref label="Speed" v={v.speed} d={0} unit="km/h" />
          <Ref label="Coolant" v={v.coolant} d={0} unit="°C" />
          <Ref label="Intake" v={v.iat} d={0} unit="°C" />
          <Ref label="Load" v={v.load} d={1} unit="%" />
          <Ref label="Throttle" v={v.throttle} d={1} unit="%" />
        </div>
      </div>

      <h2 class="sec">Watching</h2>
      {dids.map((d) => {
        const pts = sparkPoints(histRef.current[d.name] || []);
        return (
          <div style={W} key={d.name}>
            <div style={WH}>
              <span style={WN}>{d.name}</span>
              <span style={WX}>{d.ecu}</span>
              <span class={d.fresh ? '' : 'stale'} style={WV}>
                {d.len ? String(d.val) : DASH}
              </span>
            </div>
            <div style={WX}>
              {d.len
                ? `${d.hex} · ${d.len} byte${d.len > 1 ? 's' : ''}${d.fresh ? '' : ' · stale'}`
                : 'no reply yet'}
            </div>
            {/* One trace per identifier, one point per reading — see series.js. */}
            <svg class="spark" preserveAspectRatio="none" viewBox="0 0 220 26">
              {pts ? (
                <polyline points={pts} fill="none" style="stroke:var(--aqua)"
                          stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
                          vector-effect="non-scaling-stroke" />
              ) : null}
            </svg>
          </div>
        );
      })}
      {!dids.length && (
        <div class="card">
          <div style="color:var(--muted);font-size:14px">
            Nothing being watched. Pick identifiers
            below &mdash; the ones the scanner found are listed for you.
          </div>
        </div>
      )}

      <h2 class="sec">Choose</h2>
      <div class="card">
        <div class="row">
          <div>
            <label for="per">Read one every</label>
            <select id="per" value={period} onChange={(e) => setPeriod(e.currentTarget.value)}>
              <option value="250">250 ms</option>
              <option value="500">500 ms</option>
              <option value="1000">1 s</option>
              <option value="2000">2 s</option>
              <option value="5000">5 s</option>
            </select>
          </div>
          <div style="flex:1;min-width:140px">
            <label for="man">Or type them</label>
            <input type="text" id="man" style={FULL} placeholder="1002, 1003, T0140"
                   value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
          </div>
        </div>

        <div style={PICK}>
          {hits.length ? hits.map((h) => {
            const k = watchName(h);
            const on = sel.has(k);
            return (
              <label key={k} style={on ? PICK_ON : PICK_OFF}>
                <input type="checkbox" style={PICK_INPUT} checked={on}
                       onChange={(e) => toggle(k, e.currentTarget.checked)} />
                {k} <span style="color:var(--muted)">{String(h.hex || '').slice(0, 8)}</span>
              </label>
            );
          }) : (
            <span style="color:var(--muted);font-size:13px">
              No scan results yet &mdash; run a sweep, or type identifiers above.
            </span>
          )}
        </div>

        <div class="hint">
          Identifiers found by a sweep on <em>this</em> board are listed
          above. A <code>did_hits.csv</code> exported from an earlier firmware can be loaded here
          instead &mdash; it stays in this browser, nothing is uploaded.
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
        </div>

        <div class="row" style="margin-top:10px">
          <button onClick={onApply}>Apply</button>
          <button class="ghost" onClick={onClear}>Watch nothing</button>
        </div>

        {msg && <div class={msg.cls}>{msg.text}</div>}
        {cost && <div class="hint">{cost}</div>}

        <div class="hint">
          Each identifier is one more request on the bus, so watching costs
          live refresh rate &mdash; the estimate above is for the transport in use. Readings
          are appended to the trip CSV as two columns each: the bytes decoded big-endian, and
          the raw bytes beside them, because two bytes might equally be one 16-bit value or
          two 8-bit ones and nothing in the reply says which.
          <br /><br />
          Changing the set starts a new CSV. The columns are fixed when a file is opened, and
          shifting them halfway down a file would be worse than having two of them.
        </div>
      </div>
    </>
  );
}

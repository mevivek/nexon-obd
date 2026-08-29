// DID watch. Ported from firmware/Obdurate/watch_html.h.
//
// The scanner finds identifiers that answer; it cannot say what they hold. This
// reads a chosen handful continuously and puts them next to rpm, coolant and load,
// so a value that moves with one of them gives itself away. The same readings go
// into the trip CSV as extra columns for anything too subtle to see by eye.
//
// A note on styling, following Monitors.jsx: watch_html.h's page-local .ref, .w,
// .wh, .wn, .wv, .wx, .pick and .full rules now live in the page section of
// styles.css, so the markup below uses the firmware's own class names.

import { useState, useEffect, useRef } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { useShellStatus } from '../shell.jsx';
import { n, DASH } from '../lib/format.js';
import { parseCsv, mergeHits, watchName, loadStoredHits, saveStoredHits } from './watch/hits.js';
import { pushReadings, sparkPoints } from './watch/series.js';
import { addTyped, costText, fillFrom, WATCH_MAX } from './watch/picker.js';
import { watchStatus } from './watch/status.js';

/** Faster than any identifier is read, so a new reply is never sat on. */
const POLL_MS = 700;

/** How many sweep hits are offered as checkboxes. A full pass would be 65,536. */
const PICK_MAX = 400;

/** One reference gauge. The unit rides with the value, and only when there is one. */
function Ref({ label, v, d, unit }) {
  const t = n(v, d);
  return (
    <div>
      <div class="label">{label}</div>
      <div class="value">
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
  useShellStatus(watchStatus(data, err));
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

  // Take the next unselected hits, in the order they are listed, until the board's
  // cap is reached. Says what it did rather than leaving you to count checkboxes -
  // the whole risk with a bulk control here is ending up watching a set you did not
  // choose, so the number it added is reported every time.
  //
  // Nothing is applied yet: this only ticks boxes. Apply is still a deliberate press,
  // because changing the set rotates the trip CSV.
  function onFill() {
    const { next, added, room } = fillFrom(sel, hits.map(watchName), max);
    if (!room) {
      setMsg({ cls: 'msg err', text: `Already watching ${max}, which is the board's limit.` });
      return;
    }
    setSel(next);
    setMsg({
      cls: 'msg',
      text: added < room
        ? `Added ${added} — that is every identifier on the list.`
        : `Added ${added}. ${hits.length - next.size} more found; untick some and fill again.`,
    });
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
      {data && data.scanning && (
        <div class="card">
          <div class="msg warn">A sweep has the bus &mdash; watching is paused until it stops.</div>
        </div>
      )}

      <h2 class="sec">Reference</h2>
      <div class="card">
        <div class="ref">
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
          <div class="w" key={d.name}>
            <div class="wh">
              <span class="wn">{d.name}</span>
              <span class="wx">{d.ecu}</span>
              <span class={d.fresh ? 'wv' : 'wv stale'}>
                {d.len ? String(d.val) : DASH}
              </span>
            </div>
            <div class="wx">
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
            <input type="text" id="man" class="full" placeholder="1002, 1003, T0140"
                   value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
          </div>
        </div>

        {hits.length ? (
          <div class="row" style="margin:2px 0 8px;align-items:center;gap:8px;flex-wrap:wrap">
            {/* Not "select all". The board watches `max`, a sweep finds hundreds, and
                a control that ticks every box would drop all but a handful without
                saying which ones survived. This says what it will do and then does
                exactly that. */}
            <button class="ghost" onClick={onFill} disabled={sel.size >= max}>
              {sel.size >= max ? `Watching ${max} — full` : `Fill to ${max}`}
            </button>
            <button class="ghost" onClick={() => setSel(new Set())} disabled={!sel.size}>
              Untick all
            </button>
            <span style="color:var(--muted);font-size:12px">
              {sel.size} of {max} chosen · {hits.length} found
            </span>
          </div>
        ) : null}

        <div class="pick">
          {hits.length ? hits.map((h) => {
            const k = watchName(h);
            const on = sel.has(k);
            return (
              <label key={k} class={on ? 'on' : ''}>
                <input type="checkbox" checked={on}
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

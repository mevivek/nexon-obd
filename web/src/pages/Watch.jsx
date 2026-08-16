// DID watch. Ported from firmware/NexonOBD/watch_html.h.
//
// The scanner finds identifiers that answer; it cannot say what they hold. This
// reads a chosen handful continuously and puts them next to rpm, coolant and load,
// so a value that moves with one of them gives itself away. The same readings go
// into the trip CSV as extra columns for anything too subtle to see by eye.

import { useEffect, useRef, useState } from 'preact/hooks';
import { n, DASH } from '../lib/format.js';
import {
  parseCsv, mergeHits, watchName, loadStoredHits, saveStoredHits,
} from './watch/hits.js';
import { pushReadings, sparkPoints } from './watch/series.js';
import { addTyped, costText, WATCH_MAX } from './watch/picker.js';

// The page's own rules, as they were in the firmware's <style> block.
const PAGE_CSS = `
.watch .ref{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.watch .ref div{min-width:0}
.watch .ref .value{font-size:19px}
.watch .w{background:var(--surface);border:1px solid var(--ring);border-radius:12px;
padding:10px 12px;margin-bottom:8px;overflow:hidden}
.watch .wh{display:flex;align-items:baseline;gap:8px}
.watch .wn{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;
font-weight:650}
.watch .wv{margin-left:auto;font-size:22px;font-weight:650;letter-spacing:-.02em;
font-variant-numeric:tabular-nums}
.watch .wx{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;
color:var(--muted)}
.watch .pick{display:flex;flex-wrap:wrap;gap:6px;max-height:210px;overflow-y:auto;
margin-top:9px;padding:2px}
.watch .pick label{display:flex;align-items:center;gap:5px;margin:0;padding:5px 8px;
background:var(--raised);border:1px solid var(--base);border-radius:8px;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;
font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink2);cursor:pointer}
.watch .pick label.on{border-color:var(--blue);color:var(--ink)}
.watch .pick input{margin:0;width:auto;padding:0}
.watch .full{width:100%!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
`;

/** Faster than any identifier is read, so a new reply is never sat on. */
const POLL_MS = 700;

/** The hits offered as checkboxes. A full sweep would otherwise be 65,536 of them. */
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
  const [st, setSt] = useState(null);
  const [dead, setDead] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [hits, setHits] = useState([]);
  const [per, setPer] = useState('1000');
  const [man, setMan] = useState('');
  const [msg, setMsg] = useState(null);

  // Traces live across polls, so they are refs: re-rendering must not restart a
  // history that took a minute of driving to collect.
  const histRef = useRef({});
  const ageRef = useRef({});
  const keyRef = useRef('');
  const appliedRef = useRef(false);
  const pollRef = useRef(null);

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const j = await (await fetch('/watch/list', { cache: 'no-store' })).json();
        if (!alive) return;
        if (!appliedRef.current) {       // adopt what the board is already watching, once
          appliedRef.current = true;
          setSel(new Set((j.dids || []).map((d) => d.name)));
          setPer(String(j.period));
        }
        // Reset the traces only when the *set* changes. The firmware rebuilt the
        // markup on every poll otherwise, which replaced the svg elements and left
        // every sparkline permanently empty.
        const key = (j.dids || []).map((d) => d.name).join(',');
        if (key !== keyRef.current) {
          keyRef.current = key;
          histRef.current = {};
          ageRef.current = {};
        }
        pushReadings(histRef.current, ageRef.current, j.dids);
        setSt(j);
        setDead(false);
      } catch (e) {
        if (alive) setDead(true);
      }
    }

    pollRef.current = poll;
    poll();
    const id = setInterval(poll, POLL_MS);

    // A file loaded earlier, before the board is asked anything.
    const stored = loadStoredHits();
    if (stored.length) setHits((h) => mergeHits(h, stored));

    // The scanner's results are the natural source of identifiers to watch, so they
    // are offered as checkboxes rather than leaving you to copy hex off another page.
    fetch('/scan/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setHits((h) => mergeHits(h, (j.hits || []).slice(0, PICK_MAX))); })
      .catch(() => {});

    // The board has no clock of its own. Whichever page you open hands over the
    // time, so anything it records carries a real timestamp.
    fetch('/time?ms=' + Date.now(), { cache: 'no-store' }).catch(() => {});

    return () => { alive = false; clearInterval(id); };
  }, []);

  const dids = (st && st.dids) || [];
  const max = (st && st.max) || WATCH_MAX;
  const v = (st && st.v) || {};
  const scanning = !!(st && st.scanning);

  const state = dead ? 'ESP32 unreachable'
    : scanning ? 'paused — scanning'
      : dids.length ? `${dids.length} watched` : 'idle';
  const dot = dead ? 'dead' : dids.length ? (scanning ? 'stale' : 'live') : '';

  async function apply(list) {
    setMsg({ cls: 'msg', text: 'applying…' });
    try {
      const r = await (await fetch(
        '/watch/set?period=' + per + '&d=' + encodeURIComponent(list),
        { cache: 'no-store' },
      )).json();
      setMsg({
        cls: 'msg ok',
        text: r.changed ? `Watching ${r.n}. A new trip CSV was started.`
          : `Watching ${r.n}. Nothing changed.`,
      });
      setMan('');
      histRef.current = {};
      ageRef.current = {};
      keyRef.current = '';
      if (pollRef.current) pollRef.current();
    } catch (e) {
      setMsg({ cls: 'msg err', text: 'Could not reach the board.' });
    }
  }

  function onApply() {
    const next = addTyped(sel, man, max);
    setSel(next);
    apply([...next].join(','));
  }

  function onClear() {
    setSel(new Set());
    apply('');
  }

  function toggle(k, checked) {
    if (checked) {
      if (sel.size >= max) { setMsg({ cls: 'msg err', text: `At most ${max} at a time.` }); return; }
      const s = new Set(sel); s.add(k); setSel(s);
    } else {
      const s = new Set(sel); s.delete(k); setSel(s);
    }
  }

  // Read by the browser's own FileReader and kept in the browser. Nothing is
  // uploaded, and the board is never told a file was opened.
  function onFile(e) {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const found = parseCsv(String(r.result));
      setHits((prev) => {
        const merged = mergeHits(prev, found);
        // Kept so a reload does not send you back to the file picker. This is a
        // convenience list, not a source of truth — the board owns the hits it
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

  const cost = costText(+per, sel.size);

  return (
    <div class="watch">
      <style>{PAGE_CSS}</style>

      <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
        <span class="sub">service 0x22</span>
        <div class="status"><span class={'dot ' + dot} /><span>{state}</span></div>
      </div>

      {scanning && (
        <div class="card">
          <div class="msg warn">A sweep has the bus — watching is paused until it stops.</div>
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
      <div>
        {dids.map((d) => {
          const pts = sparkPoints(histRef.current[d.name] || []);
          return (
            <div class="w" key={d.name}>
              <div class="wh">
                <span class="wn">{d.name}</span>
                <span class="wx">{d.ecu}</span>
                <span class={'wv' + (d.fresh ? '' : ' stale')}>
                  {d.len ? String(d.val) : DASH}
                </span>
              </div>
              <div class="wx">
                {d.len
                  ? `${d.hex} · ${d.len} byte${d.len > 1 ? 's' : ''}${d.fresh ? '' : ' · stale'}`
                  : 'no reply yet'}
              </div>
              <svg class="spark" preserveAspectRatio="none" viewBox="0 0 220 26">
                {pts && (
                  <polyline points={pts} fill="none" style="stroke:var(--aqua)"
                            stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
                            vector-effect="non-scaling-stroke" />
                )}
              </svg>
            </div>
          );
        })}
      </div>
      {!dids.length && (
        <div class="card">
          <div style="color:var(--muted);font-size:14px">
            Nothing being watched. Pick identifiers below — the ones the scanner found
            are listed for you.
          </div>
        </div>
      )}

      <h2 class="sec">Choose</h2>
      <div class="card">
        <div class="row">
          <div>
            <label for="per">Read one every</label>
            <select id="per" value={per} onChange={(e) => setPer(e.currentTarget.value)}>
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
                   value={man} onInput={(e) => setMan(e.currentTarget.value)} />
          </div>
        </div>

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
              No scan results yet — run a sweep, or type identifiers above.
            </span>
          )}
        </div>

        <div class="hint">
          Identifiers found by a sweep on <em>this</em> board are listed
          above. A <code>did_hits.csv</code> exported from an earlier firmware can be loaded here
          instead — it stays in this browser, nothing is uploaded.
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
          live refresh rate — the estimate above is for the transport in use. Readings
          are appended to the trip CSV as two columns each: the bytes decoded big-endian, and
          the raw bytes beside them, because two bytes might equally be one 16-bit value or
          two 8-bit ones and nothing in the reply says which.
          <br /><br />
          Changing the set starts a new CSV. The columns are fixed when a file is opened, and
          shifting them halfway down a file would be worse than having two of them.
        </div>
      </div>
    </div>
  );
}

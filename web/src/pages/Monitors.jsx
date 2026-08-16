// Mode 06 on-board monitor results. Ported from firmware/NexonOBD/mon_html.h.
//
// Mode 06 is a read, like everything else here. The ECU reports what each of its
// own monitors measured and the limits it judges that against, so this page can say
// how close a system is to failing rather than only whether a fault has already
// been stored.
//
// A note on styling: mon_html.h carried a page-local <style> block for .mon, .badge,
// .win and .lim, none of which is in the shared stylesheet. Rather than add rules to
// styles.css — which is ported verbatim from ui_css.h and is not this port's to
// change — those four are reproduced as inline style attributes, byte for byte from
// the firmware's declarations.

import { useState, useEffect } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { MON_POLL_MS, monFmt, monName, monNote, monStatus, monWindow } from './monitors/monitors.js';

// .mon — wider than the shared .tiles minimum, because each tile carries a window
// bar and two limit figures rather than one number.
const GRID = 'grid-template-columns:repeat(auto-fit,minmax(250px,1fr))';

// .badge, plus the .ok/.bad pair.
const BADGE = 'float:right;font-size:10px;font-weight:650;text-transform:uppercase;'
  + 'letter-spacing:.07em;padding:2px 7px;border-radius:999px;';
const BADGE_OK = BADGE + 'background:rgba(47,191,95,.16);color:var(--good)';
const BADGE_BAD = BADGE + 'background:rgba(239,75,75,.16);color:var(--critical)';

// .win and its two children.
const WIN = 'position:relative;height:8px;margin:11px 0 6px;background:var(--base);'
  + 'border-radius:4px';
const WIN_U = 'position:absolute;left:0;top:0;width:100%;height:8px;border-radius:4px;'
  + 'background:rgba(75,155,255,.30)';
const WIN_I = 'position:absolute;top:-3px;width:3px;height:14px;border-radius:2px;'
  + 'background:var(--ink);';

// .lim
const LIM = 'display:flex;justify-content:space-between;font-size:11px;'
  + 'color:var(--muted);font-variant-numeric:tabular-nums';

const SEP = 'color:var(--base)';

function MonitorTile({ r }) {
  const { pass, pos } = monWindow(r);
  return (
    <div class="tile">
      <div class="label">
        {monName(r.mid)} <span style={SEP}>&middot;</span> test {r.tid}
        <span style={pass ? BADGE_OK : BADGE_BAD}>{pass ? 'pass' : 'fail'}</span>
      </div>
      <div class="value">{monFmt(r.v, r.uas)}</div>
      <div style={WIN}>
        <u style={WIN_U} />
        <i style={WIN_I + 'left:calc(' + pos.toFixed(1) + '% - 1px)'} />
      </div>
      <div style={LIM}>
        <span>min {monFmt(r.lo, r.uas)}</span>
        <span>max {monFmt(r.hi, r.uas)}</span>
      </div>
      <div class="note">
        {monNote(r)} <span style={SEP}>&middot;</span> uas {r.uas}
      </div>
    </div>
  );
}

export function Monitors() {
  useClockSync();

  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  // Results only refresh while this page is open — which is also what arms the
  // board: a request to /mon buys MON_WANTED_MS of discovery and reading (see
  // monStep() in NexonOBD.ino). So the interval is the page's half of that
  // handshake, and stopping it on unmount is what lets the bus go back to the
  // values that move now.
  useEffect(() => {
    let live = true;
    async function poll() {
      try {
        const j = await (await fetch('/mon', { cache: 'no-store' })).json();
        if (!live) return;
        setData(j);
        setErr(false);
      } catch (e) {
        // The last results stay on screen; only the header changes. A dropped poll
        // does not mean the numbers it already showed became untrue.
        if (live) setErr(true);
      }
    }
    poll();
    const t = setInterval(poll, MON_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  const recs = (data && data.recs) || [];
  const status = monStatus(data, err);

  return (
    <>
      <h2 class="sec">Monitors &middot; mode 06</h2>

      {/* The shell's own status pill is scaffolding, so the page states its
          connection here, in the firmware page's wording. */}
      <div class="row" style="align-items:center;gap:6px;margin-bottom:10px;font-size:12px;color:var(--ink2)">
        <span class={status.dot} />
        <span>{status.text}</span>
      </div>

      <div class="card">
        <div class="hint" style="margin-top:0">
          The ECU's own test results, each with the limits it is judged against
          &mdash; so a pass with almost no headroom is visible long before it becomes
          a fault code.
        </div>
      </div>

      <details>
        <summary>How to read this</summary>
        <div class="hint">
          <b style="color:var(--ink2)">Pass and headroom do not depend on knowing the units.</b>{' '}
          A test passes when its value sits inside its own limits, and the bar shows
          where in that window it sits. The raw numbers and the unit-and-scaling id
          are shown as reported; that table is long and only partly documented, so
          nothing here pretends to convert values it cannot.<br /><br />
          Monitor names come from J1979 and only the unambiguous ids are named
          &mdash; anything else keeps its raw id rather than being given a label that
          might be wrong.<br /><br />
          Results only refresh while this page is open. Monitors move over minutes,
          and polling them continuously would take bus time from the values that move
          now.
        </div>
      </details>

      <div class="tiles" style={GRID}>
        {recs.map((r) => <MonitorTile key={r.mid + r.tid} r={r} />)}
      </div>

      {!recs.length && (
        <div class="card" style="margin-top:10px">
          <div style="color:var(--muted);font-size:14px">
            Nothing reported yet. The board discovers which monitors exist, then reads
            them one at a time &mdash; give it a few seconds with the ignition on.
          </div>
        </div>
      )}
    </>
  );
}

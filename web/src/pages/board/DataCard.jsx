// Take it off the board, put it back, or clear it.
//
// A reset button without a backup button beside it is a way to lose a week, so
// they are on one card in that order. The board's endpoints are a list, a reader
// and a writer; everything else - the archive, the manifest, the check that a
// register belongs to the engine it is about to describe - happens here, because
// the board has one core and a car to poll while it serves you.

import { useState, useEffect, useRef } from 'preact/hooks';
import { zipStored, unzipStored, entryText, textBytes } from '../../lib/zip.js';
import {
  MANIFEST, buildManifest, backupName, restoreCheck, restorePlan,
  restoreResultText, summarise,
} from './backup.js';
import { kb } from '../trips/trips.js';
import { IconAlert } from '../../icons.jsx';

/** Hand the finished archive to the browser. Same shape as a trip CSV download. */
function save(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn: revoking synchronously races the click on Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function DataCard({ veh, fw, web }) {
  const [files, setFiles] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');           // '' | 'backup' | 'restore' | 'reset'
  const [msg, setMsg] = useState({ cls: '', text: '' });

  // The restore, staged: chosen, checked, and only then written.
  const [pending, setPending] = useState(null);   // {entries, manifest, check, plan}
  const [override, setOverride] = useState(false);
  const [arm, setArm] = useState('');             // which reset scope is armed
  const picker = useRef(null);

  const load = () => {
    fetch('/files', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { setFiles(j); setErr(null); })
      .catch((e) => setErr(String(e)));
  };
  useEffect(load, []);

  const names = (files && files.files ? files.files : []).map((f) => f.name);
  const bytes = (files && files.files ? files.files : []).reduce((n, f) => n + f.size, 0);

  async function backup() {
    setBusy('backup');
    setMsg({ cls: 'warn', text: 'Reading files off the board…' });
    try {
      const entries = [];
      for (const f of files.files) {
        const r = await fetch('/file?f=' + encodeURIComponent(f.name), { cache: 'no-store' });
        if (!r.ok) throw new Error(`${f.name}: ${r.status}`);
        entries.push({ name: f.name.replace(/^\//, ''), data: new Uint8Array(await r.arrayBuffer()) });
      }
      const at = new Date();
      const manifest = buildManifest(veh, { fw, web }, names, at.toISOString());
      entries.unshift({ name: MANIFEST, data: textBytes(JSON.stringify(manifest, null, 2)) });

      const zip = zipStored(entries, at);
      save(zip, backupName(manifest.key, at));
      setMsg({
        cls: 'ok',
        text: `Saved ${summarise(names)} — ${kb(zip.length)}.`
            + (manifest.key ? '' : ' No car was identified, so this archive cannot be checked against a board on restore.'),
      });
    } catch (e) {
      // Faithful: a partial archive is not offered at all, and the failure says
      // which file it stopped on.
      setMsg({ cls: 'err', text: 'Backup failed, nothing was saved: ' + e.message });
    }
    setBusy('');
  }

  async function choose(e) {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    setPending(null);
    setOverride(false);
    setMsg({ cls: '', text: '' });
    if (!f) return;
    try {
      const entries = unzipStored(new Uint8Array(await f.arrayBuffer()));
      const m = entries.find((x) => x.name === MANIFEST);
      let manifest = null;
      try { manifest = m ? JSON.parse(entryText(m)) : null; } catch (_) { manifest = null; }
      const check = restoreCheck(manifest, veh);
      const plan = restorePlan(entries.map((x) => x.name));
      setPending({ entries, manifest, check, plan, file: f.name });
    } catch (ex) {
      setMsg({ cls: 'err', text: ex.message });
    }
  }

  async function restore() {
    if (!pending) return;
    setBusy('restore');
    const results = [];
    for (const name of pending.plan.write) {
      const e = pending.entries.find((x) => x.name === name);
      setMsg({ cls: 'warn', text: 'Writing ' + name + '…' });
      try {
        const fd = new FormData();
        fd.append('data', new Blob([e.data]), name.replace(/^\//, ''));
        const r = await fetch('/file/put', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        results.push({ name, ok: !!j.ok, error: j.error || ('HTTP ' + r.status) });
      } catch (ex) {
        results.push({ name, ok: false, error: String(ex) });
      }
    }
    const bad = results.some((r) => !r.ok);
    setMsg({ cls: bad ? 'err' : 'ok', text: restoreResultText(results) });
    setPending(null);
    setOverride(false);
    if (picker.current) picker.current.value = '';
    setBusy('');
    load();
  }

  async function reset(scope) {
    setBusy('reset');
    setMsg({ cls: 'warn', text: 'Erasing…' });
    try {
      const r = await fetch(`/reset?scope=${scope}&confirm=yes`, { cache: 'no-store' });
      const j = await r.json();
      setMsg(j.ok
        ? { cls: 'ok', text: `Erased ${j.files} file${j.files === 1 ? '' : 's'}`
              + (j.bundle ? ' and the dashboard bundle' : '')
              + '. The board is rebooting — reload in a few seconds.' }
        : { cls: 'err', text: 'Reset refused: ' + (j.error || 'unknown') });
    } catch (e) {
      // The board reboots as soon as it has replied, so a dropped connection here
      // is expected rather than a failure - and saying otherwise would send
      // somebody looking for a problem that is not there.
      setMsg({ cls: 'ok', text: 'The board stopped answering, which is what it does after a reset. Reload in a few seconds.' });
    }
    setArm('');
    setBusy('');
  }

  const can = pending && pending.check.ok && (!pending.check.needsConfirm || override);

  return (
    <div class="card">
      <h2 class="sec">Backup</h2>
      <div class="hint" style="margin-top:0">
        A sweep is over half an hour on CAN, the register behind it takes drives to
        build, and the trip logs are the drives. The archive is assembled in this
        browser, uncompressed, so it opens with anything.
      </div>
      {err ? <div class="msg err">Could not list the board's files: {err}</div> : null}
      {files ? (
        <div class="note" style="margin-top:10px">
          {names.length
            ? `On the board: ${summarise(names)} — ${kb(bytes)}, ${kb(files.free)} free.`
            : `Nothing to back up yet. ${kb(files.free)} free.`}
        </div>
      ) : null}
      <div class="btns">
        <button disabled={!files || !names.length || busy !== ''} onClick={backup}>
          Download backup
        </button>
      </div>

      <h2 class="sec">Restore</h2>
      <input ref={picker} type="file" accept=".zip" onChange={choose} disabled={busy !== ''} />

      {pending ? (
        <>
          <div class={'msg ' + (pending.check.ok ? (pending.check.needsConfirm ? 'warn' : 'ok') : 'err')}>
            {pending.check.text}
          </div>
          <div class="note">
            {pending.plan.write.length
              ? `Would write ${summarise(pending.plan.write)}, over anything already on the board with the same name.`
              : 'Nothing in this archive can be written to the board.'}
          </div>
          {pending.plan.skip.length ? (
            <div class="note">
              Skipped, because this firmware has no such file: {pending.plan.skip.join(', ')}.
            </div>
          ) : null}

          {pending.check.needsConfirm ? (
            <label class="pick" style="display:block;margin-top:10px">
              <input type="checkbox" checked={override}
                     onChange={(e) => setOverride(e.currentTarget.checked)} />
              {' '}I have checked this backup is from this car
            </label>
          ) : null}

          <div class="btns">
            <button disabled={!can || !pending.plan.write.length || busy !== ''} onClick={restore}>
              Restore {pending.plan.write.length} file{pending.plan.write.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      ) : (
        <div class="hint">
          Restoring writes over files of the same name. The register and the sweep
          are checked against this car first — a mismatch is refused, because a
          register from another engine would attach without saying so.
        </div>
      )}

      <h2 class="sec">Erase</h2>
      <div class="caution">
        <IconAlert />
        <div>
          Neither scope touches the firmware, and neither writes to the car. Both
          reboot the board.
        </div>
      </div>
      <div class="hint">
        <b>Data</b> clears the trips, the sweep's hits, the register and the vehicle
        identity. The dashboard stays, so this page still works afterwards.<br /><br />
        <b>Everything</b> also removes the dashboard bundle, leaving the built-in
        fallback page. Recoverable with <code>web/deploy.sh</code> or <code>/ui</code>,
        but not from a phone at the roadside.
      </div>
      <div class="btns">
        {['data', 'all'].map((scope) => (
          <button key={scope} disabled={busy !== ''}
                  onClick={() => (arm === scope ? reset(scope) : setArm(scope))}>
            {arm === scope
              ? (scope === 'data' ? 'Really erase the data?' : 'Really erase everything?')
              : (scope === 'data' ? 'Erase data' : 'Erase everything')}
          </button>
        ))}
      </div>
      {arm ? (
        <div class="note">Press again to confirm, or leave this page to cancel.</div>
      ) : null}

      <div class={'msg ' + msg.cls}>{msg.text}</div>
    </div>
  );
}

// The one prompt that appears on every screen.
//
// A board plugged into a car it is not bound to keeps showing live readings and
// records nothing. That is the right behaviour and it is also invisible - the
// dashboard looks completely normal while no trip log is being written - so the
// choice has to follow you around rather than waiting on a settings page nobody
// opens until they wonder why a drive went missing.
//
// It appears ONLY for a proven mismatch. A car that has not identified itself is
// recording normally and has nothing to decide, and a banner on every drive would
// train people to dismiss the one that matters.

import { useState, useEffect } from 'preact/hooks';
import { needsChoice, holdsText, headline, canAdopt, adoptBlockedWhy } from './car.js';
import { IconAlert } from '../../icons.jsx';

export function CarBanner() {
  const [car, setCar] = useState(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    let timer = null;
    const read = () => {
      fetch('/car', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (live) setCar(j); })
        .catch(() => {})
        .finally(() => { if (live) timer = setTimeout(read, 5000); });
    };
    read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);

  if (!needsChoice(car) || dismissed) return null;

  async function adopt() {
    setBusy(true);
    setMsg('Erasing and rebinding…');
    try {
      const r = await fetch('/car/adopt?confirm=yes&start=yes', { cache: 'no-store' });
      const j = await r.json();
      setMsg(j.ok
        ? `Bound to ${j.bound}. The board is rebooting and will start a sweep — reload in a few seconds.`
        : 'Refused: ' + (j.error || 'unknown'));
    } catch (e) {
      // It reboots the moment it has replied, so a dropped connection here is the
      // expected ending rather than a failure.
      setMsg('The board stopped answering, which is what it does after rebinding. Reload in a few seconds.');
    }
    setBusy(false);
  }

  async function keep() {
    setBusy(true);
    try { await fetch('/car/keep', { cache: 'no-store' }); } catch (e) { /* nothing to report */ }
    setBusy(false);
    setDismissed(true);
  }

  return (
    <div class="card">
      <div class="caution">
        <IconAlert />
        <div>
          <b>{headline(car)}</b>
          <br />
          This board holds data for another car ({car.bound}), and this one is {car.seen || 'unidentified'}.
          Live readings work. Nothing is being recorded — no trips, no sweep, no register — because
          two cars in one set of files is wrong in a way nothing afterwards can detect.
        </div>
      </div>

      <div class="hint">{holdsText(car)}</div>
      {!canAdopt(car) ? <div class="msg warn">{adoptBlockedWhy(car)}</div> : null}

      <div class="btns">
        {/* Keep is first and is the safe one. Adopt is irreversible and arms before
            it fires, so a mis-tap at the roadside costs a second rather than a
            register that took drives to build. */}
        <button disabled={busy} onClick={keep}>Keep the other car</button>
        <button disabled={busy || !canAdopt(car)}
                onClick={() => (armed ? adopt() : setArmed(true))}>
          {armed ? 'Erase and adopt this car?' : 'Onboard this car'}
        </button>
      </div>
      {armed ? <div class="note">Press again to confirm. This cannot be undone.</div> : null}
      {msg ? <div class="msg">{msg}</div> : null}
    </div>
  );
}

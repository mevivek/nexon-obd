// The shell's status pill, filled in by whichever page is on screen.
//
// Every firmware page carries the same header: a title, a subtitle, and a pill on
// the right with a coloured dot and a few words about the connection. In the SPA
// the header belongs to the shell, so the pages cannot render it — but they are the
// only things that know what it should say. This is the one wire between them.
//
// Two contexts rather than one, on purpose. The Live page reports a new status
// eight times a second (the Hz readout moves with every poll), and a single context
// carrying `{status, setStatus}` would hand every consumer a new object each time —
// so Live would re-render itself once for its own sample and again for the header
// it just updated, at 8 Hz, on a phone wedged in a car. Splitting them means the
// setter's identity never changes, so pages subscribe to nothing, and only the
// header re-renders when the status does.

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

/** Write side. Stable for the life of the shell, so writers never re-render. */
const SetCtx = createContext(null);

/** Read side. Changes with the status, so only the header subscribes to it. */
const ValueCtx = createContext(null);

/**
 * Owns the reported status and provides both halves of it.
 *
 * `children` comes from the shell above and is unchanged by a status update, so
 * Preact skips the routed page entirely when only the pill has moved.
 */
export function ShellStatus({ children }) {
  const [status, setStatus] = useState(null);
  return (
    <SetCtx.Provider value={setStatus}>
      <ValueCtx.Provider value={status}>{children}</ValueCtx.Provider>
    </SetCtx.Provider>
  );
}

/**
 * Report this page's header status.
 *
 * @param {{dot?: string, text?: string, extra?: string, sub?: string}} status
 *   `dot` is the full class for the dot span — 'dot', 'dot live', 'dot stale',
 *   'dot dead' — which is the shape the page-level status helpers already return.
 *   `text` is the wording beside it; a page that reports none (the firmware's
 *   /update has no pill) gets no pill. `extra` is the muted trailer Live uses for
 *   its Hz readout. `sub` is the detail after the version in the subtitle, for the
 *   two pages whose detail is not a constant — Live's transport and the running
 *   firmware version on the update page.
 */
export function useShellStatus(status) {
  const set = useContext(SetCtx);
  const dot = status && status.dot;
  const text = status && status.text;
  const extra = status && status.extra;
  const sub = status && status.sub;

  useEffect(() => {
    if (set) set({ dot, text, extra, sub });
  }, [set, dot, text, extra, sub]);

  // Cleared on unmount only, so a page changing its own status does not blank the
  // pill for a frame on the way through. Preact runs this cleanup before the next
  // page's effects, so the incoming page's first report is not undone by the
  // outgoing page's last one.
  useEffect(() => () => { if (set) set(null); }, [set]);
}

/** The reported status, for the header. Null before any page has reported one. */
export function useShellStatusValue() {
  return useContext(ValueCtx);
}

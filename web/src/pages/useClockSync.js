// Hand the board the browser's clock, once, when a page mounts.
//
// Ported from the identical three lines at the top of every firmware page's script
// (mon_html.h, trip_html.h, ota_html.h, and the rest):
//
//   // The board has no clock of its own. Whichever page you open hands over the
//   // time, so anything it records carries a real timestamp.
//   fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
//
// In the SPA it lives in one place rather than six, but the contract is unchanged:
// *every* page sends it, because whichever page you happen to open is the board's
// only chance to learn the time, and a trip that starts before you open one writes
// its first rows with an unset clock (trip_html.h, "Rows carry both wall-clock time
// and uptime").
//
// Once per mount, not per poll: the board only needs telling once, and the fetch is
// fire-and-forget — a failure here must never surface as a page error, because the
// page is still perfectly usable on a board that does not know what time it is.

import { useEffect } from 'preact/hooks';

/** Send the browser clock to the board once, on mount. */
export function useClockSync() {
  useEffect(() => {
    fetch('/time?ms=' + Date.now(), { cache: 'no-store' }).catch(() => {});
  }, []);
}

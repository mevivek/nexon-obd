// The shell: header, nav, and the routed page area.
//
// The header is the one piece of chrome the pages do not own. Each firmware page
// printed its own — the same bar, with its own <h1>, its own subtitle detail and its
// own status pill — and here there is exactly one of each: the title and the static
// half of the subtitle come from routes.js, and the pill (plus the two dynamic
// subtitle details) is reported by whichever page is on screen, through shell.jsx.

import { useRoute, currentPath } from './router.js';
import { ROUTES } from './routes.js';
import { ShellStatus, useShellStatusValue } from './shell.jsx';

import { Live } from './pages/Live.jsx';
import { Monitors } from './pages/Monitors.jsx';
import { Trips } from './pages/Trips.jsx';
import { Watch } from './pages/Watch.jsx';
import { Scanner } from './pages/Scanner.jsx';
import { Firmware } from './pages/Firmware.jsx';

// The web bundle carries its own version, independent of the firmware's FW_VERSION.
// Vite inlines this at build time from package.json.
const WEB_VERSION = __WEB_VERSION__;

// Keyed by the same paths routes.js pins against the firmware's nav.
const PAGES = {
  '/': Live,
  '/monitors': Monitors,
  '/trips': Trips,
  '/watch': Watch,
  '/scan': Scanner,
  '/update': Firmware,
};

function Nav({ path }) {
  return (
    <nav>
      {ROUTES.map((r) => (
        <a key={r.path} class={path === r.path ? 'on' : ''} href={'#' + r.path}>
          {r.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * Title, subtitle and the single status pill.
 *
 * Its own component because it is the only thing that reads the reported status —
 * so a page updating the pill re-renders this bar and nothing else.
 */
function Bar({ route }) {
  const status = useShellStatusValue();
  // A page's own detail wins over the route's constant one: Live names the
  // transport it is talking over, and the update page names the running firmware.
  const detail = (status && status.sub) || route.sub;

  return (
    <div class="bar">
      <h1>{route.title}</h1>
      {/* The subtitle carries the version on every page — see ui.css, where the
          rule that hides it below 360px lives. */}
      <span class="sub">web v{WEB_VERSION}{detail ? ' · ' + detail : ''}</span>
      {/* No pill until a page reports one, and none at all for a page that has no
          connection to report — ota_html.h has no pill either. */}
      {status && status.text ? (
        <div class="status">
          <span class={status.dot || 'dot'} />
          <span>{status.text}</span>
          {status.extra ? <span style="color:var(--muted)">{status.extra}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const path = useRoute();
  // An unknown hash lands on Live rather than on nothing: the bundle is opened off
  // a bookmark or a stale QR code as often as from the nav.
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
  const Page = PAGES[route.path] || Live;

  return (
    <ShellStatus>
      <header>
        <Bar route={route} />
        <Nav path={path} />
      </header>
      <div class="wrap">
        <Page />
      </div>
    </ShellStatus>
  );
}

export { currentPath };

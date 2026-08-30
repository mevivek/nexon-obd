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
import { TripDetail } from './pages/TripDetail.jsx';
import { tripFromPath } from './pages/trips/trips.js';
import { CarBanner } from './pages/board/CarBanner.jsx';
import {
  IconGauge, IconPulse, IconRoute, IconTarget, IconSearch, IconChip,
} from './icons.jsx';

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

// Kept out of routes.js on purpose: that module is plain data so it can be asserted
// against the firmware's own <nav> without pulling Preact into the test.
const ICONS = {
  '/': IconGauge,
  '/monitors': IconPulse,
  '/trips': IconRoute,
  '/watch': IconTarget,
  '/scan': IconSearch,
  '/update': IconChip,
};

/**
 * The tab bar, fixed to the bottom of the screen.
 *
 * It used to be a scrolling strip at the top. This is a phone held in one hand in a
 * car, and the top of a handset is the furthest point from the thumb holding it —
 * so every tab lived in the one place you cannot reach without shifting your grip.
 *
 * `active` rather than `path` because a screen can belong to a tab without being
 * it: the trip detail view is under Trips and lights Trips up.
 */
function Nav({ active }) {
  return (
    <nav>
      {ROUTES.map((r) => {
        const Icon = ICONS[r.path];
        return (
          <a key={r.path} class={active === r.path ? 'on' : ''} href={'#' + r.path}>
            {Icon ? <Icon /> : null}
            <span>{r.label}</span>
          </a>
        );
      })}
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
      {/* Title over subtitle, so the pill owns the right-hand side outright and a
          long transport string cannot push the version off a narrow screen. */}
      <div class="id">
        <h1>{route.title}</h1>
        {/* The subtitle carries the version on every page — see ui.css, where the
            rule that hides it below 360px lives. */}
        <span class="sub">web v{WEB_VERSION}{detail ? ' · ' + detail : ''}</span>
      </div>
      {/* No pill until a page reports one, and none at all for a page that has no
          connection to report — ota_html.h has no pill either. */}
      {status && status.text ? (
        <div class="status">
          <span class={status.dot || 'dot'} />
          <span>{status.text}</span>
          {status.extra ? <span class="muted">{status.extra}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const path = useRoute();

  // One screen is not a tab: a trip's detail view hangs off /trips rather than
  // taking a seventh place in the bar, so it is matched before the tab lookup and
  // then borrows the Trips tab's identity — the title, and the tab that lights up.
  // tripFromPath returns null for anything malformed, which falls through to the
  // list rather than to a blank screen.
  const trip = tripFromPath(path);

  // An unknown hash lands on Live rather than on nothing: the bundle is opened off
  // a bookmark or a stale QR code as often as from the nav.
  const route = trip
    ? ROUTES.find((r) => r.path === '/trips')
    : ROUTES.find((r) => r.path === path) || ROUTES[0];
  const Page = PAGES[route.path] || Live;

  return (
    <ShellStatus>
      {/* The header stays sticky at the top and the bar is fixed at the bottom; the
          document between them is what scrolls. Body padding in ui.css keeps the
          last card clear of the bar. */}
      <header>
        <Bar route={route} />
      </header>
      <div class="wrap">
        {/* Above the page, on every page. A board in a car it is not bound to looks
            completely normal - live values, no errors - while it writes nothing
            down, so the choice has to follow you rather than wait on a settings
            screen nobody opens until a drive has gone missing. It renders nothing
            at all unless there is a proven mismatch. */}
        <CarBanner />
        {trip ? <TripDetail name={trip} /> : <Page />}
      </div>
      <Nav active={route.path} />
    </ShellStatus>
  );
}

export { currentPath };

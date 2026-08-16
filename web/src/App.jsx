// The shell: header, nav, and the routed page area.
//
// Scaffolding only for now. The six routes exist and the shell is real — the pages
// themselves are still the firmware's, and get ported one at a time.

import { useRoute, currentPath } from './router.js';
import { ROUTES } from './routes.js';

// The web bundle carries its own version, independent of the firmware's FW_VERSION.
// Vite inlines this at build time from package.json.
const WEB_VERSION = __WEB_VERSION__;

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

function Placeholder({ route }) {
  return (
    <>
      <h2 class="sec">{route.label}</h2>
      <div class="card">
        <div class="label" style="margin:0 0 3px">Not ported yet</div>
        <div style="font-size:13px;color:var(--ink2)">
          The shell, the routing and the shared library are in place. This page is
          still served by the firmware at <code>{route.path}</code> — it moves here
          in a later step.
        </div>
      </div>
    </>
  );
}

export function App() {
  const path = useRoute();
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];

  return (
    <>
      <header>
        <div class="bar">
          <h1>Nexon Live</h1>
          {/* The subtitle carries the version on every page — see ui.css, where the
              rule that hides it below 360px lives. */}
          <span class="sub">web v{WEB_VERSION}</span>
          <div class="status">
            <span class="dot" />
            <span>scaffold</span>
          </div>
        </div>
        <Nav path={path} />
      </header>
      <div class="wrap">
        <Placeholder route={route} />
      </div>
    </>
  );
}

export { currentPath };

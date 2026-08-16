// Hash routing, ~30 lines instead of a dependency.
//
// Hash rather than history: the bundle is served off LittleFS by a WebServer that
// has no SPA rewrite rule, so `/w/trips` would be a 404 while `/w/#/trips` is the
// same document every time. It also means the build opens straight off disk during
// development, which is how the firmware pages are looked at today.

import { useState, useEffect } from 'preact/hooks';

/** Current route path, always leading-slashed. '' becomes '/'. */
export function currentPath() {
  const h = location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : '/' + h;
}

/** Subscribe to hash changes. Returns the current path. */
export function useRoute() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => setPath(currentPath());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return path;
}

/** Navigate without a reload. */
export function navigate(path) {
  location.hash = path;
}

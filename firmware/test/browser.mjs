// Resolving Playwright, in one place.
//
// ESM resolution ignores NODE_PATH, and playwright is usually installed globally
// rather than into this repo. createRequire does honour it, so fall back to the
// well-known global locations when a bare specifier does not resolve.
//
// Two tools need this - the screenshot harness and the table test - and a drifting
// second copy of a resolver is exactly the kind of thing this repo keeps having to
// consolidate, so it lives here.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CANDIDATES = ['playwright',
                    '/opt/node22/lib/node_modules/playwright',
                    '/usr/lib/node_modules/playwright'];

// Returns null rather than exiting when `soft` is set, so a suite can skip a
// browser-dependent section instead of failing on a machine without Playwright.
export function loadPlaywright({ soft = false } = {}) {
  for (const spec of CANDIDATES) {
    try { return require(spec); } catch { /* try the next one */ }
  }
  if (soft) return null;
  console.error('playwright not found - npm i -g playwright, or set NODE_PATH');
  process.exit(1);
}

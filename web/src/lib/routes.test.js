// The shell's nav has to be the firmware's nav.
//
// Both are served off the same board and link to each other, so during the port
// there will be a period where some tabs land on a Preact page and some on a
// firmware one. If the labels or the order drift, the tab under your thumb changes
// meaning halfway through the migration — which is the sort of thing that is
// obvious in a diff and invisible on a phone in a moving car.
//
// This reads the firmware page rather than a copy of it, the same way
// firmware/test/test_dashboard.mjs asserts against page source. It skips itself,
// without failing, if web/ is ever built outside the firmware repo.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROUTES } from '../routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(here, '../../../firmware/NexonOBD/dashboard_html.h');

describe('nav', () => {
  it('has the six tabs in order', () => {
    expect(ROUTES.map((r) => r.label)).toEqual(
      ['Live', 'Monitors', 'Trips', 'Watch', 'Scanner', 'Firmware']);
  });

  it('matches the firmware dashboard\'s nav', () => {
    if (!existsSync(DASHBOARD)) {
      // Built standalone; the check above still pins the list.
      return;
    }
    const src = readFileSync(DASHBOARD, 'utf8');
    const nav = (src.match(/<nav>([\s\S]*?)<\/nav>/) || [, ''])[1];
    const tabs = [...nav.matchAll(/href="([^"]*)"[^>]*>([^<]*)</g)]
      .map(([, href, label]) => ({ href, label }));

    expect(tabs.length, 'the firmware nav was parsed').toBe(6);
    expect(tabs.map((t) => t.label)).toEqual(ROUTES.map((r) => r.label));
    expect(tabs.map((t) => t.href)).toEqual(ROUTES.map((r) => r.fw));
  });
});

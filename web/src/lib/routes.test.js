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
//
// It used to read dashboard_html.h, which was deleted when the SPA replaced the
// compiled pages — so existsSync was false, the comparison below returned without
// comparing anything, and the check silently stopped running. It now reads the nav
// that is actually still shipped in flash, in ui_html.h. The escape hatch stays,
// but it is for a standalone checkout, not for a file that is simply gone: if the
// path stops resolving inside this repo the check has to be repointed again, not
// left to skip.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROUTES } from '../routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const FW_PAGE = join(here, '../../../firmware/Obdurate/ui_html.h');

describe('nav', () => {
  it('has the five tabs in order', () => {
    // Was six. Sweep and Watch merged into Discover: two halves of one pipeline the
    // autopilot now runs end to end, so two of six places went on halves of the
    // same job and the middle of it lived on a screen you had to know to visit.
    expect(ROUTES.map((r) => r.label)).toEqual(
      ['Live', 'Monitors', 'Trips', 'Discover', 'Firmware']);
  });

  it('matches the nav still shipped in flash', () => {
    if (!existsSync(FW_PAGE)) {
      // Built standalone; the check above still pins the list.
      return;
    }
    const src = readFileSync(FW_PAGE, 'utf8');
    const nav = (src.match(/<nav>([\s\S]*?)<\/nav>/) || [, ''])[1];
    // Each tab is an icon and a label now, not a bare text node, so the label is
    // read out of its <span> rather than off the front of the anchor. Matching the
    // whole anchor first keeps one tab's href from pairing with the next one's
    // label if a page ever ships a nav item without a label at all.
    const tabs = [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({
      href: (attrs.match(/href="([^"]*)"/) || [, ''])[1],
      label: (inner.match(/<span>([^<]*)<\/span>/) || [, ''])[1],
    }));

    expect(tabs.length, 'the firmware nav was parsed').toBe(5);
    expect(tabs.map((t) => t.label)).toEqual(ROUTES.map((r) => r.label));
    expect(tabs.map((t) => t.href)).toEqual(ROUTES.map((r) => r.fw));
  });
});

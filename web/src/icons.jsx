// The icon set. Inline SVG, drawn here rather than pulled from a package.
//
// Nine glyphs is not a dependency's worth, and every icon library ships a font or a
// sprite sheet — both of which are extra bytes on a 300 KB budget shared with the
// trip logs, and one of which is another licence to clear.
//
// All of them are drawn on the same 24 grid with the same stroke weight, and none
// of them sets its own colour or size: `fill:none`, `stroke:currentColor` and the
// dimensions come from the CSS rule for whatever they sit in (`nav a svg`,
// `.act svg`, `.caution svg`), so an icon inherits the state of its container
// rather than being restyled per use.

const box = { viewBox: '0 0 24 24', 'aria-hidden': 'true' };

/** Live — a speedometer sweep with its needle. */
export const IconGauge = () => (
  <svg {...box}><path d="M4.2 17a9 9 0 1 1 15.6 0" /><path d="M12 13.5 16 9" /></svg>
);

/** Monitors — the trace an on-board test result sits on. */
export const IconPulse = () => (
  <svg {...box}><polyline points="3,13 7,13 9.5,6.5 14,18 16.5,13 21,13" /></svg>
);

/** Trips — a route between two points. */
export const IconRoute = () => (
  <svg {...box}>
    <circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="6" r="2.4" />
    <path d="M8.4 18h5.1a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h.5" />
  </svg>
);

/** Watch — a value held in the sights. */
export const IconTarget = () => (
  <svg {...box}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.4" /></svg>
);

/** Scanner — a sweep looking for identifiers. */
export const IconSearch = () => (
  <svg {...box}><circle cx="11" cy="11" r="7" /><path d="M16.2 16.2 21 21" /></svg>
);

/** Firmware — the board itself. */
export const IconChip = () => (
  <svg {...box}>
    <rect x="7" y="7" width="10" height="10" rx="2.2" />
    <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
  </svg>
);

/** Download a trip log. */
export const IconDownload = () => (
  <svg {...box}><path d="M12 3v13" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></svg>
);

/** Delete a trip log. */
export const IconTrash = () => (
  <svg {...box}>
    <path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" />
  </svg>
);

/** Upload — a firmware image or a bundle. */
export const IconUpload = () => (
  <svg {...box}><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 20h16" /></svg>
);

/** The one warning glyph, for anything that cannot be undone by waiting. */
export const IconAlert = () => (
  <svg {...box}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

/** Back, out of a trip and into the list it came from. */
export const IconBack = () => (
  <svg {...box}><path d="M15 5l-7 7 7 7" /></svg>
);

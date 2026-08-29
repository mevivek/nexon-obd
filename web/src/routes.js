// The six tabs, in order.
//
// Plain data in its own module so it can be asserted against the firmware pages'
// <nav> without pulling in Preact or the build-time defines. That check matters:
// the firmware pages and this bundle are reachable from each other on the same
// board, and a tab that moves between them is a tab you tap wrong at 60 km/h.
//
// `href` is the path the firmware serves the same page at, which is what the port
// of each page has to end up matching.
//
// `title` is the page's own <h1>, taken from the firmware page's header — it is not
// the tab label: the tab says "Watch" because six labels have to fit across a phone,
// the heading says "DID Watch" because that is what the page is. `sub` is the detail
// the firmware prints after the version in the subtitle, for the pages whose detail
// is a constant; Live and Firmware report theirs at runtime (see shell.jsx).
export const ROUTES = [
  { path: '/', label: 'Live', fw: '/', title: 'Live' },
  { path: '/monitors', label: 'Monitors', fw: '/monitors', title: 'Monitors', sub: 'mode 06' },
  { path: '/trips', label: 'Trips', fw: '/trips', title: 'Trips', sub: 'CSV logs' },
  { path: '/watch', label: 'Watch', fw: '/watch', title: 'DID Watch', sub: 'service 0x22' },
  { path: '/scan', label: 'Scanner', fw: '/scan', title: 'DID Scanner', sub: 'service 0x22' },
  { path: '/update', label: 'Firmware', fw: '/update', title: 'Board' },
];

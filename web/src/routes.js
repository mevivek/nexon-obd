// The six tabs, in order.
//
// Plain data in its own module so it can be asserted against the firmware pages'
// <nav> without pulling in Preact or the build-time defines. That check matters:
// the firmware pages and this bundle are reachable from each other on the same
// board, and a tab that moves between them is a tab you tap wrong at 60 km/h.
//
// `href` is the path the firmware serves the same page at, which is what the port
// of each page has to end up matching.
export const ROUTES = [
  { path: '/', label: 'Live', fw: '/' },
  { path: '/monitors', label: 'Monitors', fw: '/monitors' },
  { path: '/trips', label: 'Trips', fw: '/trips' },
  { path: '/watch', label: 'Watch', fw: '/watch' },
  { path: '/scan', label: 'Scanner', fw: '/scan' },
  { path: '/update', label: 'Firmware', fw: '/update' },
];

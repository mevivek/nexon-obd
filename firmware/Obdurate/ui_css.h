#pragma once
#include <pgmspace.h>

// The shell every page shares: palette, header, nav, tiles, tables, controls.
//
// One macro, so the pages cannot drift apart - but served from /ui.css rather than
// concatenated into each page. Inlining it put an identical ~7 KB into all five
// documents and re-sent it on every tab switch, which the board pays for twice: in
// bytes, and in the loop turns spent writing them. Served once with an immutable
// cache header and a version-stamped URL, it is fetched once per firmware build and
// then never again.
//
// Dark-committed on purpose: this is an in-car display that is never viewed on a
// light background. Status colour is always paired with an icon or text, so nothing
// depends on colour alone.
//
// v1.12 - the phone-first pass. Two structural changes, both because this is used
// one-handed on a phone wedged in a car:
//
//   * The nav moved from a scrolling strip at the top of the screen to a fixed bar
//     at the bottom. The top of a handset is the hardest place on the device to
//     reach with the thumb holding it, and that is where every tab used to live.
//   * A held reading stopped being `opacity:.4`. Forty per cent grey behind a
//     windscreen in daylight is not readable, and reads as *disabled* rather than
//     *stale* when it is. It keeps its weight and shifts to --held instead, with
//     the reason spelled out on the line the tile already reserves for it.
//
// Token names are unchanged on purpose. They are referenced from JSX as well as
// from CSS - web/src/pages/live/Spark.jsx takes its stroke as a `var(--aqua)`
// string handed over by the call site - so renaming one would blank a sparkline
// silently rather than fail a build. The values moved; the names did not.

#define UI_CSS R"css(
:root{
--plane:#07070b;--surface:rgba(255,255,255,.075);--raised:rgba(255,255,255,.06);
--ink:#f2f3f7;--ink2:#a6a9b6;--muted:#8b8f9c;--held:#7c8091;
--grid:rgba(255,255,255,.07);--base:rgba(255,255,255,.11);--ring:rgba(255,255,255,.11);
--blue:#8b95ff;--orange:#ff9f6b;--aqua:#5fe3c0;--yellow:#ffb04d;
--good:#5fe3c0;--warning:#ffb04d;--critical:#ff5d6c;
--plate:0 14px 34px rgba(0,0,0,.42);
color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
/* The bottom bar is fixed, so the document has to end above it. The inset is 0 on
   a device with no home indicator, and the bar sits on the safe area on one that
   has - either way nothing lands under Safari's collapsing toolbar. */
body{margin:0;padding:0 0 calc(92px + env(safe-area-inset-bottom,0px));
background:var(--plane);color:var(--ink);
-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;
font:500 15px/1.45 "Space Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:0 18px}

/* header ---------------------------------------------------------------- */
header{position:sticky;top:0;z-index:5;margin-bottom:12px;padding:16px 18px 12px;
background:rgba(7,7,11,.92);border-bottom:1px solid var(--grid)}
@supports (backdrop-filter:blur(1px)){header{backdrop-filter:blur(12px)}}
.bar{display:flex;align-items:center;gap:10px;max-width:1100px;margin:0 auto}
/* Title over subtitle, so the pill has the whole right-hand side to itself and a
   long transport string cannot push the version off the screen. */
.id{min-width:0}
h1{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em;white-space:nowrap}
.sub{display:block;margin-top:2px;color:var(--muted);
font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* The subtitle carries the firmware version on every page, so it stays visible at
   phone width and is dropped only when there is genuinely no room for it. */
@media(max-width:360px){.sub{display:none}}
.status{margin-left:auto;display:flex;align-items:center;gap:7px;flex:none;
font-size:12px;font-weight:600;color:var(--ink);background:var(--raised);
border:1px solid var(--ring);border-radius:999px;padding:7px 13px 7px 11px;
white-space:nowrap}
.status .muted{color:var(--muted);font-weight:500}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
.dot.live{background:var(--good);box-shadow:0 0 9px rgba(95,227,192,.85)}
.dot.stale{background:var(--warning);box-shadow:0 0 9px rgba(255,176,77,.85)}
.dot.dead{background:var(--critical);box-shadow:0 0 9px rgba(255,93,108,.85)}

/* nav - a fixed bar at the bottom, within thumb reach ------------------- */
nav{position:fixed;left:0;right:0;bottom:0;z-index:6;
display:flex;gap:2px;padding:6px;margin:0 14px calc(16px + env(safe-area-inset-bottom,0px));
background:rgba(18,18,24,.86);border:1px solid var(--ring);border-radius:28px;
box-shadow:0 16px 36px rgba(0,0,0,.5)}
@supports (backdrop-filter:blur(1px)){nav{backdrop-filter:blur(14px)}}
@media(min-width:760px){nav{max-width:620px;margin-left:auto;margin-right:auto}}
/* 52px, because a moving car is the worst possible place to miss a target. */
nav a{flex:1;min-width:0;min-height:52px;
display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
border-radius:22px;text-decoration:none;color:var(--muted);
font-size:8.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
nav a svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;
stroke-linecap:round;stroke-linejoin:round}
nav a.on{color:var(--blue);background:rgba(139,149,255,.18)}

/* section headings ------------------------------------------------------ */
h2.sec{display:flex;align-items:center;gap:10px;margin:18px 0 8px;
font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.13em;
color:var(--muted)}
h2.sec::after{content:"";flex:1;height:1px;background:var(--grid)}

/* plates ---------------------------------------------------------------- */
/* One surface treatment, used by every tile and card: a translucent plate, a
   bright top edge and a soft drop. The edge is a gradient rather than a border
   because a border cannot fade out before the corners. */
.tile,.card,details{position:relative;background:var(--surface);
border:1px solid var(--ring);border-radius:26px;box-shadow:var(--plate)}
.tile::before,.card::before,details::before{content:"";position:absolute;top:0;
left:22px;right:22px;height:1px;pointer-events:none;
background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.28),rgba(255,255,255,0))}

/* tiles ----------------------------------------------------------------- */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:10px}
.tile{display:flex;flex-direction:column;min-width:0;overflow:hidden;padding:13px 15px}
.label{margin-bottom:5px;font-size:10px;font-weight:600;text-transform:uppercase;
letter-spacing:.12em;color:var(--muted);white-space:nowrap;overflow:hidden;
text-overflow:ellipsis}
.value{font-size:26px;font-weight:700;line-height:1.05;letter-spacing:-.035em}
.value .unit{margin-left:3px;font-size:11px;font-weight:600;letter-spacing:0;
color:var(--muted)}
.value.warn{color:var(--warning)}
.value.crit{color:var(--critical)}
/* A held reading - shown because the poll that carries it came back empty. It
   keeps its weight and changes hue; see the note at the top of this file. */
.stale{color:var(--held)}
.note{margin-top:4px;font-size:10.5px;color:var(--muted)}
/* Always occupies its line, so a warning appearing cannot reflow the page and
   shuffle every tile under the driver's eye. */
.flag{margin-top:4px;min-height:14px;font-size:11px;line-height:1.25;
visibility:hidden}
.flag.on{visibility:visible}
.flag.warn{color:var(--warning)}
.flag.crit{color:var(--critical)}
/* Sinks to the bottom of the tile and bleeds to its edges - the plate is the
   frame, so the trace does not need a second one of white space inside it. */
.spark{display:block;width:calc(100% + 30px);height:30px;margin:8px -15px -13px;
margin-top:auto;padding-top:8px}

/* tables ---------------------------------------------------------------- */
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
caption{padding-bottom:8px;text-align:left;font-size:10px;font-weight:600;
text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
th,td{padding:7px 10px 7px 0;text-align:left;border-bottom:1px solid var(--grid);
vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:10px;text-transform:uppercase;
letter-spacing:.12em}
td.num{text-align:right}
td.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;
white-space:nowrap}
/* Only payload columns may break mid-token; an identifier split across two lines
   as "F18 / A" is unreadable. */
td.brk{white-space:normal;word-break:break-all}

/* disclosure ------------------------------------------------------------ */
details{margin-top:10px;padding:13px 15px}
summary{cursor:pointer;font-size:10px;font-weight:600;text-transform:uppercase;
letter-spacing:.12em;color:var(--ink2);list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"\25B8";display:inline-block;margin-right:8px;
color:var(--muted);transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
details>.tiles,details>.tw{margin-top:12px}

/* controls -------------------------------------------------------------- */
.card{padding:15px 17px;margin-bottom:10px}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
label{display:block;margin-bottom:5px;font-size:10px;font-weight:600;
text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
select,input{background:var(--raised);color:var(--ink);border:1px solid var(--base);
border-radius:14px;padding:11px 12px;font:inherit;font-size:14px}
input[type=text]{width:104px}
input[type=file]{width:100%;padding:11px 0;border:0;background:none;color:var(--ink2)}
button{background:var(--blue);color:#0b0c14;border:0;border-radius:15px;
padding:12px 18px;font:inherit;font-weight:600;cursor:pointer;min-height:46px}
button.ghost{background:var(--raised);color:var(--ink2);border:1px solid var(--ring)}
button.danger{background:rgba(255,93,108,.12);color:var(--critical)}
button:disabled{background:var(--raised);color:var(--muted);cursor:not-allowed}
/* A locked control has to look locked, or it reads as unresponsive rather than
   deliberately unavailable. */
select:disabled,input:disabled{opacity:.45;cursor:not-allowed}
/* A segmented control, for a choice of two or three. A native select hides all but
   one option behind a tap and brings the platform's own chrome with it. */
.seg{display:flex;gap:4px;padding:4px;background:var(--raised);
border:1px solid var(--ring);border-radius:18px}
.seg>*{flex:1;min-width:0;min-height:48px;display:flex;flex-direction:column;
align-items:center;justify-content:center;border:0;border-radius:14px;
background:none;color:var(--muted);font:inherit;font-size:13px;font-weight:600;
cursor:pointer}
.seg>*.on{background:rgba(139,149,255,.18);color:var(--ink)}
.seg small{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
font-size:10px;font-weight:400;color:var(--muted);margin-top:2px}
.seg>*:disabled{cursor:not-allowed;opacity:.55}
.bar2{height:6px;margin-top:12px;background:var(--base);border-radius:3px;
overflow:hidden}
.bar2>i{display:block;height:100%;width:0;background:var(--blue);transition:width .2s}
.meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:13px;
color:var(--ink2)}
.meta b{color:var(--ink);font-weight:700}
.msg{margin-top:12px;font-size:14px}
.msg.ok{color:var(--good)}.msg.err{color:var(--critical)}.msg.warn{color:var(--warning)}
.hint{margin-top:10px;font-size:11.5px;line-height:1.6;color:var(--muted)}
code{background:var(--raised);border-radius:6px;padding:2px 6px;font-size:12px;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
)css"

// The macro exists so the pages can still be reassembled from source by the test
// harness; this is what /ui.css actually sends.
static const char UI_CSS_BODY[] PROGMEM = UI_CSS;

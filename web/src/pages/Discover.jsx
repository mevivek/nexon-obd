// Everything that turns an unknown car into a known one, on one screen.
//
// Sweep and Watch were two tabs, and that was a fair split while they were two
// separate things somebody did on two separate occasions. They are not any more:
// the autopilot runs the sweep, triages what it found, chooses what to watch and
// fits the results, in that order, without being asked. Splitting one pipeline
// across two tabs meant the middle of it was on a screen you had to know to go and
// look at, and the tab bar spent two of its six places on halves of the same job.
//
// Order is the pipeline's own. The autopilot first, because for most people that is
// the whole page - press it once and never come back. The manual controls below it
// are the same three phases with the automation taken off, kept because a sweep of
// one block, or a hand-picked watch set, is exactly what you want when chasing a
// specific identifier rather than mapping a car.
//
// One header pill between three pollers. Which one wins, and why it is a precedence
// rather than whichever answered last, is in discover/pill.js.

import { useState } from 'preact/hooks';
import { useShellStatus } from '../shell.jsx';
import { AutoCard } from './scanner/AutoCard.jsx';
import { Scanner } from './Scanner.jsx';
import { Watch } from './Watch.jsx';
import { discoverPill } from './discover/pill.js';

export function Discover() {
  const [auto, setAuto] = useState(null);
  const [scan, setScan] = useState(null);
  const [watch, setWatch] = useState(null);

  useShellStatus(discoverPill(auto, scan, watch) || {});

  return (
    <>
      <AutoCard onStatus={setAuto} />
      <Scanner onStatus={setScan} />
      <Watch onStatus={setWatch} />
    </>
  );
}

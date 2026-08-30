# Obdurate

> *ob·du·rate* — adj. unyielding; refusing to be moved.

**A read-only black box for your car.** It plugs into the OBD-II port and stays
there. It records every drive to onboard flash whether or not a phone is connected,
prints the sample rate it is actually achieving next to every reading, and never
writes anything to the car — which is a test, not a promise: the build fails if a
write service ever appears in the source.

Built on a **Seeed XIAO ESP32S3**. It hosts its own Wi-Fi access point and serves a
gauge dashboard, on-board monitor results, a UDS identifier scanner and browser-based
OTA updates. No app, no account, no internet, no cloud. Join its Wi-Fi and a page
opens; don't, and it keeps recording anyway.

**Developed and verified against a 2022 Tata Nexon 1.2 petrol (BS6).** The transport
layer, ISO-TP, the recorder, the scanner and the honesty rules are generic. The PID
lists (`PID_B1`–`PID_B4`), the ECU addresses (`ID_ECM_REQ`/`ID_TCM_REQ`), the bus
timing and the warning thresholds are that car's — a different one needs those
changed in the source, and there is no porting guide yet. If you try it on another
car, the measurements are the interesting part; open an issue.

[`docs/FINDINGS.md`](docs/FINDINGS.md) is what was measured on this one, including a
catalogue of the ways a cheap ELM327 clone lies to you.

It reaches the car two ways and picks whichever works:

| Transport | Hardware | Speed | Notes |
|---|---|---|---|
| **BLE ELM327** | none — uses a dual-mode ELM327 already in the OBD port | ~2 Hz | Works today |
| **Direct CAN** | SN65HVD230 transceiver (~₹200) | 50–100 Hz | Preferred once wired |

Everything here was verified against the actual vehicle. Where a claim is untested,
it says so.

---

## Quick start

1. Flash the firmware (see [Building](#building)).
2. Power the board — USB, or from the OBD port via a 12 V→5 V buck.
3. Join Wi-Fi **`Obdurate`** / **`changeme1234`**.
4. Open **`http://192.168.4.1`**.

That is the whole install. The dashboard is compiled into the firmware, so flashing
is all it takes — there is no second step, no laptop at the car, and no state where
the board is running but has no page to show.

You can still deploy a bundle to the filesystem with **`web/deploy.sh`**, and it
takes precedence when present. That is the edit loop: changing a line of CSS costs a
22 KB upload rather than a 1.3 MB reflash. The compiled-in copy is the floor
underneath it, so a failed or half-finished deploy falls back to the last dashboard
that was built into the firmware rather than to a stub.

| Page | What it does |
|---|---|
| `/` | Live gauges — RPM, boost, temps, trims, lambda, catalyst, driver demand |
| `/monitors` | Mode 06 on-board monitor test results, with the ECU's own limits |
| `/scan` | UDS service `0x22` identifier sweep, with CSV export |
| `/update` | Upload a new `.bin` over Wi-Fi |
| `/dtc` | Stored + pending fault codes as JSON |
| `/data` | Current sample as JSON, plus firmware version and active transport |
| `/trips` | Per-drive CSV logs — list, download, delete |
| `/history` | The stored trend buffer as JSON |
| `/vehicle` | What this car is and which readings it supports, as JSON |
| `/car` | Which car this board is bound to, and whether it is recording |
| `/auto` | The autopilot's phase and progress |
| `/files` | What data is on the filesystem — the list a backup is built from |
| `/file` | One data file, streamed |
| `/reset` | Erase the data, or the data and the dashboard bundle |

The header shows the running firmware version and which transport is actually live
(`can` or `ble`), so a flashed image can be confirmed at a glance.

A poll can come back with only some of its PIDs — the dashboard reads them in three
batched requests, and one batch can time out while the others answer. When that
happens the affected gauges keep showing their last reading, dimmed, and the header
reports `live · holding N`. After 2.5 s without a fresh value they fall back to `—`
rather than showing stale data indefinitely, and a held reading never raises or
sustains a warning — a value from two seconds ago cannot tell you whether the engine
is still overheating.

A single dropped poll is not reported as a fault either — the status only changes to
`no response from ECU` after five consecutive failures. Dropped replies happen, the
values are held through them, and flipping the status on each one reads as a problem
when nothing is wrong.

### Polling runs on the board, not on the page

The board samples the ECU continuously in `loop()`, one batched request per turn,
and `/data` returns the newest cached sample rather than going to the bus. Polling
therefore does not stop when you close the browser, and no request ever waits for a
poll of its own.

It did, however, wait for *someone else's*. The web server is single threaded, and
until v1.8.0 it got exactly one turn per bus exchange — up to 1.2 s on BLE, twice
that when a batch is retried. A tab switch is three requests (the document, `/time`,
and the new page's first poll), so switching pages could sit behind several seconds
of ELM327 timeouts and felt like a page load rather than a page swap.

Two things fix that, both in `bus_yield.h`:

- **The wait loops serve HTTP.** Waiting on the car is otherwise `delay(1)` on BLE
  and a 5 ms blocking receive on CAN. Both now call `webYield()` instead, which
  serves whatever is queued and reports how long it took — and the response deadline
  moves out by exactly that, because the reply is still waiting behind us either way
  (the TWAI RX queue, or the ELM notify buffer). Without the give-back, serving a
  page would eat the ECU's patience window and surface as a phantom timeout. The
  extension is capped at 3 s so one slow handler cannot hold an exchange open.
- **`loop()` drains the queue** instead of taking one request per turn, so a whole
  page load completes in a single turn.

Two guards keep that safe. `WebServer` tracks a single current client, so
`webYield()` refuses to re-enter it from inside a handler; and `obdIsoTp()` sets a
flag for the duration of an exchange so a handler reached from a yield cannot start
a second one underneath a half-finished reassembly. `/dtc` is the only handler that
touches the bus — it stands down when that flag is set, and because it runs inside
`handleClient()` and therefore cannot yield, its own timeouts are kept short.

The pages help too: the shared ~7 KB stylesheet used to be compiled into all five
documents and re-sent on every switch. It is now served once from `/ui.css` with a
version-stamped, immutable URL, and the pages carry an `ETag` so a re-visit is a
304 with no body. That is also worth ~26 KB of flash.

A sample is published after **every** batch, not after all three. The other two are
carried forward from cache while they are still fresh (3 s), so the page updates at
the bus transaction rate rather than a third of it. Batches are not polled equally
either — `b1` carries everything with a sparkline (rpm, speed, MAP, throttle, load,
coolant) and gets half the turns, because oil temperature and battery voltage do not
move fast enough to deserve equal billing:

| | Refresh |
|---|---|
| `b1` — rpm, speed, MAP, throttle, load, coolant | every 3 batches |
| `b4` — pedal, commanded throttle, torque, absolute load | every 3 batches |
| `b2` — oil, IAT, voltage, trims, fuel rate | every 6 batches |
| `b3` — lambda, catalyst, timing, run time, ambient, fuel | every 6 batches |

A batch that has not answered for three of its own polling cycles is dropped to
`null` rather than published as current, so carrying values forward can never
present a stale number as live. That window is measured, not fixed: `b2` and `b3`
come round once every four batches, so a flat timeout only holds if a batch
completes quickly. Over BLE it does not, and those two batches then expire before
their next turn — blanking twelve of the twenty rows in **All values** on every
cycle. The dashboard's own hold window scales the same way, off the observed sample
interval.

The `[alive]` serial line prints `batch=`, `cycle=` and `stale=` so all three are
visible rather than inferred.

### The board says how fast it is actually reading the car

Those numbers used to go only to the serial log, where nobody sitting in a car can
read them. They are now in `/data` as a `q` block, and on the page as the muted
trailer next to the status pill:

```
live · holding 2      1.87 Hz · b3 6.8 s
```

The rate quoted is **the board's**, not the page's. The page's fetch loop is capped
by its poll interval and throttled harder still in a backgrounded tab, so a rate
measured there can only ever be at or below the one the board is publishing — it
would understate a healthy link and could never catch a sick one. Where the two
genuinely disagree, both are shown, because that is the case worth knowing about:
the log holds samples the screen is not showing you.

This is the number every tool in this category leaves out. An ELM327 round trip puts
a cheap clone somewhere near five PIDs a second; set a tenth-of-a-second logging
interval against that and you get a log that looks complete and is mostly the
previous row repeated, with nothing anywhere to tell you which it is.

Two rules keep it honest, and they are the same ones the readings themselves follow:

- **`hz` is null, not zero, until a full pass has been timed.** A rate of zero is a
  claim that the bus is dead. Not having measured one yet is not that claim, and the
  first second of every drive is spent in that state.
- **A batch that has never answered is null, not a very large age.** Never-answered
  is usually a PID this ECU does not support; long-ago-answered is a link going bad.
  Collapsing them presents the first as the second.

The stalest batch is named only once it is past the board's own derived staleness
window — `b2` and `b3` come round once every four turns by design, so reporting the
worst one unconditionally would be a permanent complaint about nothing.

`/data` also carries a `boot` block: how this run started (`power`, `wake`, `panic`,
`brownout`, `wdt`, …), how long it has been going, and how many deep-sleep wakes
since the last cold boot. A recorder that runs unattended has to be able to answer
*what happened while I was not looking* — a board that has quietly panicked and
restarted forty times otherwise looks exactly like one that has been up all week.

**On BLE, the bus transaction rate is the limit**, and it is mostly round-trip
latency rather than the ECU. The connection interval is the floor: at a default of
40–50 ms a request and its reply cannot beat about a tenth of a second however fast
the car answers. The firmware asks for 7.5–15 ms and a 247-byte MTU, which collapses
a ~80-character reply from four or five notifications into one or two. The adapter
may refuse either, in which case nothing is worse than before. The serial log prints
`batch=NNNms` so the real cost is visible rather than guessed at.

The dashboard stops requesting while the page is off screen, and the Hz readout
counts *published samples* rather than fetches — the same cached sample can be
fetched several times and must not inflate the rate.

### Mileage

Two figures, in the glance area under boost and coolant:

- **Mileage** — the average over this drive, with the totals it came from
  (`23.6 km · 1.66 L`) underneath so the number can be checked rather than trusted.
- **Right now** — instantaneous km/L, which is what the pedal moves. Standing still
  it reads `—` and says `idling` instead, because speed ÷ nothing is not a mileage.

There is no PID for fuel economy, so it is integrated on the board from speed
(`0D`) and fuel rate (`5E`), both confirmed supported on this ECU. On the board and
not on the page, so locking the phone or closing the browser does not lose the drive.
Two rules keep it honest:

- **Both inputs or neither.** Fuel rate lives in the `b2` batch and refreshes half as
  often as speed, so it goes absent regularly. Counting the distance anyway would
  divide real kilometres by an understated litre count and report a mileage better
  than the car achieved.
- **Gaps are not driving.** An interval longer than 5 s — a BLE dropout, a scan taking
  the bus, a wake from sleep — is skipped rather than integrated at the last known
  speed. The clock still moves, so the interval after an outage is one interval, not
  the whole outage.

The average is withheld until roughly the first 0.5 km and 0.1 L. Before that it
swings by tens of km/L between polls and reads as a broken gauge.

Totals start at zero each time the board powers up, which — given the
accessory-socket supply — is exactly one drive. They also go into the trip CSV as
`trip_km` and `trip_l`, so economy over any stretch of a drive can be recovered by
differencing two rows.

One caveat worth knowing: `5E` is the ECU's injection model, not a flow meter. Trip
km/L from it typically reads a few percent optimistic against tank-to-tank. It is
excellent for comparing drives and weaker as an absolute.

### Driver demand vs. delivery

Six of the 55 PIDs the ECM supports trace one chain: **accelerator pedal (`49`/`4A`)
→ commanded throttle (`4C`) → actual throttle (`11`) → demanded torque (`61`) →
delivered torque (`62`)**, with absolute load (`43`) alongside. That is what you
asked the car for, what the ECU decided to do about it, and what the engine actually
produced — which on a small turbo is the interesting part.

Torque is reported as a percentage of the engine's reference torque (`63`), a
constant read once at startup like barometric pressure, so the newton-metre figures
are derived rather than read.

> The scalings are the J1979 ones and have **not been verified against this car** —
> `FINDINGS.md` lists the torque PID scaling as an open question precisely because it
> needs data under load. A wrong data *length* is caught (`mode01Walk` rejects the
> batch), but a wrong *scaling* would not be. Treat the numbers as provisional until
> they have been watched under load and found sane.

### On-board monitors (mode 06)

Mode 06 is the ECU's own test results: what each monitor measured, and the limits it
is judged against. `FINDINGS.md` recorded it as supported (`46 00 C0000001`) and
never explored — so `/monitors` reads it.

The value of it over `/dtc` is that a fault code only appears once a system has
already failed. Mode 06 shows how much room is left, so a catalyst drifting toward
its threshold is visible while it is still passing.

**Pass and headroom do not require knowing the units.** A test passes when its value
sits inside its own limits, and the headroom is a fraction of that window — both
unit-free. The unit-and-scaling table is long and only partly documented, so values
are shown raw with their scaling id, decoded only where the multiplier is
unambiguous. Monitor names likewise: only unambiguous J1979 ids are named, the rest
keep their raw id rather than being given a label that might be wrong.

Discovery walks the support masks (`00` → `20` → `40` …, each mask's last bit
pointing at the next), then each monitor is read one at a time. It runs only while
the page is open — monitors move over minutes, and polling them continuously would
take bus time from the values that move now.

### The DID scan runs in the background

A scan is driven by the board, so it continues if you navigate away, close the
browser, or lock the phone. Only **Stop** — or an OTA upload, which never flashes
mid-scan — ends it.

While it runs the scanner takes most of the bus, but not all of it — the sampler
still gets one batch every two seconds, so live values keep moving slowly rather
than freezing. That costs roughly 15 % of scan throughput, which is a good trade
against a dashboard that is dead for the length of a sweep.

The Live page shows the sweep's progress with counts as well as a percentage — a
full pass is 65,536 requests, so a percentage alone rounds to zero for a long time
and reads as stuck — and the scanner page estimates the time remaining.

Scanning is time-boxed to 250 ms per turn rather than a fixed identifier count. A
count behaves wildly differently per transport — 40 identifiers is about a second on
CAN but roughly 22 s over BLE, during which nothing answers the web server and the
board appears hung.

### Watching identifiers to find out what they hold

A sweep finds identifiers that answer. It cannot say what any of them contain — the
manufacturer-specific block (ISO 14229-1 hands `0100`–`A5FF` to the manufacturer)
comes back as one or two raw bytes with no name, unit or scaling, and that lives in
an ODX database nobody outside the supplier has.

What you can do is correlate. `/watch` reads up to **8** chosen identifiers
continuously and shows them next to rpm, speed, coolant, intake, load and throttle,
each with a sparkline. Blip the throttle and an rpm-linked value gives itself away.
The ones the scanner found are offered as checkboxes, so there is no copying hex
between pages.

**Coming from a build before 1.7.0:** those sweeps kept their hits in RAM only —
nothing was written to flash — so an updated board comes up with an empty picker
even though the sweep happened. The `did_hits.csv` you exported is the only copy,
and the picker loads it directly: choose the file and the identifiers appear as
checkboxes, merged with anything the board found itself. It is parsed in the
browser and kept in `localStorage`; nothing is uploaded, and there is no endpoint
that would make a browser a second source of truth for what the board found.

The same readings become extra columns on the trip CSV — two per identifier: the
bytes decoded big-endian, and the raw bytes beside them. Two bytes might equally be
one 16-bit value or two 8-bit ones and nothing in the reply says which, so the
decode is a convenience and the raw column is the record. An identifier that has
stopped answering writes **empty** cells rather than zeros, the same rule the PID
columns already follow: a missing reading must not correlate as a value of nought.

Changing the set **rotates the CSV**. Columns are fixed when a file is opened, and
shifting them halfway down one is worse than having two files. Re-applying an
identical set is not a change, so pressing Apply twice does not litter the partition.

The cost is real and the page states it. Every watched identifier is one more bus
exchange, and BLE affords about six a second in total — eight at the default one per
second is roughly a sixth of the budget. Watching **pauses entirely while a sweep is
running**; a sweep is already hours long and shares the bus with the sampler, and a
third claimant would do both jobs badly.

This gives correlation, not meaning. It will tell you `1002` tracks coolant; the
offset and scale come from fitting the logged column against the PID afterwards.
Service `0x22` is still a read — only the identifier varies, never the service.

### Trip logs

A CSV row a second while the ECU is answering, written to the 1.5 MB filesystem
partition. Twenty-six columns — wall-clock time and uptime, then twenty-four
readings — and empty cells rather than zeros where a value was not read, so a gap is
a gap and not a reading of nought.

> **This did not work until v1.12.0.** `tripTick()` was written, documented here,
> and never called from anywhere. `/trips/list` returned an empty array on every
> board that has ever run this firmware, and the DID-correlation workflow described
> below — the route this project has for decoding the `10xx` block — has never
> produced a row. If you flashed anything before v1.12.0, there are no trip logs to
> recover; there never were any.

Roughly half a megabyte an hour bare, so the partition holds two to three hours, and
the oldest trip is deleted automatically when space runs short. Watched identifiers
change that materially: each one adds two columns and up to 26 bytes to every row,
so a full set of eight is closer to **1.3 MB an hour — about one hour of capacity**.
The columns are chosen when a file is opened, so the cost is fixed for that file.

LittleFS rather than SPIFFS: the board loses power the instant the ignition goes
off, mid-write as often as not, and LittleFS is built to survive exactly that.

A full partition is the ordinary end state of a device left in a car, not an edge
case. Logging stops rather than pretending: `tripEnsureSpace()` reports whether it
managed to reach the free-space floor, a file is not opened when it did not, and the
row terminator is checked so a write that did not land is seen. Without those, a
failed write left `size()` where it was, the rotation that would have freed space
never fired again, and logging stopped for the rest of the drive in silence.

The clock comes from whichever page you open, so a drive that starts before you open
one has an unset clock for its first rows. Each file's header records whether the
clock was set rather than implying a timestamp it does not have.

### Scans survive being switched off

A sweep is tens of thousands of requests — the better part of a day over BLE — so it
has to outlast the car being switched off. Position goes to NVS as it runs, hits are
appended to the filesystem the moment they are found, and an interrupted sweep
resumes on the next boot rather than starting over.

It also stops sweeping when the ECU stops answering. **A timeout and a negative
response mean opposite things:** a negative response is the ECU saying "no such
identifier", which is a result worth recording; a timeout is no answer at all. After
25 consecutive timeouts the sweep holds its position and probes every few seconds
until the car answers again.

Without that, switching the ignition off mid-sweep would record thousands of
identifiers as "no response" — turning an unswept range into one that looks swept
and empty. That is the same class of silent wrong answer as the `ATCRA` bug in
[FINDINGS](docs/FINDINGS.md), and it matters here because the whole value of the
sweep is its negative result.

### Trend history

The board keeps one hour of RPM, speed, boost and coolant at 6-second resolution and
serves it at `/history`, so the sparklines have shape the moment the page loads
instead of starting flat.

It survives restarts, which matters more than it sounds — the board restarts
constantly in normal use, so history in ordinary RAM would be wiped every time you
got back in the car. How it restarts depends on how it is powered: from the
accessory socket the power is simply cut when the car goes off; from the
permanently-live OBD pin 16 it deep-sleeps after 10 idle minutes and wakes every
30 s, running `setup()` each time.

| Store | Survives | Written |
|---|---|---|
| RTC slow memory (4.8 KB) | deep sleep | every 6 s, free |
| NVS (flash) | power loss | every 6 s (each new sample), and before sleeping |

Which store matters depends on how the board is powered. Wired to the ignition it
simply loses power when the car goes off — RTC memory does not survive that, and the
save on the way into deep sleep never runs, so the periodic flash write is the only
thing keeping a trip's history. It runs on every new sample, so switching off costs
at most 6 seconds. Wired to the permanently-live pin 16 the board deep-sleeps
instead, and RTC memory carries the buffer across for free.

Flushing that often is only affordable because a flush writes **the 400-byte chunk
that moved**, not the whole 4800-byte ring. Rewriting all of it — which is what it
did until v1.3.0 — costs somewhere over a flash sector erase per save, so shortening
the interval that way would have burned through NVS endurance in a couple of years.
Chunked, ten times the flush rate still churns less flash than the old
sixty-second full-buffer write did.

### What car is this

Every other part of this firmware is written against one vehicle. The PID batches
are the set a Nexon replies to, the DID register is 214 verdicts about a Nexon's
ECU, and the dashboard draws tiles for readings that car publishes. Plugged into
anything else, none of that announces itself — the tiles that cannot be filled read
blank, which is indistinguishable from a car that is simply not answering yet.

So the board asks, once per boot: the mode 01 support bitmaps block by block, then
mode 09 for the VIN, the calibration id and its checksum, then one probe at the
transmission's responder id. `/vehicle` reports the answers, including which of the
PIDs the sampler actually polls this car supports.

This is **discovery, not adaptation**. The sampler still asks for the same PID set
and an unsupported reading still comes back absent — it is now labelled
absent-because-unsupported rather than absent-because-silent, which is the whole
difference between a dashboard that is broken and one that is honest. Adapting the
batches at runtime needs a vehicle-profile format, and designing that against a
sample of one car would be designing it blind.

Three states throughout, never two. A support block whose bitmap never arrived reads
*unknown*, not *no*; a mode 09 refusal is a fact about the car, a timeout is a fact
about the last few seconds. Nothing answering at the second responder id is reported
as exactly that, never as "no second ECU" — a module that is not fitted and one that
is not awake produce the same nothing on a CAN bus.

### Backup, restore, and the check in between

A sweep is over half an hour on CAN and the better part of a day over BLE, the
register behind it takes drives to build, and the trip logs are the drives
themselves. All of it lives on a 1.5 MB partition inside a device that gets
unplugged, reflashed and left in a hot car.

The Board page takes the lot off as a ZIP, puts it back, and clears it. The archive
is assembled **in the browser** — the board has one core and a car to poll while it
serves you, so it offers a list (`/files`), a reader (`/file`) and a writer
(`/file/put`) and the page does the work. Entries are STORED, never deflated, so the
file opens with any unzip tool and the reader that puts it back is a header walk
rather than an inflater shipped into a 300 KB budget.

The reason any of this needs the section above: `didmap.csv` is 214 verdicts about
one specific engine and nothing inside it says which. Restored onto a different car
it would not fail — it would attach, silently, and every conclusion drawn from it
afterwards would be about the wrong engine. So a backup carries a manifest holding a
hash of the VIN and calibration id, and a restore compares it. A mismatch is refused
outright with no way past it. A backup or a board with no identity at all is the
ordinary state of a car that has not been driven yet, and that is put to the person
as a question rather than answered on their behalf.

The manifest carries the hash, not the VIN. It answers the only question the archive
is asked exactly as well, and a backup is a file that gets copied to a phone and a
laptop.

### One board, one car

Everything this board accumulates is about a particular vehicle — the sweep's hits
are that car's identifier space, the register is verdicts about that car's ECU, the
trip logs are that car's drives. None of it carries a vehicle in the record itself,
so mixing two cars does not produce a detectable error. It produces a file that is
quietly wrong forever.

So the binding is explicit. The board stores the key of the car it belongs to, and
in a car that is **provably** a different one it records nothing: no sweep, no
triage, no trip log, no correlation. The live dashboard keeps working, because it
reads what the car is doing now and persists none of it — and a board showing a
blank screen in the wrong car would be useless at exactly the moment somebody wants
to glance at a temperature. It also bounds the filesystem, which is the other half
of the reason: a 1.5 MB partition holding one car's data is comfortable and two
cars' is not.

A banner then offers the only choice that is anyone's to make: **onboard this car**,
which erases the previous one's data and starts again, or **keep the other car**,
which leaves the binding alone and gives this one live readings only.

Three answers, not two, and the middle one is the important one. A key exists only
once mode 09 has answered, so "the keys differ" and "there is no key" are completely
different facts and only the first stops anything. Reading absence as a mismatch
would silently disable recording on every car that declines mode 09, and the
symptom — a board that runs, shows live data and never writes a trip log — is one
nobody would diagnose.

### The autopilot

The investigation used to be four phases and three decisions, hours apart, with the
last step done by hand in a spreadsheet. Nobody chooses differently at any of those
points, which is what makes it automatable — and the phases outlast anyone's
attention, so a prompt between them is one that gets missed.

Started once, the board sweeps the identifier space, triages the hits to find which
move, then watches the ones that move eight at a time, fitting each against the live
readings. It advances on its own and keeps its phase in NVS, because the ignition
going off is a power cut and this pipeline is measured in drives:

- **Sweep** — about 30 minutes on CAN, the better part of a day over BLE.
- **Triage** — about an hour of engine-on. This adapter answers roughly half of what
  it is asked, so ten clean reads of every hit needs about twenty passes.
- **Watch** — one drive per eight identifiers, so eight or nine drives for a
  register the size of this car's.

The watch set rotates between drives and never during one: changing it bumps the
watch generation, which rotates the trip CSV, and rotating mid-drive would turn one
drive into a pile of short files.

Two things it will not do. A sweep that finds nothing is a **conclusion** — this ECU
does not answer service 0x22 — not a reason to sweep again. And a car the board is
not bound to **holds** the pipeline rather than ending it, so an afternoon in
somebody else's car does not cost the drives already spent.

### The board does the fitting now

Watching logs an identifier beside rpm and coolant; something then has to fit one
against the other. That was the only step still done by a person, it is the same
arithmetic every time, and it is why a board that had collected everything needed to
answer "what is 1002" still could not say anything about it.

A Pearson correlation is six running sums. Eight watched identifiers against six
reference signals is forty-eight of them, which is nothing on an ESP32, and the best
fit goes into the register as three new columns — so `/didmap.csv` now carries
`tracks,r,samples` on the end. They are appended rather than inserted so a register
written by an older firmware still loads; that file is what a restore puts back, and
a format that rejected last month's backup would throw away hours of bus time to
gain a column.

**It says "tracks", never "is".** Everything under a bonnet correlates with
everything else — oil temperature tracks coolant almost perfectly, and both track
runtime after a cold start — so a strong fit narrows the field rather than settling
it. r is also unchanged by offset and scale, so a perfect correlation still leaves
the units unknown. Naming an identifier stays a human act, which is why
`DID_IDENTIFIED` outranks every machine verdict.

A pair is only counted when **both** sides are present. This adapter drops roughly
half of what it is asked, and folding a missing reply in as a zero would fit the
dropout pattern rather than the car — convincingly.

### Being left in the car

The board deep-sleeps after ten minutes with no ECU response. That timer answers
*the car is off*, which is the ordinary case, and it does not answer *the battery is
going flat* — the two come apart exactly where it matters. An ECU that keeps
answering with the engine stopped (ignition on at the roadside, a long session
parked, a module that stays awake) resets the idle timer on every reply, so the
ten-minute guard never arms and the board keeps drawing from a battery nothing is
charging.

So there is a second floor under it: **below 11.8 V for thirty continuous seconds
with the engine stopped, the board shuts down.** A lead-acid battery at rest sits
near 12.6 V; 11.8 V is roughly a quarter charged and about where a cold start stops
being a certainty.

Three things keep it from firing when it should not, and each is tested:

- **Cranking does not trip it.** The rail sits at nine volts and below for about a
  second while the starter turns, which is the one moment the reading is low and
  switching off would be exactly wrong. Thirty continuous seconds is well past any
  crank, and past the sag from a fan or a heated screen starting up.
- **A turning engine is proof something is charging**, whatever the rail reads, so
  any rpm above 300 breaks the run outright.
- **An absent reading is never a low reading.** An unread voltage and an unknown
  engine state both break the run rather than counting toward it, and the guard is
  fed the sample only while it is fresh — a voltage from ten minutes ago must not
  switch the board off now. That is the idle timer's job and it is already running.

> **The idle draw has not been measured.** The guard above bounds the worst case at
> a battery that can still start the car, but no number for what this board actually
> pulls — asleep, or awake with the AP up — has been put on a meter yet. Until it
> has, treat the advice below about unplugging a parked car as applying to the board
> as much as to the adapter.

The onboard LED encodes state, which matters when the board is hidden under the dash:

- **slow blink (1 Hz)** — alive, Wi-Fi up, ECU not answering
- **fast blink (5 Hz)** — talking to the ECU
- **double-blink** — DID scan running

---

## Frontend

The dashboard is a Preact app under `web/`, built with Vite and served off the
board's filesystem. It is not compiled into the firmware.

```bash
npm --prefix web install
npm --prefix web test          # 206 checks
web/deploy.sh                  # build, then upload to 192.168.4.1
```

**It ships two ways, and the order matters.** The built bundle is compiled into the
firmware, so flashing the board is the whole install. A bundle uploaded to LittleFS
overrides it, which is what keeps the edit loop cheap: changing a line of CSS costs a
27 KB upload, not a 1.3 MB reflash.

That is not a return to what v1.11.0 removed. What went then was hand-written
JavaScript inside C++ raw string literals — no bundler, no packages, no source maps,
and nothing in the build that ever parsed it, so a typo shipped and surfaced as a
dead dashboard in the car. All of that stays gone. `web/scripts/embed.mjs` reads the
output of the ordinary Vite build, after the ordinary Vitest suite, and turns the
finished gzipped bytes into a byte array. Nothing about how the frontend is written,
bundled or tested changes — only where a copy of the result ends up.

What it buys is that there is no state where the board runs and has no page. Someone
who flashes through [`docs/flash/`](docs/flash/) has a working dashboard the moment
it boots, rather than needing a laptop, the board's Wi-Fi and `web/deploy.sh` first.

**Why the board and not a web host.** The access point has no internet, so a phone
joined to it cannot load a page from anywhere else. Chrome 142 relaxed mixed-content
checks for literal private IPs behind a permission prompt, so an HTTPS page *can*
now reach `192.168.4.1` — but only on Chrome, only if the permission was granted
before you got in the car, and Android 17 adds a second prompt on top. Serving from
the board has none of those conditions: no mixed content, no CORS, no permissions, no
internet, any browser.

**Deploying cannot brick it**, and the floor is higher than it was. `/ui` is compiled
into flash, so the page that fixes a bad deploy never depends on the deploy having
worked. If no bundle is installed, or the upload was interrupted, `/` falls back to
the dashboard compiled into the firmware — the whole thing, not a four-value stub.
Trip logging, the DID sweep and the history buffer are the board's work and run
regardless of what the browser can see.

| | |
|---|---|
| Bundle | 27 KB gzipped, **one file**, compiled in and overridable |
| Budget | 300 KB, capped in the build and enforced by the firmware on upload |
| Shares with | trip logs — 300 KB is about 35 minutes of recording capacity |

The build inlines the script and stylesheet into `index.html`, so a deploy is a
single `index.html.gz`. That is not for the bytes — one gzip stream over the lot is
barely smaller than three — but for how it gets installed: the board is updated from
a phone standing next to a car, and a firmware update is one `.bin`, so the frontend
should cost no more than that.

The firmware serves it with `Content-Encoding: gzip` and `no-cache`, so a new deploy
is always picked up, and answers `/monitors`, `/trips`, `/watch` and `/scan` as
redirects into the app's routes so old bookmarks keep working.

**The `/data` contract** is declared in `contract/data.json` and checked from both
ends — the firmware test asserts it against `handleData()` in both directions, so a
field renamed on one side fails the build instead of blanking a gauge on the road.

---

## Hardware

### Option A — no extra parts

Uses a dual-mode ELM327 clone over **BLE GATT**. The ESP32-S3 has **no Bluetooth Classic
radio**, so it cannot use the usual SPP path — but many ELM327 clones also expose a BLE
interface, and this firmware drives that.

Check yours advertises service `FFF0`. On the unit this was built against:

```
BLE address 81:23:45:67:89:BA   name "OBDBLE"
  SERVICE 0000fff0
    CHAR 0000fff1  Read, Notify               <- responses
    CHAR 0000fff2  WriteWithoutResponse, Write <- commands
```

Note the BLE address is the Classic MAC with the top bit of octet 0 set
(`01:…` → `81:…`). Set `ELM_BLE_ADDR` in `elm_ble.h` to match your adapter.

### Option B — direct CAN (recommended)

| Part | Notes |
|---|---|
| **SN65HVD230** transceiver | **3.3 V part.** Do *not* use TJA1050 or MCP2551 — they are 5 V logic and will damage the ESP32's RX pin |
| 12 V→5 V buck (MP1584/LM2596) | Set output to 5 V *before* connecting the board |
| OBD-II male pigtail | |

**Wiring**

| XIAO ESP32S3 | SN65HVD230 |
|---|---|
| D1 (GPIO2) | CTX / D |
| D2 (GPIO3) | CRX / R |
| 3V3 | VCC |
| GND | GND |

| SN65HVD230 | OBD-II pin |
|---|---|
| CANH | 6 |
| CANL | 14 |

Power from OBD pin 16 (+12 V) and pin 4/5 (GND) into the buck, 5 V out to the XIAO's `5V` pad.

> **Remove the 120 Ω termination resistor** on the transceiver breakout. The vehicle bus
> is already terminated at both ends; a third terminator causes bus errors.

> **OBD pin 16 is permanently live**, so anything plugged into the OBD port draws
> from the battery whether the car is running or not. That includes a BLE ELM327
> adapter — clones typically pull 20–50 mA, roughly 0.5–1 Ah a day — so unplug the
> adapter if the car is parked for more than a few days. This applies to the adapter
> even when the board itself is powered from the accessory socket and switches off
> with the ignition; the two are independent.
>
> The board deep-sleeps after 10 minutes with no ECU response, which protects the
> battery only if the board is itself wired to a permanently-live supply.

---

## Building

```bash
firmware/build.sh              # tests, then compile
firmware/build.sh --upload     # …then flash over USB (PORT=… to pick the port)
```

If you already have `arduino-cli` with the ESP32 core — an Arduino IDE install counts
— it uses that and downloads nothing. Only on a machine with neither does it install a
private copy into `firmware/.toolchain/` (~6 GB unpacked, several minutes), and that
install writes nothing outside the repo, so deleting the directory undoes it
completely. `OBDURATE_ISOLATED=1` forces the private toolchain, which is what CI
wants: a build that depends on whatever happens to be on the machine is not
reproducible.

The upload port is guessed from `arduino-cli board list`, taking only a port it
recognises as an ESP32 — Windows has several Bluetooth serial ports that must not be
flashed at. Override with `PORT=COM3` or `PORT=/dev/ttyACM0`.

> Building needs `g++`, `python3` and `node` on `PATH` for the host tests, which run
> before the compile. Contributor notes for the development machine — including where
> its compiler lives and how to read the board's serial log on Windows — are in
> [`CLAUDE.md`](CLAUDE.md).

The output you want is **`firmware/build/Obdurate-v<version>.bin`** — the app image,
which is what `/update` takes. The version comes from
[`firmware/Obdurate/version.h`](firmware/Obdurate/version.h); bump it there and the
filename, the dashboard header and the serial banner all follow.
`Obdurate.ino.merged.bin` in the same directory is a full-flash image for USB
recovery; feeding *that* to `/update` will not work.

By hand, if you would rather not use the script:

```bash
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32

arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3 --output-dir build firmware/Obdurate
arduino-cli upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32S3 firmware/Obdurate
```

Current size: **1.26 MB flash (37 % of `app0`)**, 49 KB RAM (15 %), plus 4.8 KB of
RTC slow memory for the trend buffer. The frontend is no longer part of that: it is
a 22 KB gzipped bundle on the filesystem, and moving it out returned 47 KB of flash.

The default `default_8MB` partition already provides `ota_0` + `ota_1` at 3.19 MB each,
so OTA works without changing the partition scheme.

### Tests

```bash
firmware/test/run.sh          # needs g++, python3 and node — no ESP32 core, no board
```

The ISO-TP layer and the mode-01 batch poller are extracted straight out of
`Obdurate.ino` and compiled against fake TWAI and ELM327 shims, so frame sequences
that are impractical to stage against a real car — a dropped consecutive frame, a
reordered sequence number, a reply that stops halfway — are covered. The same shims
stand in for the web server, so the deadline give-back described above is tested for
the two properties that make it safe: a silent ECU is still reported silent, and the
extension is bounded. Everything else the sketch
can be asked about without a board — the `/data` contract, the routing, the caching
headers, the DID watch wiring, the trip columns, the history constants — is asserted
against the source under node.

The frontend has its own suite, `npm --prefix web test`: 371 checks over the
hold-last-value merge, the warning-flag gating, the rate tracker, the mileage
readouts and each page's logic, run against the modules that implement them. That is
the point of the split — those used to be JavaScript inside C++ raw string literals,
which nothing in the build ever parsed, so a typo shipped and surfaced as a dead
dashboard in the car.

The "All values" table is checked in a real browser instead, because the node
harness structurally cannot check it: its fake DOM creates any element asked for by
id, so a table whose cells are built once and then addressed by id passes whether or
not those ids line up with the rows — the whole suite goes green with every value
shown against the wrong PID. `test_table.mjs` renders the built bundle and
the built bundle, drives it through a full sample, a partial poll and a recovery,
and asserts that row *i* shows the value of the PID row *i* names. It skips itself, without failing, where
Playwright is not installed.

To look at the pages without flashing anything:

```bash
node firmware/test/shots.mjs out/     # needs playwright + chromium
```

It serves the real pages against a mock `/data` and screenshots them at phone and
tablet widths across four states — cruising, a partial poll, warnings, and ignition
off. The partial-poll shot is the one worth checking after any change to the polling
code, since that is the state that used to blank the dashboard.

### OTA

Run `firmware/build.sh`, join `Obdurate`, and upload
`firmware/build/Obdurate-v<version>.bin` at `http://192.168.4.1/update`. The header
shows the new version once it reboots, which is how you confirm the flash took.

The board runs from `app0`; an upload streams into `app1`; `otadata` only flips once
`Update.end()` verifies the image, then it reboots. An interrupted or corrupt upload never
touches `otadata`, so **a failed OTA cannot brick the board** — it reboots into the
firmware it was already running.

So the loop is: build locally → copy the `.bin` to your phone → join the board's Wi-Fi →
upload at `/update`. No dev machine needed at the car, only to produce the image.

> **CI is not in use.** [`ci/build.yml`](ci/build.yml) is kept current — it runs the host
> tests and compiles the firmware — but it is parked outside `.github/workflows/`, since
> pushing there needs the `workflow` OAuth scope this repo's token lacks. Build locally
> with `firmware/build.sh`. To enable CI later:
>
> ```bash
> gh auth refresh -h github.com -s workflow
> git mv ci/build.yml .github/workflows/build.yml
> git commit -m "Enable CI" && git push
> ```

---

## Before you use this

Change the access point credentials in `Obdurate.ino` — they are placeholders, and the
board is an open target on any network it creates:

```cpp
static const char *AP_SSID = "Obdurate";
static const char *AP_PASS = "changeme1234";   // >= 8 chars
```

`/update` has **no authentication**. Anyone who can join the AP can flash the board, so a
strong `AP_PASS` is the only thing protecting it.

Set `ELM_BLE_ADDR` in `elm_ble.h` to your own adapter's BLE address — the one committed
here is from the unit this was developed against.

---

## Architecture

```
                    ┌───────────────────────────┐
  phone ──Wi-Fi AP──┤  XIAO ESP32S3             │
                    │   WebServer :80           │
                    │   bundle (LittleFS) + API │
                    │                           │
                    │   obdIsoTp() dispatcher   │
                    │      ├── canIsoTp  (TWAI) ├──SN65HVD230──┐
                    │      └── bleIsoTp  (GATT) ├──BLE──ELM327─┤ OBD-II
                    └───────────────────────────┘              │  pins 6/14
                                                               ▼
                                                            vehicle CAN
```

Both transports implement the same contract — request bytes in, reassembled ISO-TP
payload out — so mode 01, mode 03 and UDS `0x22` are written once and work on either.

`chooseTransport()` prefers CAN when the transceiver answers, else falls back to BLE.
While the ECU is silent it re-evaluates on a backoff — 2 s, then 4, 8, 16, settling
at 20 — resetting to impatient as soon as data arrives.

That matters when the adapter outlives the board, which is the usual split: the OBD
port is always live but an accessory-socket supply is not. Every start then meets an
ELM327 that may still be holding the BLE link to a board that vanished without
disconnecting, so the first connect can fail for a reason that clears itself within
seconds. A flat retry interval meant a dead dashboard for that whole interval at
every ignition.

---

## Safety

This firmware is **read-only by design**, and since v1.12.0 that is a test rather
than a promise. Every request buffer in the sketch is found from its call sites, its
service byte read out of the source, and checked against the list of reads. Adding a
write service fails the build and names it.

What it actually sends, as the check reports it:

| Service | |
|---|---|
| `0x01` | mode 01 live data |
| `0x03` | mode 03 stored fault codes |
| `0x06` | mode 06 on-board monitor results |
| `0x22` | UDS ReadDataByIdentifier |

plus ISO-TP flow control. It never sends:

| Service | Why not |
|---|---|
| `0x2E` WriteDataByIdentifier | writes ECU memory |
| `0x31` RoutineControl | triggers actuators |
| `0x11` ECUReset | resets a live ECU |
| `0x10` DiagnosticSessionControl | changes ECU state |
| `0x27` SecurityAccess | unlocks protected functions |
| `0x14` ClearDiagnosticInformation | erases the car's own record |

> This table used to claim mode 07 (pending codes) and mode 09 (vehicle info) as
> well. Neither is sent — there is no `0x07` or `0x09` request anywhere in the
> sketch, and the sketch's own header comment made the same claim. Writing the check
> is what found it. Both are reads and both are worth having; they are simply not
> implemented yet.

A request is also bounded now. An ISO-TP single frame is one PCI byte and seven of
payload, and the request was copied into an eight-byte stack buffer with nothing
checking the length. The largest caller in the tree — the mode 01 batch, six PIDs
plus the mode byte — passes exactly seven. At the limit, with nothing spare: a
seventh PID in a batch, or packing two identifiers into one `0x22` request to get
the obvious threefold throughput win, would have written past the frame and said
nothing about it.

Run scans **parked**. Reading is safe; a stalled request while driving is not worth the risk.

---

## Documentation

- **[docs/FINDINGS.md](docs/FINDINGS.md)** — what this specific car exposes, and the
  adapter quirks that cost hours to discover
- **[docs/TOOLS.md](docs/TOOLS.md)** — the PowerShell scripts in `tools/`

## Licence

MIT — see [LICENSE](LICENSE).

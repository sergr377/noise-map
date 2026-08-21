# CLAUDE.md

Road traffic noise map: OpenStreetMap → CNOSSOS-EU → isophones on Yandex Maps.
[README.md](README.md) is the documentation for people. This file holds what you
need in order to work on the code without walking into rakes already stepped on.

## Commands

```bash
npm run server      # builds TS, serves the API on :8787 (and dist-web if built)
npm run web         # Vite on :5174, proxies /api to :8787
npm run typecheck   # server and web, both strict
npm run build:web

node scripts/run-job.mjs --lat 55.7649 --lon 37.6055   # compute directly, no API
node scripts/sanity-check.mjs <geojson> DEN            # did building screening survive
node scripts/compare-runs.mjs <a> <b> DEN              # two runs compared by band area
node scripts/rail-probe.mjs <lat> <lon>                # what OSM knows about track nearby

# needs the server built first (npm run build:server):
node scripts/check-quantize.mjs                        # cache grid idempotence

# needs the API running on :8787:
node scripts/prewarm.mjs moscow                        # warm the demo cache
node scripts/smoke-api.mjs                             # end-to-end check of the HTTP layer
```

`inspect_db.groovy` dumps table schemas from a job database — this is how you find
out what a NoiseModelling block actually produced:

```bash
NM_TABLES=LW_RAILWAY,ROADS .tools/nm/NoiseModelling_6.0.0/bin/ScriptRunner \
  -w jobs/<id> -s pipeline/inspect_db.groovy
```

## Computation is expensive, and that shapes everything

A cold job takes **6–27 minutes across every core and up to 2.2 GB**. Therefore:

- **`POST /api/noise` is not a probe — it starts work.** There is currently no way
  to ask whether a location has been computed without computing it. It is easy to
  tie the machine up for half an hour this way. `DELETE /api/noise/:id` takes it
  back: use it after any job started by mistake instead of waiting it out.
- **Starting jobs is rate limited** — two in a burst per address, six an hour.
  Cache hits are not charged, so the prewarmed points stay free to click. The
  limit does not apply to loopback, which is why local scripts do not trip it.
- Do not start jobs speculatively. For checks use the prewarmed points: Tverskaya
  `55.7649,37.6055`, Sadovoye `55.7708,37.6335`, Khamovniki `55.7315,37.5806`.
  They are warm for the current `JOB_PARAMS`; changing any of those parameters
  empties the cache in effect and the three cost half an hour to warm again.
- Run long jobs in the background and poll no more often than every few tens of
  seconds.

## Environment

- **Java is required.** The NoiseModelling distribution lives in `.tools/` (148 MB,
  not in git). Its bytecode targets Java 11; locally it runs on JDK 25.
- **Node 22's `fetch` ignores `HTTPS_PROXY`.** This machine runs a local proxy, and
  without it some hosts look dead rather than unreachable. The dispatcher is
  installed in `scripts/lib.mjs` and `server/src/config.ts` — **any new code that
  makes network calls must import `lib.mjs` or set up its own `ProxyAgent`.**
- **The variables have to be in the environment of the *server* process**, not
  just in some shell. A server started from a terminal without them reaches
  neither Overpass nor the terrain tiles, so every job dies at its first stage
  and the map looks broken everywhere at once. This has happened; the server now
  prints whether a proxy is configured at startup, and a job that dies before it
  has any OSM data says so instead of blaming the location.
- **Docker cannot be built here**: virtualisation is disabled in firmware and the
  session has no administrator rights. The `Dockerfile` exists but has never been
  built.
- The engine launcher is named differently per platform: `ScriptRunner.bat` on
  Windows, `ScriptRunner` on Linux. The `process.platform` branch already exists —
  do not hardcode it back.

## Keys and secrets

There are **two different keys** and they are not interchangeable:

- `VITE_YANDEX_API_KEY` — JavaScript API, the map itself. Vite inlines it into the
  bundle at build time; that is fine, it is restricted by HTTP Referer.
- `YANDEX_GEOCODER_KEY` — HTTP Geocoder, address search. **Deliberately without the
  `VITE_` prefix**: it carries no referer restriction and must never reach the
  browser. The frontend goes through `/api/geocode`.

Before every commit:

```bash
git grep -n --cached -e <key-fragment>
```

and **do not commit if it matches**. A key once reached the history along with
`dist-web/` precisely because this check printed a warning without blocking.
`dist-web/` is now in `.gitignore`.

## NoiseModelling rakes

The full annotated list is in the README under "Грабли". The ones that bite most:

- `exec` signatures differ between blocks: some take `(Connection, input)`, others
  also have a `ProgressVisitor` overload. An extra argument throws
  `MissingMethodException`.
- Use `Delaunay_Grid`, not `Regular_Grid`: `Create_Isosurface` consumes the
  `TRIANGLES` table that only Delaunay produces.
- **`Delaunay_Grid` keeps only the *envelope* of its `fence`** — see
  `setMainEnvelope` in `scripts/Receivers/Delaunay_Grid.groovy` inside the
  distribution. Passing a circle changes nothing; receivers always fill the
  enclosing rectangle. The round display area is cut at the end of the pipeline,
  by intersecting the dissolved isophones with a disc, which is why roughly a
  fifth of the receivers are computed and then thrown away.
- **`RECEIVERS_LEVEL` fills during the run, not at the end.** `NoiseMapWriter`
  drains results in batches from its own thread and commits them, so a second
  connection to the embedded database — `jdbc:h2:<jobdir>/h2gisdb`, user `SA`,
  password `sa`, opened from the same JVM — sees the table grow while
  propagation is still going. Measured, not assumed; this is what the partial
  frames are built from.
- **That table has no key until the run ends** — the writer applies primary keys
  as its last act. Anything reading it mid-run must copy the rows it needs into
  its own indexed table first, which is what the frame builder does. Without
  that, `IsoSurface` spends minutes per frame in full scans, and a freshly
  created helper table without a primary key turns the triangle filter into a
  nested-loop scan. Both were measured the hard way.
- **Diffraction is off by default.** Without it a courtyard scores the same as the
  street, and the map degrades into "distance from the nearest road".
- `confMaxSrcDist` defaults to 150 m — distant main roads silently drop out. It is
  also the only knob that makes propagation dramatically cheaper: dropping it from
  350 m to 150 m took a Tverskaya run from ~910 s to 135 s, at the price of 9.9% of
  the area moving a band and the whole map reading 1.1 dB low.
- **`maxArea` is not a throttle on urban geometry.** Multiplying it by eight
  changed the receiver count by 1.3% (34 101 → 33 666) and the runtime not at all:
  `Delaunay_Grid` builds its mesh from building and road outlines, and the area cap
  almost never binds where there is anything to compute. Measured, after it was
  proposed as the basis of a cheap rough prepass.
- Results come out in a metric projection; the web needs `Change_SRID` to 4326.
- `CREATE TABLE AS SELECT` leaves columns nullable in H2 and a primary key will not
  accept them — `SET NOT NULL` first.

## Cancelling, and why it is not a kill switch

`cancelJob` removes one waiter and only stops the pipeline when the count reaches
zero. Requests for the same cell share a run, so a plain kill would let one
client abort someone else's calculation. Two consequences worth remembering:

- **A caller that leaves without a DELETE keeps the job alive** — a closed tab
  still computes and still fills the cache. That is deliberate: the browser does
  not promise to send anything on unload, and cancelling on a dropped SSE stream
  would break an ordinary page reload.
- **Killing has to reach the JVM.** The chain is server → `run-job.mjs` →
  ScriptRunner → java, and only the last link is expensive. Hence `detached` on
  POSIX plus a negative-pid signal, and `taskkill /T` on Windows. The flip side
  of `detached` is that pipelines no longer die with the terminal, so the server
  stops them on SIGINT/SIGTERM — do not remove that hook.

A cancelled job stays in the map as a tombstone so late readers see the final
state. `startJob` must therefore replace it rather than join it, and the eviction
timer checks identity before deleting — otherwise it removes the *new* job that
took the same id.

## One run per job directory

A job directory is named after the point (`jobs/<lat>_<lon>_r<radius>s<srcRadius>`)
and the files in it — `h2gisdb*`, `isophones.geojson`, `partial-N.geojson` — have
fixed names, so two runs of the same point share one H2 database and interleave
its tables. That is not hypothetical: on 2026-08-19 a server was killed with
`taskkill /F`, its pipeline outlived it, and the next click on the same point gave
a second map. `run-job.mjs` now takes `jobs/<id>/run.lock` before writing anything
— creating the file with `wx` is the atomic part — and a second run refuses,
reporting itself through an `@@ERROR` marker that the server shows as-is.

- **The lock is a heartbeat, not just a file.** The holder touches it every 15 s.
  It counts as abandoned when it has been untouched for a minute **or** its pid is
  gone. Both halves matter: pids get reused, and a killed run leaves a file that
  is still fresh — without the pid check a cancelled job could not be restarted
  for a minute.
- **Releasing it is best effort.** The exit hook and the SIGINT/SIGTERM handlers
  remove it, but `taskkill /F` runs nothing, so correctness rests on the takeover
  above rather than on cleanup.
- **The directory stays per-point on purpose.** A per-run subdirectory would also
  have prevented this, but the directory doubles as a cache: the OSM extract and
  the DEM raster are reused by later runs of the same point.

## The preview pass

Before the real propagation, the pipeline runs a cheap one — same receiver mesh,
same buildings, sources within `PREVIEW_SRC_DIST` metres and no terrain — and
exports it as `jobs/<id>/preview.geojson`. That is what a waiting caller sees:
the whole disc about a minute after the click (67 s measured end to end) instead
of a quarter of it after ten.

- **Source distance is the only real cost lever, and it is the whole trade.**
  On Tverskaya, against the exact map: 150 m costs 97 s of propagation and lands
  1.1 dB low with 9.9% of the area a band off; 75 m costs 38 s and lands 2.7 dB
  low with 19.0% a band off. The default is 75 — a complete map sooner beats a
  truer one later when the exact answer is a quarter of an hour away — and the
  note in `App.tsx` quotes those very numbers, so **the two move together**.
  Terrain is the second lever (926 → 575 s) and `maxArea` is not a lever at all
  — see the NoiseModelling rakes above.
- **Terrain stays out of the preview.** With it the pass costs 160 s instead of
  97 and lands no closer to the answer (10.2% of the area in a neighbouring band
  against 9.9%): dropping terrain raises levels, dropping far sources lowers
  them, and the two errors partly cancel.
- **One mesh for both passes.** The isophone geometry then matches, so the exact
  result recolours the map in place instead of redrawing it. Do not "optimise"
  the preview by giving it its own grid.
- **The preview must be dropped before the real pass**, tables and all
  (`RECEIVERS_LEVEL`, `CONTOURING_NOISE_MAP`): the blocks append to whatever
  they find rather than replacing it.
- **Never cached, always labelled.** It reads about a decibel low; the interface
  says so, and `/api/noise/:id/preview` sends `Cache-Control: no-store`.

## Partial frames

Off by default (`PARTIAL_INTERVAL_MS=0`) since the preview arrived: a frame is
exact but covers a quarter of the disc, and **a frame must never replace the
preview** — on screen the map would appear to fall apart. The client enforces
that rule; the code below stays for the day delta frames make a second-by-second
render possible.

While a job runs, the pipeline exports the map as it stands into
`jobs/<id>/partial-N.geojson` and the server announces each one through the
`partials` counter in the SSE state; the client fetches it from
`/api/noise/:id/partial/:n`. Three rules hold this together:

- **The frame and the final result go through the same dissolve/clip code.** If
  they diverge, a frame shows something the answer will not.
- **Frames never reach the cache.** Only a finished result may be cached; the
  files are deleted with the job.
- **A frame is decoration.** It runs in the same JVM as the calculation, so its
  cost is capped by backing off to nine times the last frame's duration, and any
  failure inside it is logged and swallowed rather than allowed to fail the job.

`PARTIAL_INTERVAL_MS` sets the floor between frames; `0` turns them off. It is
deliberately not part of `JOB_PARAMS` — it changes nothing about the result, and
adding it there would invalidate the whole cache.

## Rate limits

Token buckets per IP in `ratelimit.ts`: `job` (starting a calculation), `geocode`
(someone else's quota) and `api` (everything else). The `job` bucket is charged
only where new work would begin — not on a cache hit, not on joining a running
job — and `/api/health` is not charged at all.

Progress streams are metered separately, by **occupancy rather than rate**
(`openStream`, capped by `STREAM_LIMIT_PER_IP`): an SSE connection holds a socket,
a listener and a timer for the whole calculation, and opening it costs a single
`api` token — so nothing in the buckets stops a client from leaving a hundred of
them hanging. The slot is released from both the stream's own close path and the
socket's `close` event, whichever comes first; **the release has to stay
idempotent**, because the count is per address and a double release would hand
back somebody else's slot.

Loopback is exempt from all of it so `prewarm.mjs` can run; set
`RATE_LIMIT_LOOPBACK=1` to test the limits locally. `X-Forwarded-For` is read only under `TRUST_PROXY=1`, because
trusting it on a directly reachable server disables the limiter for anyone who
sends the header.

## Cache

The cache key is derived from the rounded coordinates **and the calculation
parameters** (`JOB_PARAMS`). Changing any of them — radius, diffraction, terrain —
makes the whole cache unreachable, and the demo points must be **prewarmed again**.

Grid snapping must stay idempotent: the longitude step is computed from the
already-snapped latitude. `check-quantize.mjs` verifies this across ~88 000 points;
run it after any change to `quantize`.

## Frontend: what is easy to break

- **The map's panel inset is measured**, not derived from the breakpoint
  (`usePanelMargin.ts`). The panel's height depends on its content and its position
  flips between a bottom sheet and a side column.
- `margin` is applied when a location is set, not when the margin itself changes.
  That is why re-centring is bound to `resize` and **must not** be bound to the
  margin value: the panel also grows with progress and search results, and the
  camera would jerk on every such change.
- The progress bar **must not overtake what the server confirmed** by more than a
  few percent. Reports arrive tens of seconds apart; the sense of liveness comes
  from a locally ticking seconds counter, not from invented progress.
- Inside `.app`, only the map stretches to full height. The rule `.app > *` once
  inflated the panel to the whole screen.
- **The camera reports itself only when it moves.** `YMapListener`'s `onUpdate`
  never fires for a map that opens and is not touched, so the first viewport comes
  from reading `map.bounds` through a ref — and that entity is attached a tick
  after mount, with empty bounds until it is sized. Hence the retry loop in
  `MapCanvas`, and **hence a timer rather than `requestAnimationFrame`**: in a
  background tab the frame callback may never run, and the map would open without
  its shaded areas until the first pan.
- Only the camera **at rest** is passed upward. `onUpdate` fires on every frame of
  a drag, and forwarding those re-renders the tree sixty times a second.
- Computed areas are drawn as **one MultiPolygon feature**, not one per disc:
  overlapping discs then fill once instead of stacking transparency into a dark
  blob.

## The rail branch does not work

`--rail` is off by default and is not exposed through the server. Track extraction
and the emission step work; **the propagation pass does not finish** in reasonable
time. Trams are impossible outright — the CNOSSOS catalogue contains none. Details
and measurements are in the README. Do not treat this branch as working and do not
enable it by default.

## How work is done here

- **Measure, do not assert.** Any "faster" or "more accurate" is backed by numbers
  before and after; `compare-runs.mjs` and `sanity-check.mjs` exist for this.
- **Test the premise before building.** Terrain relief was measured before the DEM
  work; the vehicle catalogue and OSM tag coverage were checked before the rail
  work. One of those two tasks was abandoned as a result.
- **Write down negative results.** Thinning the terrain grid buys nothing — that is
  in the README so nobody tries it again.
- **Mark unverified things as unverified.** The Docker image was never built, and
  that is stated plainly in the README and in the file headers.
- Code comments are in **English**; this file is in **English**; the README and
  commit messages are in **Russian**.
- Comments explain *why*, not *what*. The valuable ones record a non-obvious
  choice: why `fence`, why a second propagation pass, why not `startsWith`.

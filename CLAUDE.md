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

A cold job takes **3–10 minutes across every core and up to 1.8 GB**. Therefore:

- **`POST /api/noise` is not a probe — it starts work.** There is currently no way
  to ask whether a location has been computed without computing it. It is easy to
  tie the machine up for half an hour this way.
- Do not start jobs speculatively. For checks use the prewarmed points: Tverskaya
  `55.7649,37.6055`, Sadovoye `55.7708,37.6335`, Khamovniki `55.7315,37.5806`.
- Run long jobs in the background and poll no more often than every few tens of
  seconds.

## Environment

- **Java is required.** The NoiseModelling distribution lives in `.tools/` (148 MB,
  not in git). Its bytecode targets Java 11; locally it runs on JDK 25.
- **Node 22's `fetch` ignores `HTTPS_PROXY`.** This machine runs a local proxy, and
  without it some hosts look dead rather than unreachable. The dispatcher is
  installed in `scripts/lib.mjs` and `server/src/config.ts` — **any new code that
  makes network calls must import `lib.mjs` or set up its own `ProxyAgent`.**
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
- **Diffraction is off by default.** Without it a courtyard scores the same as the
  street, and the map degrades into "distance from the nearest road".
- `confMaxSrcDist` defaults to 150 m — distant main roads silently drop out.
- Results come out in a metric projection; the web needs `Change_SRID` to 4326.
- `CREATE TABLE AS SELECT` leaves columns nullable in H2 and a primary key will not
  accept them — `SET NOT NULL` first.

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

/**
 * NOT FINISHED — see "Железнодорожный шум" in the README.
 *
 * Everything here works: geometry is extracted and the emission step produces
 * LW_RAILWAY. What does not work is the propagation pass that consumes it, which
 * fails to complete in reasonable time even on a plain two-track line. Kept
 * behind `--rail`, off by default, so the road path is unaffected.
 *
 * Railway geometry from OpenStreetMap, with the assumptions the CNOSSOS rail
 * module needs but OSM does not carry.
 *
 * What OSM gives: geometry, and sometimes usage and maxspeed.
 * What it never gives: track count (tagged on 0% of ways in central Moscow) and
 * train counts. Those are assumed here, and every assumption is spelled out —
 * this layer is a much rougher estimate than the road one, which at least has
 * an official European default table behind it.
 */
import { writeFile } from 'node:fs/promises';
import './lib.mjs'; // installs the proxy dispatcher

const OVERPASS = 'https://overpass-api.de/api/interpreter';

/** Line speed when OSM does not say. Suburban and mainline differ enough to split. */
const ASSUMED_SPEED = { main: 100, branch: 60 };
/** Track count is never tagged; a running main line is assumed double-track. */
const ASSUMED_TRACKS = { main: 2, branch: 1 };

/**
 * Track parameter identifiers. These are the generic European entries from
 * CNOSSOS — unlike the vehicle catalogue, the track side is not France-specific.
 * The values are the ones NoiseModelling's own documentation uses as examples,
 * not measurements of any particular Russian track.
 */
export const TRACK_DEFAULTS = {
  transfer: 'EU7',
  roughness: 'EU3',
  impact: 'EU1',
  bridge: '',
  curvature: 0,
};

/**
 * Stand-in rolling stock. The bundled catalogue holds 80 French SNCF trainsets
 * and one high-speed test train — no Russian stock and no trams. A Transilien
 * suburban EMU is the closest analogue to an ЭД4М: electric multiple unit,
 * comparable length and line speed. It is a substitution, not a match.
 */
export const TRAIN_TYPE = 'Z20500-5U1';

/** Night traffic as a share of the daytime figure the user supplies. */
export const NIGHT_SHARE = 0.25;

export async function fetchRail(bbox, outPath) {
  const { south, west, north, east } = bbox;
  // Running lines only: tunnels radiate nothing at the surface, and yard or
  // siding tracks carry shunting rather than trains at line speed.
  const query = `[out:json][timeout:180];
(
  way["railway"~"^(rail|light_rail|narrow_gauge)$"]["tunnel"!="yes"]["service"!~"."](${south},${west},${north},${east});
);
out tags geom;`;

  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'noise-map/0.1 (rail extraction)',
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status} при загрузке путей`);

  const ways = (await res.json()).elements ?? [];
  const features = [];

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const main = way.tags.usage === 'main';
    const kind = main ? 'main' : 'branch';

    // OSM maxspeed is a string that may carry units or be non-numeric.
    const tagged = Number.parseInt(way.tags.maxspeed ?? '', 10);
    const speed = Number.isFinite(tagged) && tagged > 0 ? tagged : ASSUMED_SPEED[kind];

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: way.geometry.map((p) => [p.lon, p.lat]),
      },
      properties: {
        NTRACK: ASSUMED_TRACKS[kind],
        TRACKSPD: speed,
        SPEED_SOURCE: Number.isFinite(tagged) && tagged > 0 ? 'osm' : 'assumed',
        TRANSFER: TRACK_DEFAULTS.transfer,
        ROUGHNESS: TRACK_DEFAULTS.roughness,
        IMPACT: TRACK_DEFAULTS.impact,
        BRIDGE: TRACK_DEFAULTS.bridge,
        CURVATURE: TRACK_DEFAULTS.curvature,
        ISTUNNEL: 0,
      },
    });
  }

  await writeFile(outPath, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');

  const fromOsm = features.filter((f) => f.properties.SPEED_SOURCE === 'osm').length;
  return { path: outPath, sections: features.length, speedFromOsm: fromOsm };
}

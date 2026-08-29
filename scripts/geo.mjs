/**
 * Pure geometry for planning a city-sized prewarm: boundary rings, the area they
 * enclose, whether a point is inside them, and the lattice of discs laid over
 * them.
 *
 * Deliberately its own file rather than more of lib.mjs, which every other
 * script imports for Overpass. Importing lib.mjs installs a global undici
 * ProxyAgent — that is the whole reason Overpass is reachable on the machine
 * this was written on, and it is also why prewarm.mjs, which talks to an API on
 * localhost, must not import it: every request would be sent to the proxy, and
 * the local server would look dead. Nothing here touches the network, so
 * nothing here forces that choice on a caller.
 */
/**
 * Area of a closed WGS84 ring, in square metres, by spherical excess.
 *
 * Signed: the sign is the ring's orientation, which is what lets a caller
 * subtract inner rings without knowing which way round Overpass handed them
 * over. The sphere costs ~0.3% against the ellipsoid at the size of a city —
 * far below the uncertainty in anything this number is used to decide.
 */
export function ringArea(ring) {
  const R = 6371008.8;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    sum +=
      (((lon2 - lon1) * Math.PI) / 180) *
      (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
  }
  return (sum * R * R) / 2;
}

/**
 * Closed rings out of the member ways of an Overpass relation (`out geom`).
 *
 * A boundary relation is a bag of ways in no particular order and no particular
 * direction — an administrative border is normally split across dozens of them,
 * and neither the order nor the winding is promised. So ways are joined end to
 * end, reversed when that is what fits, and only a ring that actually closes is
 * kept: an unclosed remnant means the relation was cut by the query bbox, and
 * treating it as a polygon would silently produce an area that is nonsense.
 */
export function stitchRings(members) {
  const open = members
    .filter((m) => Array.isArray(m.geometry) && m.geometry.length > 1)
    .map((m) => m.geometry.map((p) => [p.lon, p.lat]));
  // Coordinates come back as decimals and are compared for identity, not
  // proximity: Overpass echoes the same node with the same digits in every way
  // that uses it, so rounding to 7 places is exact here rather than a tolerance.
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const closed = (r) => key(r[0]) === key(r[r.length - 1]);
  const rings = [];

  while (open.length > 0) {
    let ring = open.pop();
    for (let joined = true; joined && !closed(ring); ) {
      joined = false;
      for (let i = 0; i < open.length; i++) {
        const way = open[i];
        if (key(ring[ring.length - 1]) === key(way[0])) ring = ring.concat(way.slice(1));
        else if (key(ring[ring.length - 1]) === key(way[way.length - 1]))
          ring = ring.concat(way.slice(0, -1).reverse());
        else if (key(ring[0]) === key(way[way.length - 1])) ring = way.concat(ring.slice(1));
        else if (key(ring[0]) === key(way[0])) ring = way.slice().reverse().concat(ring.slice(1));
        else continue;
        open.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (closed(ring) && ring.length > 3) rings.push(ring);
  }
  return rings;
}

/**
 * Is the point inside this set of rings, counting outer and inner together?
 *
 * Even-odd ray casting, so holes need no marking: a point inside an outer ring
 * and inside an inner one crosses an even number of edges and comes out false,
 * which is the answer wanted. A point exactly on an edge may land either way —
 * for deciding whether a square kilometre of farmland is worth an hour of CPU
 * that is not a distinction worth code.
 */
export function pointInRings(rings, lon, lat) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
  }
  return inside;
}

/**
 * Centres of discs of `radius` that cover the box between them, with as few
 * discs as the shape allows.
 *
 * A triangular lattice: rows `1.5·radius` apart, `radius·√3` along a row, every
 * other row shifted half a step. Each disc then owns a regular hexagon of
 * circumradius `radius`, the hexagons tile the plane, and the discs cover it —
 * `2.598·radius²` of ground per disc against the `π·radius²` a disc spans, so
 * 83% of what is computed is not redundant. A square lattice would need a
 * `radius·√2` pitch and 30% more runs for the same coverage, and every run here
 * is minutes of every core.
 *
 * The longitude step is recomputed per row because a row is up to tens of
 * kilometres from the last one, and using one cosine for the whole box would
 * open gaps at the far edge — which is exactly the failure nobody notices,
 * because the map looks computed until somebody clicks in the seam.
 */
export function hexLattice({ south, west, north, east }, radius) {
  const dx = radius * Math.sqrt(3);
  const dy = 1.5 * radius;
  const centres = [];
  const rows = Math.ceil(((north - south) * 111320) / dy);
  for (let i = 0; i <= rows; i++) {
    const lat = south + (i * dy) / 111320;
    const metresPerDegree = 111320 * Math.cos((lat * Math.PI) / 180);
    const offset = i % 2 ? dx / 2 : 0;
    const cols = Math.ceil(((east - west) * metresPerDegree) / dx);
    for (let j = 0; j <= cols; j++) {
      centres.push({ lat, lon: west + (offset + j * dx) / metresPerDegree });
    }
  }
  return centres;
}

/**
 * The head of a ranked tile list that owns `share` of the buildings.
 *
 * A plan is written in descending order of `owned`, so the answer is a prefix —
 * and that is the property that makes a prewarm interruptible: what has been
 * computed when it stops is the most valuable part of the city rather than an
 * arbitrary corner of it.
 */
export function tilesForShare(tiles, share) {
  const total = tiles.reduce((sum, tile) => sum + tile.owned, 0);
  if (total === 0 || share >= 1) return tiles.slice();
  let owned = 0;
  let taken = 0;
  while (taken < tiles.length && owned / total < share) owned += tiles[taken++].owned;
  return tiles.slice(0, taken);
}

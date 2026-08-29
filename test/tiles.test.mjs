/**
 * The geometry behind a city-sized prewarming plan: boundary rings out of an
 * Overpass relation, the area they enclose, whether a point is inside them, and
 * the lattice of discs laid over them.
 *
 * All of it is cheap to get subtly wrong and expensive to notice. A lattice with
 * a seam in it looks finished and leaves a strip of the city computing on every
 * click; a relation stitched the wrong way round reports an area that is off by
 * a hole, and the plan then spends hours on farmland. None of that shows up
 * until the batch has already run, which is why it is checked here instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexLattice, pointInRings, ringArea, stitchRings, tilesForShare } from '../scripts/geo.mjs';

/** A closed rectangle, counter-clockwise, as Overpass would hand one over. */
function box(south, west, north, east) {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** Metres between two points, near enough at the scale of one city. */
function metres(a, b) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

test('ringArea matches the metric size of a small box', () => {
  // 0.01° each way at 45°N: 1113 m north to south, 787 m east to west.
  const area = Math.abs(ringArea(box(45, 39, 45.01, 39.01)));
  const expected = 0.01 * 111320 * (0.01 * 111320 * Math.cos((45.005 * Math.PI) / 180));
  assert.ok(
    Math.abs(area / expected - 1) < 0.01,
    `${area.toFixed(0)} against ${expected.toFixed(0)}`,
  );
});

test('ringArea is signed by orientation', () => {
  const ring = box(45, 39, 45.01, 39.01);
  const reversed = ring.slice().reverse();
  assert.ok(ringArea(ring) * ringArea(reversed) < 0, 'the two windings must differ in sign');
  assert.ok(Math.abs(ringArea(ring) + ringArea(reversed)) < 1, 'and agree in size');
});

test('stitchRings joins ways whatever their order and direction', () => {
  // One square, cut into three ways, shuffled, and two of them written backwards
  // — which is exactly what a boundary relation looks like.
  const members = [
    {
      geometry: [
        { lon: 1, lat: 1 },
        { lon: 0, lat: 1 },
      ],
    },
    {
      geometry: [
        { lon: 0, lat: 0 },
        { lon: 0, lat: 1 },
      ],
    },
    {
      geometry: [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 0 },
        { lon: 1, lat: 1 },
      ],
    },
  ];
  const rings = stitchRings(members);
  assert.equal(rings.length, 1);
  const [ring] = rings;
  assert.deepEqual(ring[0], ring[ring.length - 1], 'the ring must close');
  assert.equal(new Set(ring.map(String)).size, 4, 'four distinct corners');
});

test('stitchRings drops what does not close', () => {
  // A relation cut by the query bbox leaves an open chain. Treating it as a
  // polygon would produce an area, and the area would be nonsense.
  const rings = stitchRings([
    {
      geometry: [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 0 },
      ],
    },
    {
      geometry: [
        { lon: 1, lat: 0 },
        { lon: 1, lat: 1 },
      ],
    },
  ]);
  assert.deepEqual(rings, []);
});

test('pointInRings answers inside, outside and inside a hole', () => {
  const outer = box(45, 39, 46, 40);
  const hole = box(45.4, 39.4, 45.6, 39.6);
  assert.equal(pointInRings([outer], 39.5, 45.5), true);
  assert.equal(pointInRings([outer], 38.5, 45.5), false);
  // Even-odd, so an inner ring needs no marking as such.
  assert.equal(pointInRings([outer, hole], 39.5, 45.5), false, 'a hole is not inside');
  assert.equal(pointInRings([outer, hole], 39.1, 45.5), true, 'but the rest of it still is');
});

test('hexLattice spaces the discs at radius·√3', () => {
  const radius = 750;
  const centres = hexLattice({ south: 45, north: 45.05, west: 39, east: 39.05 }, radius);
  assert.ok(centres.length > 10, 'the box must hold a lattice worth measuring');
  const nearest = centres.map((c) => {
    let best = Infinity;
    for (const other of centres) {
      if (other === c) continue;
      best = Math.min(best, metres(c, other));
    }
    return best;
  });
  for (const distance of nearest) {
    assert.ok(
      Math.abs(distance / (radius * Math.sqrt(3)) - 1) < 0.01,
      `nearest neighbour ${distance.toFixed(0)} m, expected ${(radius * Math.sqrt(3)).toFixed(0)}`,
    );
  }
});

test('hexLattice leaves nothing in the box uncovered', () => {
  // The property the whole plan rests on. A covering this tight is exact: the
  // deepest point of the lattice — the circumcentre of three neighbouring
  // centres — sits at exactly one radius, so the check allows for the last
  // digits of floating point and nothing more.
  const radius = 750;
  const bounds = { south: 45, north: 45.04, west: 39, east: 39.04 };
  const centres = hexLattice(bounds, radius);
  let worst = 0;
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const point = {
        lat: bounds.south + ((bounds.north - bounds.south) * i) / 40,
        lon: bounds.west + ((bounds.east - bounds.west) * j) / 40,
      };
      worst = Math.max(worst, Math.min(...centres.map((c) => metres(point, c))));
    }
  }
  assert.ok(
    worst <= radius * 1.001,
    `worst uncovered point is ${worst.toFixed(1)} m from a centre`,
  );
});

test('tilesForShare takes a prefix of the ranking', () => {
  const tiles = [{ owned: 50 }, { owned: 30 }, { owned: 15 }, { owned: 5 }];
  assert.equal(tilesForShare(tiles, 0.5).length, 1, '50 of 100 is the first tile alone');
  assert.equal(tilesForShare(tiles, 0.8).length, 2);
  assert.equal(tilesForShare(tiles, 0.95).length, 3);
  assert.equal(tilesForShare(tiles, 1).length, 4, 'the whole lattice, empty tiles included');
  // Prefix, not a filter: the caller relies on being able to stop early and
  // still have the most valuable part computed.
  assert.deepEqual(tilesForShare(tiles, 0.8), tiles.slice(0, 2));
});

test('tilesForShare survives a plan nothing is ranked by', () => {
  const tiles = [{ owned: 0 }, { owned: 0 }];
  assert.equal(
    tilesForShare(tiles, 0.5).length,
    2,
    'no buildings anywhere means no ranking to cut',
  );
});

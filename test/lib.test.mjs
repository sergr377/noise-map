/**
 * The pure helpers behind every extract: the box the OSM data is fetched for,
 * the projection it lands in, and the band labels the checking scripts read
 * back out of a result. All cheap to get subtly wrong and expensive to notice —
 * a bad bounding box costs a whole run before the map comes out short.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandMid, bboxAround, bboxEwkt, overpassQuery, utmSrid } from '../scripts/lib.mjs';

test('bandMid takes the middle of a closed band', () => {
  assert.equal(bandMid('35-40'), 37.5);
  assert.equal(bandMid('75-80'), 77.5);
});

test('bandMid gives the open bands the same 5 dB width', () => {
  // Not a midpoint of anything: it is the convention that makes an
  // area-weighted mean comparable between two runs.
  assert.equal(bandMid('-35'), 32.5);
  assert.equal(bandMid('80+'), 82.5);
});

test('bboxAround reaches the asked-for distance north and south', () => {
  const radius = 750;
  const box = bboxAround(55.7649, 37.6055, radius);
  const metresPerDegLat = 111_320;
  const north = (box.north - 55.7649) * metresPerDegLat;
  const south = (55.7649 - box.south) * metresPerDegLat;
  assert.ok(Math.abs(north - radius) < 5, `north edge ${north} m from centre`);
  assert.ok(Math.abs(south - radius) < 5, `south edge ${south} m from centre`);
});

test('bboxAround widens the longitude span as the latitude rises', () => {
  // A degree of longitude shrinks towards the pole, so the same distance has
  // to span more of them. Getting this backwards silently truncates the
  // extract on one axis.
  const moscow = bboxAround(55.7649, 37.6055, 1000);
  const murmansk = bboxAround(68.9585, 33.0827, 1000);
  const span = (b) => b.east - b.west;
  assert.ok(span(murmansk) > span(moscow), 'the northern box must span more longitude');
});

test('bboxEwkt closes the ring and declares WGS84', () => {
  const ewkt = bboxEwkt({ south: 55.7, west: 37.6, north: 55.8, east: 37.7 });
  assert.match(ewkt, /^SRID=4326;POLYGON\(\(/);
  const ring = ewkt.slice(ewkt.indexOf('((') + 2, ewkt.indexOf('))')).split(', ');
  assert.equal(ring.length, 5, 'a closed rectangle is five points');
  assert.equal(ring[0], ring[4], 'the ring must close on its first point');
});

test('utmSrid picks the zone and the hemisphere', () => {
  assert.equal(utmSrid(55.7649, 37.6055), 32637, 'Moscow is UTM 37N');
  assert.equal(utmSrid(43.1155, 131.8855), 32652, 'Vladivostok is UTM 52N');
  assert.equal(utmSrid(-33.8688, 151.2093), 32756, 'Sydney is UTM 56S');
});

test('the Overpass query asks for meta output', () => {
  // The osmosis XML reader inside Import_OSM needs the version attribute that
  // only `out meta` carries; plain `out` produces a file it refuses.
  const query = overpassQuery({ south: 55.7, west: 37.6, north: 55.8, east: 37.7 });
  assert.match(query, /\bout meta;/);
});

test('the Overpass query covers roads, buildings and land cover', () => {
  const query = overpassQuery({ south: 55.7, west: 37.6, north: 55.8, east: 37.7 });
  for (const tag of ['highway', 'building', 'landuse', 'natural', 'leisure']) {
    assert.match(query, new RegExp(`\\["${tag}"\\]`), `missing ${tag}`);
  }
  // south,west,north,east — the order Overpass expects, and a swap here is
  // both silent and catastrophic.
  assert.ok(query.includes('(55.7,37.6,55.8,37.7)'), 'bbox order');
});

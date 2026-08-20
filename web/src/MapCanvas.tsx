import { useMemo } from 'react';
import type * as Ymaps from './ymaps';
import { bandFor } from './palette';
import type { Centre, IsophoneCollection } from './api';
import type { LngLat, Margin } from '@yandex/ymaps3-types';

interface Props {
  /** The bootstrapped map module. Mounted only once it has loaded, so that the
   *  hooks below are never called conditionally. */
  maps: typeof Ymaps;
  /**
   * Viewport. The map owns its camera between updates — this only moves it when
   * the value itself changes, i.e. on a deep link or an address search, never on
   * an ordinary map click.
   */
  location: { center: [number, number]; zoom: number };
  /**
   * Part of the map covered by the panel. Passed as an ordinary prop, not
   * through useDefault, so it follows the panel as its height changes.
   */
  margin: Margin;
  features: IsophoneCollection['features'];
  centre: Centre | null;
  /** Radius a calculation covers, metres. Null until the server has said. */
  radius: number | null;
  /** Where the cursor is, when it is over the map and nothing is running. */
  hover: Centre | null;
  /** Whether that place is already computed — a click there costs nothing. */
  hoverCached: boolean;
  /** Whether a calculation is in flight — that is what turns the ring solid. */
  running: boolean;
  onPick: (lat: number, lon: number) => void;
  onHover: (place: Centre | null) => void;
}

/**
 * Ring of a disc of the given radius, in the same flat approximation the server
 * uses for its own bounding boxes. The real disc is cut in a metric projection;
 * at these radii the two differ by centimetres, which is far below the width of
 * the line drawing it.
 */
function ring(lat: number, lon: number, radiusMetres: number, segments = 72): [number, number][] {
  const dLat = radiusMetres / 111320;
  const dLon = radiusMetres / (111320 * Math.cos((lat * Math.PI) / 180));
  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * 2 * Math.PI;
    points.push([lon + dLon * Math.cos(angle), lat + dLat * Math.sin(angle)]);
  }
  return points;
}

const ACCENT = '#cd463f';

export default function MapCanvas({
  maps,
  location: requested,
  margin,
  features,
  centre,
  radius,
  hover,
  hoverCached,
  running,
  onPick,
  onHover,
}: Props) {
  const {
    reactify,
    YMap,
    YMapDefaultFeaturesLayer,
    YMapDefaultSchemeLayer,
    YMapFeature,
    YMapListener,
    YMapMarker,
  } = maps;

  // Uncontrolled between updates: passing the value as its own dependency means
  // the camera moves when we deliberately change it, and re-renders otherwise
  // leave the user's panning and zooming alone.
  const location = reactify.useDefault(requested, [requested]);

  const handleClick = (_object: unknown, event: { coordinates: LngLat }) => {
    const [lon, lat] = event.coordinates;
    onPick(lat, lon);
  };

  const handleMove = (_object: unknown, event: { coordinates: LngLat }) => {
    const [lon, lat] = event.coordinates;
    onHover({ lat, lon });
  };

  // Isophones are the expensive part of this tree — tens of thousands of
  // coordinates. Holding the elements themselves means a re-render caused by
  // the cursor moving reuses them instead of walking the geometry again.
  const isophones = useMemo(
    () =>
      features.map((feature) => {
        const band = bandFor(feature.properties.ISOLVL);
        if (!band) return null;
        return (
          <YMapFeature
            key={`${feature.properties.PERIOD}-${feature.properties.ISOLVL}`}
            geometry={feature.geometry}
            style={{
              fill: band.color,
              fillOpacity: 0.55,
              // Dissolved bands carry their holes as interior rings.
              fillRule: 'evenodd',
              // The quiet bands are pale against the basemap; an outline keeps
              // their boundaries readable where the fill alone would wash out.
              stroke: [{ color: band.color, width: 1, opacity: 0.95 }],
              zIndex: band.level,
            }}
          />
        );
      }),
    [features, YMapFeature],
  );

  // What a click would cover, followed under the cursor. Dashed, because it is
  // a proposal rather than a result; it steps aside while something is running,
  // where the solid ring below says what is actually being computed.
  const preview = !running && hover && radius ? ring(hover.lat, hover.lon, radius) : null;
  const active = running && centre && radius ? ring(centre.lat, centre.lon, radius) : null;

  return (
    <YMap location={location} margin={margin}>
      <YMapDefaultSchemeLayer />
      <YMapDefaultFeaturesLayer />
      <YMapListener onClick={handleClick} onMouseMove={handleMove} onMouseLeave={() => onHover(null)} />

      {isophones}

      {preview && (
        <YMapFeature
          geometry={{ type: 'Polygon', coordinates: [preview] }}
          style={{
            // An already computed place is drawn filled: the click costs
            // nothing there, and that is worth seeing before clicking rather
            // than after waiting.
            fill: hoverCached ? ACCENT : 'rgba(0, 0, 0, 0)',
            fillOpacity: hoverCached ? 0.12 : 0,
            stroke: [{ color: ACCENT, width: 2, opacity: 0.75, dash: [8, 7] }],
            zIndex: 500,
          }}
        />
      )}

      {active && (
        <YMapFeature
          geometry={{ type: 'Polygon', coordinates: [active] }}
          style={{
            fill: 'rgba(0, 0, 0, 0)',
            stroke: [{ color: ACCENT, width: 2, opacity: 0.9 }],
            zIndex: 500,
          }}
        />
      )}

      {centre && (
        <YMapMarker coordinates={[centre.lon, centre.lat]}>
          <div className="centre-dot" title="Центр расчёта" />
        </YMapMarker>
      )}
    </YMap>
  );
}

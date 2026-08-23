import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import polygonClipping, { type Polygon as ClipPolygon } from 'polygon-clipping';
import type * as Ymaps from './ymaps';
import { bandFor } from './palette';
import type { Centre, ComputedArea, IsophoneCollection } from './api';
import type { LngLat, LngLatBounds, Margin } from '@yandex/ymaps3-types';

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
  /** Places already computed, shaded so they can be found by looking. */
  areas: ComputedArea[];
  /** Whether a calculation is in flight — that is what turns the ring solid. */
  running: boolean;
  onPick: (lat: number, lon: number) => void;
  onHover: (place: Centre | null) => void;
  /** Reports the camera once it has come to rest, so the shading can follow. */
  onViewport: (view: { bounds: LngLatBounds; zoom: number }) => void;
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
  areas,
  running,
  onPick,
  onHover,
  onViewport,
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

  // Only the camera at rest is reported. This event fires on every frame of a
  // drag, and passing those upward would re-render the tree sixty times a second
  // to answer a question whose answer only matters once the map stops.
  const handleUpdate = ({
    location: view,
    mapInAction,
  }: {
    location: { bounds: LngLatBounds; zoom: number };
    mapInAction: boolean;
  }) => {
    if (!mapInAction) onViewport({ bounds: view.bounds, zoom: view.zoom });
  };

  // The update event fires when the camera *changes*, so a map that opens and
  // is never touched would never report where it is looking. Asking it once, on
  // mount, is what makes the shaded areas appear before the first pan.
  const mapRef = useRef<ComponentRef<typeof YMap>>(null);
  // Asked once, on mount: with onViewport in the dependencies the retry loop
  // would restart whenever the callback changed and fight the camera event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately once
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    // The entity is attached a tick after mount, and its bounds stay empty until
    // the map has been sized, so this asks again shortly rather than once and
    // never. A timer, not requestAnimationFrame: in a background tab the frame
    // callback may never run, and the map would then open unshaded until the
    // first pan.
    const ask = () => {
      const map = mapRef.current;
      const bounds = map?.bounds;
      if (map && bounds && bounds[0][0] !== bounds[1][0]) {
        onViewport({ bounds, zoom: map.zoom });
        return;
      }
      if (tries < 40) {
        tries += 1;
        timer = setTimeout(ask, 50);
      }
    };
    ask();
    return () => clearTimeout(timer);
    // Deliberately once: every later camera position arrives through the event
    // above, and re-running this on each render would fight it.
  }, []);

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

  // Everything already computed, merged into one shape before it is drawn.
  //
  // Handing the discs over as a MultiPolygon is not enough: the renderer fills
  // each polygon separately, so overlaps stack their transparency into a darker
  // blob and every disc keeps its own outline — a cluster of computed places then
  // reads as a pile of circles rather than as one region. Union first, and the
  // seams simply do not exist; holes between discs survive as interior rings,
  // which is why the fill rule is evenodd.
  //
  // The merge is geometric rather than a styling trick because the styling trick
  // does not exist here: the drawing style has no blend mode and no layer-wide
  // opacity, so the only way to hide the seams through style is an opaque fill —
  // which would bury the streets the shading is meant to sit over.
  const computed = useMemo(() => {
    if (areas.length === 0) return null;
    const discs: ClipPolygon[] = areas.map((area) => [ring(area.lat, area.lon, area.radius, 64)]);
    // union() wants the first shape and the rest as separate arguments.
    const [first, ...rest] = discs;
    if (!first) return null;
    const merged = polygonClipping.union(first, ...rest);
    return (
      <YMapFeature
        geometry={{ type: 'MultiPolygon', coordinates: merged as LngLat[][][] }}
        style={{
          fill: ACCENT,
          fillOpacity: 0.1,
          fillRule: 'evenodd',
          stroke: [{ color: ACCENT, width: 1, opacity: 0.35 }],
          zIndex: 0,
        }}
      />
    );
  }, [areas, YMapFeature]);

  // What a click would cover, followed under the cursor. Dashed, because it is
  // a proposal rather than a result; it steps aside while something is running,
  // where the solid ring below says what is actually being computed.
  const preview = !running && hover && radius ? ring(hover.lat, hover.lon, radius) : null;
  const active = running && centre && radius ? ring(centre.lat, centre.lon, radius) : null;

  return (
    <YMap location={location} margin={margin} ref={mapRef}>
      <YMapDefaultSchemeLayer />
      <YMapDefaultFeaturesLayer />
      <YMapListener
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={() => onHover(null)}
        onUpdate={handleUpdate}
      />

      {computed}

      {isophones}

      {preview && (
        <YMapFeature
          geometry={{ type: 'Polygon', coordinates: [preview] }}
          style={{
            // Empty on purpose: what is already computed is shaded across the
            // whole map above, so this ring says only what a click would cover.
            fill: 'rgba(0, 0, 0, 0)',
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

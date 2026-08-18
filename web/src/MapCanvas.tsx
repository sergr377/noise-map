import type * as Ymaps from './ymaps';
import { bandFor } from './palette';
import type { Centre, IsophoneCollection } from './api';
import type { LngLat } from '@yandex/ymaps3-types';

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
  features: IsophoneCollection['features'];
  centre: Centre | null;
  onPick: (lat: number, lon: number) => void;
}

export default function MapCanvas({ maps, location: requested, features, centre, onPick }: Props) {
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

  return (
    <YMap location={location}>
      <YMapDefaultSchemeLayer />
      <YMapDefaultFeaturesLayer />
      <YMapListener onClick={handleClick} />

      {features.map((feature) => {
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
      })}

      {centre && (
        <YMapMarker coordinates={[centre.lon, centre.lat]}>
          <div className="centre-dot" title="Центр расчёта" />
        </YMapMarker>
      )}
    </YMap>
  );
}

import type * as Ymaps from './ymaps';
import { bandFor } from './palette';
import type { Centre, IsophoneCollection } from './api';
import type { LngLat } from '@yandex/ymaps3-types';

const START_LOCATION = { center: [37.6173, 55.7558] as [number, number], zoom: 15 };

interface Props {
  /** The bootstrapped map module. Mounted only once it has loaded, so that the
   *  hooks below are never called conditionally. */
  maps: typeof Ymaps;
  features: IsophoneCollection['features'];
  centre: Centre | null;
  onPick: (lat: number, lon: number) => void;
}

export default function MapCanvas({ maps, features, centre, onPick }: Props) {
  const {
    reactify,
    YMap,
    YMapDefaultFeaturesLayer,
    YMapDefaultSchemeLayer,
    YMapFeature,
    YMapListener,
    YMapMarker,
  } = maps;

  // Uncontrolled: the map owns its viewport afterwards, so panning and zooming
  // are not fought by re-renders.
  const location = reactify.useDefault(START_LOCATION);

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

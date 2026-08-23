import type { FormEvent } from 'react';
import type { Place } from './api';

interface Props {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  searching: boolean;
  error: string | null;
  places: Place[] | null;
  onSelect: (place: Place) => void;
}

/** The address box and whatever the geocoder had to say about it. */
export default function SearchPanel({
  query,
  onQueryChange,
  onSubmit,
  searching,
  error,
  places,
  onSelect,
}: Props) {
  return (
    <>
      <form className="search" onSubmit={onSubmit}>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Москва, Тверская улица, 12"
          aria-label="Адрес"
        />
        <button type="submit" disabled={searching || query.trim().length < 3}>
          {searching ? '…' : 'Найти'}
        </button>
      </form>

      {error && <p className="error">Поиск не сработал: {error}</p>}

      {places?.length === 0 && <p className="note">Ничего не нашлось. Уточните адрес.</p>}

      {places && places.length > 0 && (
        <ul className="results">
          {places.map((place) => (
            <li key={`${place.lat},${place.lon}`}>
              {/* The visible text lives in two spans, which leaves the button
                  itself without an accessible name — screen readers would
                  announce a row of anonymous buttons. */}
              <button
                type="button"
                aria-label={place.description ? `${place.name}, ${place.description}` : place.name}
                onClick={() => onSelect(place)}
              >
                <span className="result-name">{place.name}</span>
                <span className="result-description">{place.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

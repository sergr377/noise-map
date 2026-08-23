import { useCallback, useState, type FormEvent } from 'react';
import { geocode, type Place } from './api';

/**
 * The address box: query, results, and the two ways they go away.
 *
 * Knows nothing about the map or the calculation. `accept` is what a picked
 * result does to the box — the address stays as the label of what is shown —
 * and `clear` is what a map click does to it, because the address no longer
 * describes what is on screen.
 */
export function useAddressSearch() {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmed = query.trim();
      if (trimmed.length < 3) return;
      setSearching(true);
      setError(null);
      setPlaces(null);
      try {
        setPlaces(await geocode(trimmed));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSearching(false);
      }
    },
    [query],
  );

  /** A result was chosen: its name labels the box, the list is done. */
  const accept = useCallback((place: Place) => {
    setPlaces(null);
    setQuery(place.name);
  }, []);

  const clear = useCallback(() => {
    setQuery('');
    setPlaces(null);
    setError(null);
  }, []);

  return { query, setQuery, places, searching, error, submit, accept, clear };
}

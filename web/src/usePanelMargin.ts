import { useEffect, useState, type RefObject } from 'react';
import type { Margin } from '@yandex/ymaps3-types';

/**
 * Insets that tell the map which part of it the panel covers.
 *
 * Without this the map centres the requested point in the middle of its own
 * element — which on a narrow screen is exactly the strip the panel sits on top
 * of, so the answer to the user's question ends up hidden behind the interface
 * that asked it.
 *
 * The panel is measured rather than assumed: its height depends on content and
 * its position flips between a bottom sheet and a side column at the CSS
 * breakpoint, and duplicating that rule in JavaScript would mean two places to
 * keep in sync.
 */
export function usePanelMargin(panelRef: RefObject<HTMLElement | null>): Margin {
  const [margin, setMargin] = useState<Margin>([0, 0, 0, 0]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const measure = () => {
      const rect = panel.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        setMargin([0, 0, 0, 0]);
        return;
      }

      // A bottom sheet spans the full width; a side column does not.
      const isBottomSheet = rect.width >= window.innerWidth - 1;
      const next: Margin = isBottomSheet
        ? [0, 0, Math.max(0, Math.round(window.innerHeight - rect.top)), 0]
        : [0, 0, 0, Math.max(0, Math.round(rect.right))];

      setMargin((prev) => (prev.every((value, index) => value === next[index]) ? prev : next));
    };

    measure();

    // The panel changes height as content appears: progress bar, results list,
    // status line. ResizeObserver catches those; resize catches the breakpoint.
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    window.addEventListener('resize', measure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [panelRef]);

  return margin;
}

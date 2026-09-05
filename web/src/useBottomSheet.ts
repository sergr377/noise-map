import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/**
 * The panel as a bottom sheet with three resting heights.
 *
 * On a phone the panel used to hold 55% of the screen at all times, including
 * before anything had been computed — the map, which is the answer, got less
 * room than the form asking the question. The sheet keeps the controls reachable
 * and gives the rest of the screen back: collapsed it is the search box and the
 * period row, and everything else is one drag away.
 *
 * Sheetness is *measured*, not read off a breakpoint: the hook asks whether the
 * panel currently spans the full width, exactly as `usePanelMargin` does. The
 * layout rule stays in the stylesheet alone, which is what keeps the two from
 * drifting apart.
 */
export type SheetSnap = 'collapsed' | 'half' | 'full';

/** How much of the screen the fully open sheet leaves to the map. */
const FULL_SHARE = 0.92;
const HALF_SHARE = 0.5;

/** A press that travels less than this is a tap on the handle, not a drag. */
const DRAG_SLOP = 4;

interface Heights {
  collapsed: number;
  half: number;
  full: number;
}

interface Options {
  /**
   * Raise the sheet to half height while this holds — a calculation the user
   * should be able to watch. It returns to where it was on its own, unless the
   * sheet was moved by hand in the meantime.
   */
  raised: boolean;
}

export interface Sheet {
  /** Which rest position the sheet is in; `null` while it is not a sheet. */
  snap: SheetSnap | null;
  /** Live height during a drag, and the resting height otherwise. */
  height: number | null;
  handleProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onClick: () => void;
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const nearest = (height: number, heights: Heights): SheetSnap => {
  const entries: Array<[SheetSnap, number]> = [
    ['collapsed', heights.collapsed],
    ['half', heights.half],
    ['full', heights.full],
  ];
  return entries.reduce((best, entry) =>
    Math.abs(entry[1] - height) < Math.abs(best[1] - height) ? entry : best,
  )[0];
};

export function useBottomSheet(
  panelRef: RefObject<HTMLElement | null>,
  peekRef: RefObject<HTMLElement | null>,
  handleRef: RefObject<HTMLElement | null>,
  { raised }: Options,
): Sheet {
  const [snap, setSnap] = useState<SheetSnap>('collapsed');
  const [heights, setHeights] = useState<Heights | null>(null);
  const [dragging, setDragging] = useState(false);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    const peek = peekRef.current;
    const handle = handleRef.current;
    const host = panel?.parentElement;
    if (!panel || !peek || !handle || !host) return;

    // The same question `usePanelMargin` asks, and for the same reason: a bottom
    // sheet spans the full width, a side column does not.
    if (panel.getBoundingClientRect().width < window.innerWidth - 1) {
      setHeights(null);
      return;
    }

    // The bottom padding is read off the element rather than repeated here: it
    // belongs to the stylesheet, and a second copy would go stale on the first
    // edit that changes it.
    const pad = Number.parseFloat(getComputedStyle(panel).paddingBottom) || 0;
    const full = Math.round(host.clientHeight * FULL_SHARE);
    const collapsed = Math.min(handle.offsetHeight + peek.offsetHeight + pad, full);
    const half = Math.round(Math.max(collapsed, host.clientHeight * HALF_SHARE));

    setHeights((prev) =>
      prev && prev.collapsed === collapsed && prev.half === half && prev.full === full
        ? prev
        : { collapsed, half, full },
    );
  }, [panelRef, peekRef, handleRef]);

  // Before paint: the sheet has no height until it is measured, and a frame of
  // a full-height panel dropping to its collapsed size is exactly the flash the
  // whole change is about.
  useLayoutEffect(() => {
    measure();
    const peek = peekRef.current;
    if (!peek) return;

    // The collapsed height follows the peek: the address results appear inside
    // it, and a sheet that kept its old height would cut them off.
    const observer = new ResizeObserver(measure);
    observer.observe(peek);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, peekRef]);

  const restore = useRef<SheetSnap | null>(null);
  useEffect(() => {
    if (raised) {
      setSnap((prev) => {
        if (prev !== 'collapsed') return prev;
        restore.current = 'collapsed';
        return 'half';
      });
      return;
    }
    const to = restore.current;
    if (!to) return;
    restore.current = null;
    // Only if the sheet is still where it was put. Anything else means the user
    // moved it while the calculation ran, and their choice outranks ours.
    setSnap((prev) => (prev === 'half' ? to : prev));
  }, [raised]);

  const drag = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(null);
  /**
   * The height under the finger. Written straight to the element rather than
   * held in state: a drag emits a move per frame, and re-rendering the whole
   * page sixty times a second to change one number is the kind of thing that
   * makes a sheet feel sticky on the phones that need it most. `dragging` is
   * state so that a render arriving mid-drag — the progress clock ticks every
   * second — writes the height under the finger rather than the resting one.
   */
  const dragHeight = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (!heights || !panel) return;
      // Cleared at the start of every gesture rather than only when it is used:
      // the click that consumes it comes from the browser, and a gesture that
      // ends without one — a cancelled pointer, a drag released off the handle —
      // would otherwise leave the flag set and swallow the next tap.
      suppressClick.current = false;
      // Capture keeps the moves coming once the finger leaves the handle, which
      // it does immediately — the handle is 30 px tall and the drag is 400. It
      // is an improvement rather than a requirement, and it throws when the
      // pointer is already gone, so a failure here must not lose the drag.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      drag.current = {
        startY: event.clientY,
        startHeight: panel.getBoundingClientRect().height,
        moved: false,
      };
    },
    [heights, panelRef],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = drag.current;
      const panel = panelRef.current;
      if (!state || !heights || !panel) return;
      const delta = state.startY - event.clientY;
      if (!state.moved) {
        if (Math.abs(delta) <= DRAG_SLOP) return;
        state.moved = true;
        // Both flipped here, in the same handler as the first write: a
        // transition still armed for one frame would animate the sheet away
        // from the finger that is holding it.
        panel.dataset.dragging = '';
        setDragging(true);
      }
      const height = clamp(state.startHeight + delta, heights.collapsed, heights.full);
      dragHeight.current = height;
      panel.style.height = `${height}px`;
    },
    [heights, panelRef],
  );

  const finishDrag = useCallback(() => {
    const state = drag.current;
    drag.current = null;
    const height = dragHeight.current;
    dragHeight.current = null;
    panelRef.current?.removeAttribute('data-dragging');
    setDragging(false);
    if (!state?.moved || !heights) return;
    // A drag that moved has already said what it wanted; the click that follows
    // a pointerup on a button would otherwise toggle the sheet a second time.
    suppressClick.current = true;
    setSnap(nearest(height ?? state.startHeight, heights));
  }, [heights, panelRef]);

  const onClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setSnap((prev) => (prev === 'collapsed' ? 'half' : 'collapsed'));
  }, []);

  return {
    snap: heights ? snap : null,
    height: heights ? ((dragging ? dragHeight.current : null) ?? heights[snap]) : null,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag,
      onClick,
    },
  };
}

import { useEffect, useRef, useState } from 'react';

/**
 * Turning a calculation that reports itself eight times an hour into something
 * that looks alive on screen. Both hooks here exist for the same reason and
 * neither invents progress: they fill silence, and a real report always wins.
 */

/** How far the bar may drift past the last confirmed value, and how fast. */
const DRIFT_LIMIT = 0.05;
const DRIFT_PER_SECOND = 0.004;

/**
 * How long the calculation has been running, in seconds.
 *
 * Counted locally because the server's own figure only arrives with an event,
 * and those are tens of seconds apart — a readout frozen between them looks
 * like a hang. But the local clock alone measures *our* wait, not the job's
 * age: joining a calculation someone else started, or simply reloading the
 * page, would restart it from zero and under-report by minutes. So every
 * reported figure re-anchors the count, and the ticking fills the silences —
 * including the long silence of a job sitting in the queue, where the server
 * has nothing new to say.
 */
export function useElapsedSeconds(running: boolean, reported?: number): number {
  const [seconds, setSeconds] = useState(0);
  // Where the count is measured from, in local time. A reported elapsed of 90 s
  // means the job began 90 s before that report reached us.
  const originRef = useRef(Date.now());

  useEffect(() => {
    if (!running) originRef.current = Date.now();
  }, [running]);

  useEffect(() => {
    if (reported !== undefined) originRef.current = Date.now() - reported;
  }, [reported]);

  // reported в зависимостях не читается телом эффекта, но нужен: приход нового
  // отчёта обязан пересчитать счётчик от нового начала отсчёта немедленно, а не
  // через секунду, когда сработает очередной тик.
  // biome-ignore lint/correctness/useExhaustiveDependencies: перезапуск здесь и есть смысл зависимости
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - originRef.current) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, reported]);

  return seconds;
}

/**
 * The pipeline reports progress only about eight times across the ~80 s
 * propagation step, so the raw value arrives in large jumps with long silences
 * between them. Easing alone made the bar sprint and then freeze, which reads as
 * a hang.
 *
 * So the bar eases towards the reported value and then keeps creeping very
 * slowly, capped a few percent past it. The motion says "still working" without
 * claiming progress that has not been reported: the drift can never reach the
 * next milestone on its own, and a real report always overtakes it.
 */
export function useSmoothProgress(target: number, active: boolean): number {
  const [shown, setShown] = useState(0);
  const ceilingRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setShown(0);
      ceilingRef.current = 0;
      return;
    }

    const tick = 80;
    const timer = setInterval(() => {
      // The ceiling walks forward with time but never more than DRIFT_LIMIT
      // beyond what the server actually confirmed.
      ceilingRef.current = Math.min(
        target + DRIFT_LIMIT,
        Math.max(target, ceilingRef.current + (DRIFT_PER_SECOND * tick) / 1000),
      );
      setShown((prev) => {
        const goal = ceilingRef.current;
        return Math.abs(goal - prev) < 0.001 ? goal : prev + (goal - prev) * 0.12;
      });
    }, tick);
    return () => clearInterval(timer);
  }, [target, active]);

  return active ? shown : target;
}

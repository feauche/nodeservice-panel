import { useEffect, useRef, useState } from 'react';

function secondsLeft(until: number | null): number {
  return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
}

/**
 * Обратный отсчёт до момента `until` (ms, Date.now()); возвращает оставшиеся секунды,
 * по нулю один раз зовёт onDone. null — отсчёта нет.
 */
export function useCountdown(until: number | null, onDone: () => void): number {
  const [left, setLeft] = useState(() => secondsLeft(until));
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    setLeft(secondsLeft(until));
    if (!until) return;
    const t = setInterval(() => {
      const v = secondsLeft(until);
      setLeft(v);
      if (v <= 0) {
        clearInterval(t);
        doneRef.current();
      }
    }, 250);
    return () => clearInterval(t);
  }, [until]);
  return left;
}

/**
 * Состояние «пауза после серии неудач»: setWait(seconds) запускает отсчёт,
 * по окончании зовётся onDone (обычно — вернуть фокус в поле).
 */
export function useThrottle(onDone: () => void) {
  const [until, setUntil] = useState<number | null>(null);
  const left = useCountdown(until, () => {
    setUntil(null);
    onDone();
  });
  return {
    active: until !== null && left > 0,
    left,
    start: (seconds: number | undefined) => setUntil(Date.now() + (seconds ?? 30) * 1000),
  };
}

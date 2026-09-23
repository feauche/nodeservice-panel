import { useEffect, useState } from 'react';

/**
 * «Сейчас», которое тикает раз в секунду, пока `active`. Для живых счётчиков секунд у идущих
 * шагов: иначе цифра меняется только при перечитывании данных и выглядит застывшей.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

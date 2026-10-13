/**
 * Показание счётчиков ноды: сетевая карта с загрузки сервера (байт) по часам ноды и счётчик трафика пользователей
 * Remnawave (`trafficUsedBytes`, байт). Remnawave обновляет счётчики ноды раз в 10 секунд, поэтому время между
 * показаниями — по часам ноды (её uptime), а не по часам панели: иначе ошибка за минуту доходит до 15 %.
 */
export type CounterReading = {
  rxTotal: number;
  txTotal: number;
  uptime: number;
  iface: string | null;
  used: number | null;
};
export type CounterStep = {
  /** Байт за промежуток и его длина по часам ноды, секунд; null — промежутка нет (первое показание, сброс). */
  net: { rxBytes: number; txBytes: number; dt: number } | null;
  /** Трафик пользователей за промежуток, байт; null — нечего сравнить. */
  usedBytes: number | null;
  /** Принять показание за новую точку отсчёта: нет — Remnawave ещё не обновила счётчики, ждём следующего. */
  advance: boolean;
};
/** Выше этого — не скорость, а сбой счётчика: 100 Гбит/с. */
const MAX_RATE = 12.5e9;

/** Трафик пользователей: счётчик Remnawave только растёт; уменьшился — его обнулили, считаем с нуля. */
function usedDelta(prev: number | null, cur: number | null): number | null {
  if (prev == null || cur == null) return null;
  return cur >= prev ? cur - prev : cur;
}

/**
 * Разница двух показаний ноды. Сервер перезагрузился или счётчик сбросился — считаем только то, что набежало после
 * загрузки, если загрузка попала в этот промежуток (`wallSeconds` — сколько прошло по часам панели); иначе
 * промежуток неизвестен. Сменилась сетевая карта — начинаем отсчёт заново. Часы ноды не сдвинулись — Remnawave
 * ещё не обновила показание: прежнюю точку отсчёта сохраняем, байты попадут в следующий промежуток.
 */
export function counterDelta(
  prev: CounterReading | null,
  cur: CounterReading | null,
  wallSeconds: number,
): CounterStep {
  if (!cur) return { net: null, usedBytes: null, advance: false };
  if (!prev) return { net: null, usedBytes: null, advance: true };
  const used = usedDelta(prev.used, cur.used);
  if (prev.iface && cur.iface && prev.iface !== cur.iface)
    return { net: null, usedBytes: used, advance: true };
  const reset = cur.uptime < prev.uptime || cur.rxTotal < prev.rxTotal || cur.txTotal < prev.txTotal;
  if (reset) {
    const bootedInside = cur.uptime > 0 && cur.uptime <= wallSeconds + 30;
    return {
      net:
        bootedInside && cur.rxTotal / cur.uptime < MAX_RATE && cur.txTotal / cur.uptime < MAX_RATE
          ? { rxBytes: cur.rxTotal, txBytes: cur.txTotal, dt: cur.uptime }
          : null,
      usedBytes: used,
      advance: true,
    };
  }
  const dt = cur.uptime - prev.uptime;
  if (dt <= 0) return { net: null, usedBytes: null, advance: false };
  const rxBytes = cur.rxTotal - prev.rxTotal,
    txBytes = cur.txTotal - prev.txTotal;
  if (rxBytes / dt > MAX_RATE || txBytes / dt > MAX_RATE)
    return { net: null, usedBytes: used, advance: true };
  return { net: { rxBytes, txBytes, dt }, usedBytes: used, advance: true };
}

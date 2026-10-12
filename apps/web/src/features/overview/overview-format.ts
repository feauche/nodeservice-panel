import type { Incident, RemnawaveNode } from '@nodeservice/shared';

/** Число по-русски: пробел между разрядами, запятая в дробной части. */
export const fmt = (v: number | null | undefined, digits = 0) =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });

/**
 * Скорость двух направлений одной единицей: Гбит/с, если хоть одно направление больше гигабита, иначе Мбит/с.
 * Remnawave отдаёт байты в секунду.
 */
export function rates(rx: number | null, tx: number | null) {
  const bits = (v: number | null) => (v == null ? null : v * 8);
  const top = Math.max(bits(rx) ?? 0, bits(tx) ?? 0);
  const giga = top >= 1e9;
  const div = giga ? 1e9 : 1e6;
  const show = (v: number | null) => {
    const b = bits(v);
    if (b == null) return '—';
    const x = b / div;
    // Гигабиты — всегда два знака: «2,90 · 2,96» ровнее, чем «2,9 · 2,96».
    const digits = giga ? 2 : x >= 10 ? 0 : 1;
    return x.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  return { rx: show(rx), tx: show(tx), unit: giga ? 'Гбит/с' : 'Мбит/с' };
}

/** Байты в секунду → Мбит/с для графиков. */
export const mbit = (v: number | null) => (v == null ? null : (v * 8) / 1e6);

/** Заголовок события без имени ноды в конце: имя и так стоит строкой выше. */
export function eventTitle(title: string, node: string) {
  return title.endsWith(` · ${node}`) ? title.slice(0, -` · ${node}`.length) : title;
}

export type NodeHealth = 'ok' | 'warn' | 'crit' | 'off';

/**
 * Состояние ноды для полосы здоровья и «Требует внимания»: сбой — нет связи или открытое критичное событие,
 * внимание — открытое предупреждение, выключенная в Remnawave нода — отдельно, в здоровье парка не входит.
 */
export function nodeHealth(node: RemnawaveNode, open: Incident[]): NodeHealth {
  if (node.isDisabled) return 'off';
  const mine = open.filter((i) => i.nodeUuid === node.uuid);
  if (!node.isConnected || mine.some((i) => i.severity === 'crit')) return 'crit';
  return mine.length > 0 ? 'warn' : 'ok';
}

/** Склонение: 1 нода, 2 ноды, 5 нод. */
export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Время без секунд: сегодня — «20:17», раньше — «11.10, 20:17». */
export function shortWhen(iso: string, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${time}`;
}

/**
 * Итог проверки SNI из ответа BS Checker. В описании сервиса про элемент `sni` сказано только «по элементу на каждое
 * имя из sni_hosts»: ключи не перечислены. Поэтому читаем осторожно — логическое поле успеха под любым из привычных
 * имён или слово-итог; если ничего не узнали, итог «не ясен» (null), а не выдуманный «прошёл» или «не прошёл».
 */

const BOOL_KEYS = ['ok', 'success', 'passed', 'accessible', 'reachable', 'handshake_ok', 'tls_ok'] as const;
const WORD_KEYS = ['verdict', 'status', 'result'] as const;
const GOOD = new Set(['ok', 'pass', 'passed', 'success', 'reachable', 'accessible', 'open']);
const BAD = new Set(['fail', 'failed', 'blocked', 'reset', 'timeout', 'error', 'unreachable', 'closed']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Один элемент: true / false, если понятно, иначе null. */
function one(item: unknown): boolean | null {
  if (!isObject(item)) return null;
  for (const key of BOOL_KEYS) if (typeof item[key] === 'boolean') return item[key] as boolean;
  for (const key of WORD_KEYS) {
    const word = item[key];
    if (typeof word !== 'string') continue;
    const w = word.trim().toLowerCase();
    if (GOOD.has(w)) return true;
    if (BAD.has(w)) return false;
  }
  return null;
}

/** Итог по точке: true — все имена прошли; false — хотя бы одно нет; null — нет данных или форма незнакома. */
export function sniOutcome(value: unknown): boolean | null {
  const items = Array.isArray(value) ? value : isObject(value) ? [value] : [];
  if (!items.length) return null;
  const known = items.map(one).filter((v): v is boolean => v !== null);
  if (!known.length) return null;
  if (known.includes(false)) return false;
  return known.length === items.length ? true : null;
}

/** Имена полей элемента (без значений): для журнала сервера, когда форма не узнана. */
export function sniShape(value: unknown): string[] {
  const first = Array.isArray(value) ? value[0] : value;
  return isObject(first) ? Object.keys(first).slice(0, 20) : [];
}

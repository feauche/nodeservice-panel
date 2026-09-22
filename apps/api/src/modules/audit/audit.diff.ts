import type { AuditChanges } from '@nodeservice/shared';

/**
 * Diff плоских объектов настроек для поля `changes`: только изменённые ключи.
 * Секретные поля передавать нельзя — для них в metadata кладётся факт (`passwordChanged: true`).
 * Возвращает null, если ничего не изменилось.
 */
export function diffChanges<T extends Record<string, unknown>>(before: T, after: T): AuditChanges | null {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: AuditChanges = {};
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out[key] = { before: b, after: a };
  }
  return Object.keys(out).length ? out : null;
}

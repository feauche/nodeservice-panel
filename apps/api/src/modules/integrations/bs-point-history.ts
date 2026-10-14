import type { AuditEntry, BsPointHistoryItem } from '@nodeservice/shared';

/**
 * История точки BS Checker из «Журнала» панели: у сервиса для точек WebSocket журнала нет, поэтому здесь —
 * только то, что сделано через панель: смена серверов, итог проверки точкой, просмотр настроек подключения.
 */

type Row = { host: string; port: number; weight?: number | null; backup?: boolean; enabled?: boolean };
const key = (r: Row) => `${r.host}:${r.port}`;
const label = (r: Row) => `${key(r)}${r.backup ? ' (запасной)' : ''}`;

/** Что изменилось в списке серверов или выходов: добавлено, убрано, поменяли вес, роль или включённость. */
export function exitsDiff(before: Row[], after: Row[]) {
  const old = new Map(before.map((r) => [key(r), r]));
  const next = new Map(after.map((r) => [key(r), r]));
  const added = after.filter((r) => !old.has(key(r))).map(label);
  const removed = before.filter((r) => !next.has(key(r))).map(label);
  const changed = after.flatMap((r) => {
    const o = old.get(key(r));
    if (!o) return [];
    const parts: string[] = [];
    if ((o.weight ?? 1) !== (r.weight ?? 1)) parts.push(`вес ${o.weight ?? 1} → ${r.weight ?? 1}`);
    if (Boolean(o.backup) !== Boolean(r.backup)) parts.push(r.backup ? 'стал запасным' : 'стал основным');
    if ((o.enabled ?? true) !== (r.enabled ?? true)) parts.push(r.enabled ? 'включён' : 'выключен');
    return parts.length ? [`${key(r)}: ${parts.join(', ')}`] : [];
  });
  return { added, removed, changed };
}

/** Одна строка о том, что поменяли: «добавлен …; убран …; …». */
export function diffText(d: { added: string[]; removed: string[]; changed: string[] }): string | null {
  const parts = [
    ...(d.added.length ? [`добавлен ${d.added.join(', ')}`] : []),
    ...(d.removed.length ? [`убран ${d.removed.join(', ')}`] : []),
    ...d.changed,
  ];
  return parts.length ? parts.join('; ') : null;
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Запись Журнала → строка истории точки; null — запись к истории не относится. */
export function historyItem(e: AuditEntry): BsPointHistoryItem | null {
  const m = e.metadata;
  const by = e.actorType === 'admin' ? 'вы' : 'панель';
  const base = { at: e.occurredAt, by };
  switch (e.action) {
    case 'integration.bs.ws_exits_changed':
    case 'integration.bs.targets_changed': {
      const what = e.action === 'integration.bs.ws_exits_changed' ? 'Серверы' : 'Выходные адреса';
      if (e.result !== 'ok')
        return { ...base, tone: 'crit', title: `${what} не изменены`, detail: 'Сервис отклонил изменение' };
      const detail = diffText({ added: list(m.added), removed: list(m.removed), changed: list(m.changed) });
      return { ...base, tone: 'acc', title: `${what} изменены`, detail };
    }
    case 'integration.bs.ws_exits_verified': {
      const failing = list(m.failing);
      const total = num(m.total);
      return failing.length
        ? {
            ...base,
            tone: 'crit',
            title: failing.length === 1 ? 'Сервер не отвечает точке' : 'Серверы не отвечают точке',
            detail: failing.join(', '),
          }
        : {
            ...base,
            tone: 'ok',
            title: 'Точка проверила серверы',
            detail: total ? `все ${total} работают` : null,
          };
    }
    case 'integration.bs.ws_connect_viewed':
      return { ...base, tone: 'muted', title: 'Открыты настройки подключения', detail: null };
    default:
      return null;
  }
}

/** Действия Журнала, из которых собирается история точки. */
export const POINT_HISTORY_ACTIONS = [
  'integration.bs.ws_exits_changed',
  'integration.bs.ws_exits_verified',
  'integration.bs.ws_connect_viewed',
  'integration.bs.targets_changed',
];

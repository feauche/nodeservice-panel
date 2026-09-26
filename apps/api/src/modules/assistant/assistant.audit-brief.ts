import { AUDIT_ACTIONS, type AuditEntry } from '@nodeservice/shared';

import { maskSecrets } from './terminal-hint.logic.js';

/** Из деталей записи берём только понятные человеку поля; остальное (технические id и вложенное) не нужно. */
const DETAIL_KEYS = [
  'question',
  'answer',
  'reason',
  'title',
  'kind',
  'server',
  'action',
  'by',
  'model',
  'error',
  'message',
  'glossaryImport',
] as const;
const DETAIL_CLIP = 240;
const CHANGE_CLIP = 60;
const CHANGES_MAX = 6;
const SECRET_FIELD = /pass|secret|token|key|hash|cookie|code/i;

const clip = (v: unknown, n: number): string => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export interface AuditBrief {
  at: string;
  /** Подпись действия, как в Журнале. */
  what: string;
  action: string;
  who: string;
  result: AuditEntry['result'];
  severity: AuditEntry['severity'];
  /** Сделала панель сама или администратор. */
  source: AuditEntry['source'];
  target: string | null;
  /** Короткая выдержка из деталей: вопрос и ответ Джарвису, причина, ошибка. Без секретов. */
  details?: string;
  /** Что изменено: поле и значения до и после (без полей, похожих на секреты). */
  changes?: string[];
}

/** Запись Журнала в форме для Джарвиса: кто, что, чем кончилось и выдержка из деталей. */
export function auditBrief(e: AuditEntry): AuditBrief {
  const parts: string[] = [];
  for (const k of DETAIL_KEYS) {
    const v = e.metadata[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}: ${clip(v, DETAIL_CLIP)}`);
  }
  const changes = Object.entries(e.changes ?? {})
    .slice(0, CHANGES_MAX)
    .map(([field, c]) =>
      SECRET_FIELD.test(field)
        ? `${field}: изменено`
        : `${field}: ${c.before === undefined ? '—' : clip(c.before, CHANGE_CLIP)} → ${c.after === undefined ? '—' : clip(c.after, CHANGE_CLIP)}`,
    );
  const details = parts.length > 0 ? maskSecrets(parts.join('; ')).text : undefined;
  return {
    at: e.occurredAt,
    what: (AUDIT_ACTIONS as Record<string, { label: string } | undefined>)[e.action]?.label ?? e.action,
    action: e.action,
    who: e.actorType === 'system' ? 'панель' : e.actorDisplay,
    result: e.result,
    severity: e.severity,
    source: e.source,
    target: e.targetDisplay,
    ...(details ? { details } : {}),
    ...(changes.length > 0 ? { changes } : {}),
  };
}

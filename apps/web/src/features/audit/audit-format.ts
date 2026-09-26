import {
  AUDIT_ACTOR_TYPE_LABELS,
  AUDIT_RESULT_LABELS,
  AUDIT_SOURCE_LABELS,
  type AuditEntry,
  auditActionLabel,
} from '@nodeservice/shared';

import { capFirst } from '@/lib/utils';

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Сегодня — только время; иначе «29.08 18:23:05». */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? timeFmt.format(d) : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

export function formatFull(iso: string): string {
  return fullFmt.format(new Date(iso));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} с`;
}

/** Значение для показа в деталях: строки как есть, остальное — компактный JSON. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Короткое имя браузера/ОС из User-Agent — полный UA в title. */
export function shortUserAgent(ua: string | null): string {
  if (!ua) return '—';
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0].replace('Edg/', 'Edge ') ??
    /Firefox\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ??
    /Chrome\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ??
    /Version\/(\d+).*Safari/.exec(ua)?.[1]?.replace(/^/, 'Safari ') ??
    null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Macintosh/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (!browser && !os) return ua.length > 40 ? `${ua.slice(0, 39)}…` : ua;
  return [browser, os].filter(Boolean).join(' · ');
}

const AMR_LABELS: Record<string, string> = {
  pwd: 'пароль',
  totp: 'код 2FA',
  recovery: 'код восстановления',
  trusted: 'доверенное устройство',
};

const REASON_LABELS: Record<string, string> = {
  credentials: 'неверный логин или пароль',
  'setup-token': 'неверный токен первого запуска',
  recovery: 'неверный код восстановления',
  password: 'неверный пароль',
};

const KEY_LABELS: Record<string, string> = {
  login: 'Логин',
  amr: 'Способ входа',
  reason: 'Причина',
  stage: 'Этап',
  recoveryCodesLeft: 'Кодов восстановления осталось',
  sessionsRevoked: 'Сессий завершено',
  status: 'HTTP-статус',
  error: 'Ошибка',
  version: 'Версия',
  node: 'Node.js',
  env: 'Окружение',
  month: 'Месяц',
  retentionMonths: 'Хранение, мес.',
  question: 'Вопрос',
  answer: 'Ответ',
  model: 'Модель',
  mode: 'Режим',
  toolCalls: 'Инструментов',
  proposals: 'Предложений',
  changeId: 'ID изменения',
  note: 'Итог',
};

/** Записи о решениях по изменениям, которые предложил Джарвис (J5): показываются своей строкой. */
const CHANGE_LEAD: Record<string, string> = {
  'assistant.change.applied': 'Джарвис предложил, вы применили',
  'assistant.change.reverted': 'Вы отменили изменение Джарвиса',
  'assistant.change.rejected': 'Вы отклонили предложение Джарвиса',
  'assistant.change.failed': 'Изменение по предложению Джарвиса не применено',
};

export const isChangeEntry = (entry: Pick<AuditEntry, 'action'>): boolean => entry.action in CHANGE_LEAD;

/** «Джарвис предложил, вы применили: Сменить провайдера»; для остальных записей null. */
export function changeHeadline(entry: AuditEntry): string | null {
  const lead = CHANGE_LEAD[entry.action];
  if (!lead) return null;
  const title = entry.metadata.title;
  return typeof title === 'string' && title ? `${lead}: ${title}` : lead;
}

/** Строки «было → станет» из метаданных изменения; пусто у остальных записей и при повреждённых данных. */
export function changeRows(entry: AuditEntry): Array<{ label: string; before: string; after: string }> {
  const rows = entry.metadata.rows;
  if (!isChangeEntry(entry) || !Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const row = r as Record<string, unknown> | null;
    return row && typeof row.label === 'string'
      ? [{ label: row.label, before: formatValue(row.before), after: formatValue(row.after) }]
      : [];
  });
}

const MODE_LABELS: Record<string, string> = { agent: 'Агент', analysis: 'Анализ' };

/** Эти ключи показываются отдельным блоком «Изменения» (строки «было → станет») или уже есть в заголовке. */
const HIDDEN_KEYS = new Set(['rows', 'title', 'operation']);

/** Метаданные записи → понятные подписи и значения; неизвестные ключи показываются как есть. */
export function metadataRows(
  metadata: Record<string, unknown>,
): Array<{ key: string; label: string; value: string }> {
  return Object.entries(metadata)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .map(([key, raw]) => {
      let value = formatValue(raw);
      if (key === 'amr' && Array.isArray(raw))
        value = capFirst(raw.map((m) => AMR_LABELS[String(m)] ?? String(m)).join(' + '));
      else if (key === 'reason' && typeof raw === 'string') value = capFirst(REASON_LABELS[raw] ?? raw);
      else if (key === 'mode' && typeof raw === 'string') value = MODE_LABELS[raw] ?? raw;
      else if (key === 'stage' && raw === 'setup') value = 'Первый запуск';
      else if (key === 'error' && typeof raw === 'string') value = raw.split('/').pop() ?? raw;
      else if (key === 'env')
        value = raw === 'production' ? 'Прод' : raw === 'development' ? 'Разработка' : value;
      return { key, label: KEY_LABELS[key] ?? key, value };
    });
}

/** Текстовый отчёт по одной записи — для кнопки «Скопировать» в раскрытых деталях. */
export function buildAuditReport(entry: AuditEntry): string {
  const lines = [
    '=== NodeService: запись Журнала ===',
    `Действие: ${auditActionLabel(entry.action)} (${entry.action})`,
    `Когда: ${formatFull(entry.occurredAt)}`,
    `Кто: ${entry.actorDisplay} · ${AUDIT_ACTOR_TYPE_LABELS[entry.actorType]}`,
    `IP: ${entry.ip ?? '—'}`,
    `Браузер: ${shortUserAgent(entry.userAgent)}`,
    `Запрос: ${entry.requestId ?? '—'}${entry.durationMs !== null ? ` · ${formatDuration(entry.durationMs)}` : ''}`,
    `Результат: ${AUDIT_RESULT_LABELS[entry.result]} · ${AUDIT_SOURCE_LABELS[entry.source]}`,
    ...(entry.targetDisplay
      ? [`Цель: ${entry.targetDisplay}${entry.targetType ? ` · ${entry.targetType}` : ''}`]
      : []),
  ];
  const changes = entry.changes ? Object.entries(entry.changes) : [];
  const rows = changeRows(entry);
  if (changes.length > 0 || rows.length > 0) {
    lines.push('Изменения:');
    for (const [field, diff] of changes)
      lines.push(`  ${field}: ${formatValue(diff.before)} → ${formatValue(diff.after)}`);
    for (const r of rows) lines.push(`  ${r.label}: ${r.before} → ${r.after}`);
  }
  const metadata = metadataRows(entry.metadata);
  if (metadata.length > 0) {
    lines.push('Данные:');
    for (const row of metadata) lines.push(`  ${row.label}: ${row.value}`);
  }
  return lines.join('\n');
}

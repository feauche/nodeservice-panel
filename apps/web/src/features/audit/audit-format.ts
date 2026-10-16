import {
  AUDIT_ACTOR_TYPE_LABELS,
  AUDIT_RESULT_LABELS,
  AUDIT_SOURCE_LABELS,
  type AuditEntry,
  auditActionLabel,
  INCIDENT_KIND_META,
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Значение для показа в деталях — словами, а не кодом: «Да/Нет», списки через запятую, даты по-русски,
 * вложенные поля — «подпись: значение».
 */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Да' : 'Нет';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)) ? formatFull(v) : v;
  if (Array.isArray(v)) return v.length ? v.map(formatValue).join(', ') : '—';
  if (typeof v === 'object')
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${KEY_LABELS[k] ?? CHANGE_LABELS[k] ?? k}: ${formatValue(x)}`)
      .join(', ');
  return String(v);
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
  unlock: 'неверный пароль на экране блокировки',
  totp: 'неверный код 2FA',
  pwned: 'пароль найден в утечках',
  throttled: 'пауза после неудачных попыток',
  idle: 'бездействие',
  manual: 'вручную',
  unauthenticated: 'нет входа',
  locked: 'экран заблокирован',
  csrf: 'устаревшая вкладка (защитный токен)',
};

/** Кто или что сделало: «by» в записях инцидентов и починки. */
const BY_LABELS: Record<string, string> = { manual: 'Вручную', auto: 'Автоматически', jarvis: 'Джарвис' };

/** HTTP-метод отклонённого запроса — что пытались сделать. */
const METHOD_LABELS: Record<string, string> = {
  GET: 'Чтение (GET)',
  POST: 'Действие (POST)',
  PUT: 'Изменение (PUT)',
  PATCH: 'Изменение (PATCH)',
  DELETE: 'Удаление (DELETE)',
};

const INCIDENT_STATUS_LABELS: Record<string, string> = {
  open: 'Открыт',
  acknowledged: 'Принят в работу',
  resolved: 'Закрыт',
};

/** Объект записи («Цель: … · сервер») — по-русски. */
export const TARGET_TYPE_LABELS: Record<string, string> = {
  settings: 'настройки',
  billing: 'биллинг',
  kb: 'база знаний',
  backup: 'резервная копия',
  provider: 'провайдер',
  incident: 'событие',
  user: 'учётная запись',
  node: 'нода',
  server: 'сервер',
  trusted_device: 'запомненное устройство',
  session: 'сессия',
  assistant: 'Джарвис',
  audit_partition: 'архив Журнала',
  scenario: 'сценарий',
  bs_ws: 'точка WebSocket',
  bs_rental: 'точка TCP/UDP',
};

/** Подпись поля в таблице «Изменения»; неизвестное поле — как есть. */
export function changeFieldLabel(field: string): { label: string; known: boolean } {
  const label = CHANGE_LABELS[field] ?? KEY_LABELS[field];
  return label ? { label, known: true } : { label: field, known: false };
}

/** Поля настроек в таблице «Изменения» (было → стало). */
const CHANGE_LABELS: Record<string, string> = {
  brandName: 'Название панели',
  logoUrl: 'Логотип',
  timeZone: 'Часовой пояс',
  sites: 'Свои сайты',
  idleMinutes: 'Завершать сессию после, мин',
  lockAfterMinutes: 'Блокировать экран после, мин',
  alwaysAskTotp: 'Всегда спрашивать код 2FA',
  intervalSec: 'Частота опроса, с',
  enabled: 'Включено',
  name: 'Название',
  url: 'Адрес',
  siteUrl: 'Сайт',
  iconUrl: 'Иконка',
  note: 'Заметка',
  providerId: 'Провайдер',
  countrySource: 'Как определена страна',
  country: 'Страна',
  roles: 'Роли',
  nodeWatch: 'Следить за нодой',
  tags: 'Теги',
  amount: 'Сумма',
  currency: 'Валюта',
  period: 'Период',
  paidUntil: 'Оплачено до',
  autoCharge: 'Автопродление',
  retentionMonths: 'Хранение, мес.',
  schedule: 'Расписание',
  keep: 'Хранить копий',
  model: 'Модель',
  level: 'Уровень',
  title: 'Заголовок',
  body: 'Текст',
};

const KEY_LABELS: Record<string, string> = {
  login: 'Логин',
  // Обслуживание ноды (0.106.0)
  term: 'Срок',
  until: 'До',
  hideHosts: 'Скрыть Host',
  hiddenHosts: 'Скрыты Host',
  hostsError: 'Host не скрыты',
  closedEvents: 'Закрыто событий',
  restoredHosts: 'Возвращены Host',
  hostsFailed: 'Host не вернули',
  amr: 'Способ входа',
  reason: 'Причина',
  lockAfterMinutes: 'Блокировка после, мин',
  attempts: 'Попыток',
  by: 'Кто',
  kind: 'Вид',
  server: 'Сервер',
  method: 'Что пытались сделать',
  path: 'Адрес запроса',
  messages: 'Сообщений',
  kbWrites: 'Записей в базу знаний',
  advice: 'Советы',
  scope: 'Охват',
  current: 'Это устройство',
  ipPrefix: 'Сеть',
  sessionIp: 'IP сессии',
  sessionCreatedAt: 'Сессия начата',
  trustedDevicesRemoved: 'Забыто устройств',
  recoveryCodesIssued: 'Выдано кодов восстановления',
  passwordChanged: 'Пароль изменён',
  total: 'Всего',
  used: 'Использовано',
  count: 'Количество',
  users: 'Пользователей',
  nodes: 'Нод',
  size: 'Размер',
  encrypted: 'Зашифрована',
  metrics: 'С метриками',
  paths: 'Дополнительных папок',
  offsite: 'Внешнее хранилище',
  chats: 'Чатов',
  added: 'Добавлено',
  removed: 'Удалено',
  events: 'События',
  quiet: 'Тихие часы',
  proxy: 'Прокси',
  chat: 'Чат',
  ok: 'Успешно',
  detail: 'Подробности',
  reviewed: 'Проверено статей',
  articles: 'Статьи',
  archived: 'В архиве',
  deleted: 'Удалено',
  enabled: 'Включено',
  billingHistoryPreserved: 'История оплат сохранена',
  mergedFrom: 'Старая запись панели',
  movedPayments: 'Перенесено оплат',
  versionCreatedAt: 'Версия от',
  retentionDays: 'Хранение, дней',
  incidents: 'Событий',
  paidUntil: 'Оплачено до',
  amount: 'Сумма',
  siteUrl: 'Сайт',
  iconUrl: 'Иконка',
  autoChargeDisabled: 'Автопродление выключено',
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
  verdict: 'Доступность',
  checkedAt: 'Время проверки',
  ports: 'Порты и точки Check-Host',
  reports: 'Отчёты Check-Host',
  domain: 'Домен',
  from: 'Было',
  to: 'Стало',
  nodeName: 'Нода',
  changed: 'Что сделано',
  autoreplace: 'Автозамена',
  points: 'Точек',
  working: 'Работает',
  failing: 'Не отвечают',
};

/** Записи о решениях по изменениям, которые предложил Ассистент (J5): показываются своей строкой. */
const CHANGE_LEAD: Record<string, string> = {
  'assistant.change.applied': 'Ассистент предложил, вы применили',
  'assistant.change.reverted': 'Вы отменили изменение Ассистента',
  'assistant.change.rejected': 'Вы отклонили предложение Ассистента',
  'assistant.change.failed': 'Изменение по предложению Ассистента не применено',
};

export const isChangeEntry = (entry: Pick<AuditEntry, 'action'>): boolean => entry.action in CHANGE_LEAD;

/** «Ассистент предложил, вы применили: Сменить провайдера»; для остальных записей null. */
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
      if (key === 'verdict' && typeof raw === 'string')
        value =
          (
            {
              reachable: 'Доступен',
              russia_unreachable: 'Недоступен из РФ',
              russia_partial: 'Частично недоступен из РФ',
              port_unreachable: 'TCP-порты не отвечают',
              unknown: 'Неполный результат',
            } as Record<string, string>
          )[raw] ?? raw;
      else if (key === 'amr' && Array.isArray(raw))
        value = capFirst(raw.map((m) => AMR_LABELS[String(m)] ?? String(m)).join(' + '));
      else if (key === 'reason' && typeof raw === 'string') value = capFirst(REASON_LABELS[raw] ?? raw);
      else if (key === 'by' && typeof raw === 'string') value = BY_LABELS[raw] ?? raw;
      else if (key === 'method' && typeof raw === 'string') value = METHOD_LABELS[raw] ?? raw;
      else if (key === 'scope' && typeof raw === 'string')
        value = raw === 'all' ? 'Все сессии' : raw === 'user' ? 'Сессии одной учётной записи' : raw;
      else if (key === 'kind' && typeof raw === 'string' && raw in INCIDENT_KIND_META)
        value = INCIDENT_KIND_META[raw as keyof typeof INCIDENT_KIND_META].label;
      else if (key === 'status' && typeof raw === 'string') value = INCIDENT_STATUS_LABELS[raw] ?? raw;
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
      ? [
          `Цель: ${entry.targetDisplay}${entry.targetType ? ` · ${TARGET_TYPE_LABELS[entry.targetType] ?? entry.targetType}` : ''}`,
        ]
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

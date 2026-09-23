import { z } from 'zod';

/**
 * Контракт Журнала (audit log).
 *
 *  GET /api/audit          → AuditListResponse   (номерная пагинация, новые сверху)
 *  GET /api/audit/stream   → SSE: event=audit, id=seq, data=AuditEntry; event=ping — heartbeat
 *  GET /api/audit/export   → CSV/JSON по тем же фильтрам (поток, до AUDIT_EXPORT_MAX строк)
 *
 * Действия (action) — стабильные машинные ключи; подписи на русском живут здесь же,
 * чтобы фронт и экспорт показывали одно и то же.
 */

export const AUDIT_CATEGORIES = [
  'auth',
  'settings',
  'security',
  'server',
  'knowledge',
  'assistant',
  'system',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Категория действия по префиксу ключа. По умолчанию префикс и есть категория
 * (`auth.login.success` → auth); исключения — короткие префиксы, у которых в Журнале
 * своя категория: `kb.*` → «База знаний», `incident.*` → «Серверы». Ключи не переименовываем:
 * они лежат в audit_log и в CHECK-констрейнте (миграция 0014).
 */
export const AUDIT_PREFIX_CATEGORY: Readonly<Record<string, AuditCategory>> = {
  kb: 'knowledge',
  incident: 'server',
  provider: 'server',
};

export function auditCategoryOfPrefix(action: string): AuditCategory | undefined {
  const prefix = action.split('.', 1)[0] ?? '';
  const mapped = AUDIT_PREFIX_CATEGORY[prefix];
  if (mapped) return mapped;
  return (AUDIT_CATEGORIES as readonly string[]).includes(prefix) ? (prefix as AuditCategory) : undefined;
}

export const AUDIT_RESULTS = ['ok', 'failed', 'denied'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const AUDIT_SEVERITIES = ['info', 'warn', 'crit'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** Источник действия: вручную (администратор) или авто (сервис, расписание, позже — AI). */
export const AUDIT_SOURCES = ['manual', 'auto'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_ACTOR_TYPES = ['admin', 'system', 'anonymous'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  auth: 'Вход',
  settings: 'Настройки',
  security: 'Безопасность',
  server: 'Серверы',
  knowledge: 'База знаний',
  assistant: 'Ассистент',
  system: 'Система',
};

export const AUDIT_RESULT_LABELS: Record<AuditResult, string> = {
  ok: 'Успешно',
  failed: 'Ошибка',
  denied: 'Отказано',
};

export const AUDIT_SOURCE_LABELS: Record<AuditSource, string> = {
  manual: 'вручную',
  auto: 'авто',
};

export const AUDIT_ACTOR_TYPE_LABELS: Record<AuditActorType, string> = {
  admin: 'Администратор',
  system: 'Сервис',
  anonymous: 'Гость',
};

/** Все известные действия с категорией и подписью. Новые этапы добавляют сюда. */
export const AUDIT_ACTIONS = {
  'auth.setup.completed': { category: 'auth', label: 'Первый запуск: администратор создан' },
  'auth.login.success': { category: 'auth', label: 'Вход в панель' },
  'auth.login.failed': { category: 'auth', label: 'Неудачная попытка входа' },
  'auth.login.throttled': { category: 'auth', label: 'Вход заблокирован: слишком много попыток' },
  'auth.totp.failed': { category: 'auth', label: 'Неверный код 2FA' },
  'auth.recovery.used': { category: 'auth', label: 'Вход по коду восстановления' },
  'auth.logout': { category: 'auth', label: 'Выход из панели' },
  'auth.lock': { category: 'auth', label: 'Экран заблокирован' },
  'auth.unlock': { category: 'auth', label: 'Разблокировка экрана' },
  'auth.trusted_device.added': { category: 'auth', label: 'Устройство запомнено на 30 дней' },
  'auth.request.denied': { category: 'auth', label: 'Запрос отклонён: нет входа или экран заблокирован' },
  'auth.csrf.denied': { category: 'auth', label: 'Запрос отклонён: неверный CSRF-токен' },
  'auth.setup_token.issued': { category: 'auth', label: 'Выпущен токен первого запуска (CLI)' },
  'settings.appearance.updated': { category: 'settings', label: 'Изменён внешний вид' },
  'security.password.changed': { category: 'security', label: 'Смена пароля' },
  'security.step_up.denied': {
    category: 'security',
    label: 'Действие отклонено: нужно подтверждение пароля',
  },
  'security.totp.reissue_started': { category: 'security', label: 'Начат перевыпуск 2FA' },
  'security.cli.password_reset': { category: 'security', label: 'Пароль сброшен через rescue-CLI' },
  'security.cli.totp_disabled': { category: 'security', label: '2FA отключена через rescue-CLI' },
  'security.cli.sessions_revoked': { category: 'security', label: 'Сессии завершены через rescue-CLI' },
  'security.totp.reissued': { category: 'security', label: 'Перевыпуск 2FA' },
  'security.recovery_codes.regenerated': { category: 'security', label: 'Новые коды восстановления' },
  'security.recovery_codes.viewed': { category: 'security', label: 'Просмотр кодов восстановления' },
  'security.session.revoked': { category: 'security', label: 'Сессия завершена' },
  'security.sessions.revoked_others': { category: 'security', label: 'Завершены все сессии, кроме текущей' },
  'security.trusted_device.removed': { category: 'security', label: 'Запомненное устройство удалено' },
  'security.trusted_devices.cleared': { category: 'security', label: 'Все запомненные устройства удалены' },
  'security.policy.updated': { category: 'security', label: 'Изменена политика безопасности' },
  'server.created': { category: 'server', label: 'Сервер добавлен' },
  'server.duplicated': { category: 'server', label: 'Сервер продублирован' },
  'server.reordered': { category: 'server', label: 'Порядок серверов изменён' },
  'server.updated': { category: 'server', label: 'Сервер изменён' },
  'server.deleted': { category: 'server', label: 'Сервер удалён' },
  'server.ssh.checked': { category: 'server', label: 'Проверка связи по SSH' },
  'server.host_key.trusted': { category: 'server', label: 'Доверен новый отпечаток сервера' },
  'server.enrollment.issued': { category: 'server', label: 'Выпущен токен подключения агента' },
  'server.agent.install': { category: 'server', label: 'Установка агента по SSH' },
  'server.agent.enrolled': { category: 'server', label: 'Агент подключён к серверу' },
  'server.agent.online': { category: 'server', label: 'Агент вышел на связь' },
  'server.agent.offline': { category: 'server', label: 'Агент пропал со связи' },
  'server.agent.auth_failed': { category: 'server', label: 'Подключение агента отклонено' },
  'server.autocheck.ssh': { category: 'server', label: 'Автопроверка SSH изменила статус' },
  'server.terminal.open': { category: 'server', label: 'Открыт веб-терминал' },
  'server.terminal.close': { category: 'server', label: 'Веб-терминал закрыт' },
  'server.terminal.denied': { category: 'server', label: 'Веб-терминал отклонён: нет входа' },
  'provider.created': { category: 'server', label: 'Провайдер добавлен' },
  'provider.updated': { category: 'server', label: 'Провайдер изменён' },
  'provider.deleted': { category: 'server', label: 'Провайдер удалён' },
  'server.maintenance.check': { category: 'server', label: 'Проверка обслуживания сервера' },
  'server.maintenance.apt_upgrade': { category: 'server', label: 'Обновление системы' },
  'server.maintenance.agent_update': { category: 'server', label: 'Обновление агента' },
  'server.maintenance.cleanup': { category: 'server', label: 'Очистка диска' },
  'server.maintenance.unattended_enable': {
    category: 'server',
    label: 'Включены автообновления безопасности',
  },
  'settings.autochecks.updated': { category: 'settings', label: 'Автопроверки изменены' },
  'settings.incidents.updated': { category: 'settings', label: 'Настройки инцидентов изменены' },
  'settings.assistant.updated': { category: 'settings', label: 'Настройки AI-ассистента изменены' },
  'settings.snippets.updated': { category: 'settings', label: 'Сниппеты терминала изменены' },
  'kb.created': { category: 'knowledge', label: 'Статья базы знаний создана' },
  'kb.updated': { category: 'knowledge', label: 'Статья базы знаний изменена' },
  'kb.deleted': { category: 'knowledge', label: 'Статья базы знаний удалена' },
  'kb.reverted': { category: 'knowledge', label: 'Статья восстановлена из версии' },
  'kb.reviewed': { category: 'knowledge', label: 'Ревизия базы знаний' },
  'assistant.chat': { category: 'assistant', label: 'Запрос к AI-ассистенту' },
  'incident.opened': { category: 'server', label: 'Инцидент заведён' },
  'incident.resolved': { category: 'server', label: 'Инцидент закрыт' },
  'incident.acknowledged': { category: 'server', label: 'Инцидент взят в работу' },
  'incident.autofix': { category: 'server', label: 'Автопочинка инцидента' },
  'system.started': { category: 'system', label: 'Сервис запущен' },
  'system.audit.partition_created': { category: 'system', label: 'Журнал: создан раздел на месяц' },
  'system.audit.partition_dropped': {
    category: 'system',
    label: 'Журнал: удалён раздел старше срока хранения',
  },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, { label: string }>)[action]?.label ?? action;
}

/** Изменённые поля: только diff, никогда не секреты (для секретов — факт изменения в metadata). */
export const auditChangesSchema = z.record(
  z.string(),
  z.object({ before: z.unknown().optional(), after: z.unknown().optional() }),
);
export type AuditChanges = z.infer<typeof auditChangesSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  /** Монотонный номер для SSE (Last-Event-ID) и стабильного порядка. */
  seq: z.number().int(),
  occurredAt: z.iso.datetime({ offset: true }),
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorId: z.string().nullable(),
  /** Имя на момент события (снапшот) — не меняется при переименовании. */
  actorDisplay: z.string(),
  /** Машинный ключ; фронт берёт подпись из AUDIT_ACTIONS, неизвестное показывает как есть. */
  action: z.string(),
  category: z.enum(AUDIT_CATEGORIES),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  targetDisplay: z.string().nullable(),
  result: z.enum(AUDIT_RESULTS),
  severity: z.enum(AUDIT_SEVERITIES),
  source: z.enum(AUDIT_SOURCES),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  changes: auditChangesSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** `a,b` из query-строки или массив — в массив уникальных значений. */
function csvList<T extends z.ZodType>(item: T) {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const clean = arr.map((x) => String(x).trim()).filter(Boolean);
    return clean.length ? [...new Set(clean)] : undefined;
  }, z.array(item).min(1).optional());
}

export const AUDIT_PAGE_SIZE_MIN = 5;
export const AUDIT_PAGE_SIZE_MAX = 200;
export const AUDIT_PAGE_SIZE_DEFAULT = 25;

export const auditFilterSchema = z.object({
  /** Фильтр по цели (например, все события конкретного сервера). */
  targetId: z.string().max(100).optional(),
  category: csvList(z.enum(AUDIT_CATEGORIES)),
  result: csvList(z.enum(AUDIT_RESULTS)),
  source: z.enum(AUDIT_SOURCES).optional(),
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  /** Полнотекстовый поиск (websearch-синтаксис: слова, "фразы", -минус). */
  q: z.string().trim().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type AuditFilter = z.infer<typeof auditFilterSchema>;

export const auditListQuerySchema = auditFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(AUDIT_PAGE_SIZE_MIN)
    .max(AUDIT_PAGE_SIZE_MAX)
    .default(AUDIT_PAGE_SIZE_DEFAULT),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export type AuditListQueryInput = z.input<typeof auditListQuerySchema>;

export const auditListResponseSchema = z.object({
  items: z.array(auditEntrySchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];
/** Потолок экспорта за один запрос — защищает БД и браузер; больше — сузить период. */
export const AUDIT_EXPORT_MAX = 100_000;

export const auditExportQuerySchema = auditFilterSchema.extend({
  format: z.enum(AUDIT_EXPORT_FORMATS).default('csv'),
});
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

/** Имя SSE-события с записью; `ping` — heartbeat каждые ~20 с. */
export const AUDIT_SSE_EVENT = 'audit';

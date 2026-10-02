import { z } from 'zod';

/**
 * Резервные копии панели («Настройки → Резервные копии», витрина `backups-variants.html`, A). Архив того же
 * формата, что у `nodeservice backup` в консоли: meta + env (ключи установки) + db.dump, по желанию — метрики
 * и дополнительные файлы. С паролем — шифруется так, что открывается и `openssl enc -d -aes-256-cbc -pbkdf2`.
 */

export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 50;
export const BACKUP_EXTRA_PATHS_MAX = 20;
/** Бот Telegram присылает файлы до 50 МБ. */
export const TELEGRAM_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
export const BACKUP_RESTORE_CONFIRM = 'ВОССТАНОВИТЬ';
/** Имя файла копии: только то, что делает панель или консоль. */
export const BACKUP_NAME_RE = /^nodeservice-backup-[0-9A-Za-z_-]{6,40}\.tar\.gz(\.enc)?$/;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в виде ЧЧ:ММ');

export const BACKUP_KINDS = ['auto', 'manual', 'pre_restore', 'pre_update', 'console', 'uploaded'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
export const BACKUP_KIND_LABELS: Record<BackupKind, string> = {
  auto: 'авто',
  manual: 'вручную',
  pre_restore: 'перед восстановлением',
  pre_update: 'перед обновлением',
  console: 'из консоли',
  uploaded: 'загружена',
};

export const backupSettingsSchema = z.object({
  auto: z.boolean(),
  frequency: z.enum(['day', 'week']),
  /** 1 — понедельник … 7 — воскресенье. */
  weekday: z.number().int().min(1).max(7),
  time: hhmm,
  keep: z.number().int().min(BACKUP_KEEP_MIN).max(BACKUP_KEEP_MAX),
  /** Копия перед `nodeservice update` (делает консоль, панель только включает и выключает). */
  beforeUpdate: z.boolean(),
  telegram: z.object({
    enabled: z.boolean(),
    /** Чат из «Уведомлений» (id назначения) или свой чат строкой tgram://. */
    target: z.enum(['notifications', 'own']),
    destinationId: z.string().nullable(),
    /** Свой чат маской (maskTelegramUrl: вместо токена — три звёздочки); null — не задан. */
    ownUrl: z.string().nullable(),
    notifyFailure: z.boolean(),
  }),
  offsite: z.object({
    enabled: z.boolean(),
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    credentialsSet: z.boolean(),
  }),
  /** Пароль задан (сам пароль наружу не отдаётся никогда). */
  passwordSet: z.boolean(),
  includeMetrics: z.boolean(),
  extra: z.object({ enabled: z.boolean(), paths: z.array(z.string()) }),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export const BACKUP_SETTINGS_DEFAULT: BackupSettings = {
  auto: true,
  frequency: 'day',
  weekday: 7,
  time: '04:00',
  keep: 7,
  beforeUpdate: true,
  telegram: {
    enabled: false,
    target: 'notifications',
    destinationId: null,
    ownUrl: null,
    notifyFailure: true,
  },
  offsite: {
    enabled: false,
    endpoint: '',
    region: 'auto',
    bucket: '',
    prefix: 'nodeservice',
    credentialsSet: false,
  },
  passwordSet: false,
  includeMetrics: false,
  extra: { enabled: false, paths: [] },
};

const pathSchema = z
  .string()
  .trim()
  .min(2)
  .max(300)
  .regex(/^\/[^\0\n]*$/, 'Полный путь от корня, например /etc/nginx')
  .refine((p) => !p.split('/').includes('..'), 'Без «..» в пути')
  // Часть пути с «-» в начале программа упаковки приняла бы за свой параметр и выполнила.
  .refine((p) => !p.split('/').some((part) => part.startsWith('-')), 'Часть пути не может начинаться с «-»');

export const backupSettingsUpdateSchema = z.object({
  auto: z.boolean().optional(),
  frequency: z.enum(['day', 'week']).optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  time: hhmm.optional(),
  keep: z.number().int().min(BACKUP_KEEP_MIN).max(BACKUP_KEEP_MAX).optional(),
  beforeUpdate: z.boolean().optional(),
  telegram: z
    .object({
      enabled: z.boolean(),
      target: z.enum(['notifications', 'own']),
      destinationId: z.string().nullable(),
      /**
       * Новый свой чат строкой tgram://; null — убрать; не передан — не менять. Маску сервер отдаёт только
       * для показа: сохранить её нельзя, поэтому неизменённое поле интерфейс не отправляет.
       */
      ownUrl: z.string().trim().max(300).nullable().optional(),
      notifyFailure: z.boolean(),
    })
    .optional(),
  offsite: z
    .object({
      enabled: z.boolean(),
      endpoint: z.string().trim().max(500),
      region: z.string().trim().min(1).max(100),
      bucket: z.string().trim().max(255),
      prefix: z.string().trim().max(300),
      accessKeyId: z.string().trim().max(300).nullable().optional(),
      secretAccessKey: z.string().max(500).nullable().optional(),
    })
    .optional(),
  /** Новый пароль; '' или null — снять пароль; не передан — не менять. */
  password: z.string().max(200).nullable().optional(),
  includeMetrics: z.boolean().optional(),
  extra: z
    .object({ enabled: z.boolean(), paths: z.array(pathSchema).max(BACKUP_EXTRA_PATHS_MAX) })
    .optional(),
});
export type BackupSettingsUpdate = z.infer<typeof backupSettingsUpdateSchema>;

export const backupItemSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  size: z.number().int(),
  kind: z.enum(BACKUP_KINDS),
  encrypted: z.boolean(),
  /** Проверена после создания: архив читается, дамп базы разворачивается. null — не проверялась. */
  verified: z.boolean().nullable(),
  /** Отправка в Telegram: sent / failed (с причиной) / null — не отправлялась. */
  telegram: z.object({ ok: z.boolean(), note: z.string().nullable() }).nullable(),
  /** Вторая физическая копия в S3-совместимом хранилище. */
  offsite: z.object({ ok: z.boolean(), location: z.string(), note: z.string().nullable() }).nullable(),
  /** Что внутри (если известно): база, ключи, метрики, число путей. */
  contents: z
    .object({ db: z.boolean(), env: z.boolean(), metrics: z.boolean(), paths: z.number().int() })
    .nullable(),
  version: z.string().nullable(),
});
export type BackupItem = z.infer<typeof backupItemSchema>;

export const BACKUP_STAGES = [
  'db',
  'env',
  'metrics',
  'files',
  'pack',
  'encrypt',
  'verify',
  'offsite',
  'telegram',
  'cleanup',
] as const;
export type BackupStage = (typeof BACKUP_STAGES)[number];
export const BACKUP_STAGE_LABELS: Record<BackupStage, string> = {
  db: 'Сохраняю базу данных',
  env: 'Беру ключи установки',
  metrics: 'Выгружаю метрики',
  files: 'Собираю дополнительные файлы',
  pack: 'Упаковываю архив',
  encrypt: 'Шифрую паролем',
  verify: 'Проверяю копию',
  offsite: 'Отправляю во внешнее хранилище',
  telegram: 'Отправляю в Telegram',
  cleanup: 'Удаляю старые копии',
};

export const backupRunSchema = z.object({
  /** Что сейчас делается; null — ничего. */
  stage: z.enum(BACKUP_STAGES).nullable(),
  startedAt: z.string().nullable(),
  /** restore — идёт восстановление (панель скоро перезапустится). */
  mode: z.enum(['backup', 'restore']).nullable(),
  lastError: z.string().nullable(),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

export const backupsResponseSchema = z.object({
  items: z.array(backupItemSchema),
  /** Абсолютная папка на сервере панели, где лежат локальные архивы. */
  localLocation: z.string(),
  run: backupRunSchema,
  /** Следующая копия по расписанию; null — расписание выключено. */
  nextAt: z.string().nullable(),
  timeZone: z.string(),
  totalSize: z.number().int(),
  /** Свободно на диске сервера панели, байты; null — неизвестно. */
  freeBytes: z.number().int().nullable(),
  /** Панель умеет делать копии (есть инструменты базы данных). */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type BackupsResponse = z.infer<typeof backupsResponseSchema>;

export const backupRunRequestSchema = z.object({ sendTelegram: z.boolean().optional() });
export const backupRestoreRequestSchema = z.object({
  password: z.string().max(200).optional(),
  confirm: z.literal(BACKUP_RESTORE_CONFIRM, {
    message: `Для подтверждения введите «${BACKUP_RESTORE_CONFIRM}»`,
  }),
});
export const backupInspectRequestSchema = z.object({ password: z.string().max(200).optional() });
export const backupInspectSchema = z.object({
  name: z.string(),
  createdAt: z.string().nullable(),
  version: z.string().nullable(),
  domain: z.string().nullable(),
  encrypted: z.boolean(),
  /** Пароль нужен и не подошёл (или не передан). */
  needsPassword: z.boolean(),
  contents: z
    .object({ dbBytes: z.number().int(), env: z.boolean(), metrics: z.boolean(), paths: z.number().int() })
    .nullable(),
  /**
   * Ключи из архива (или их отпечаток) совпадают с ключами этой установки — можно восстановить из панели.
   * null — в архиве нет ни ключей, ни отпечатка: сверить не с чем.
   */
  sameKeys: z.boolean().nullable(),
  compatible: z.boolean(),
  /** Почему восстановить нельзя (или нужен пароль). */
  problem: z.string().nullable(),
  /** Восстановить можно, но есть оговорка — например, в копии нет ключей и сверить её не с чем. */
  warning: z.string().nullable().optional(),
});
export type BackupInspect = z.infer<typeof backupInspectSchema>;

export const backupPathCheckRequestSchema = z.object({
  paths: z.array(pathSchema).max(BACKUP_EXTRA_PATHS_MAX),
});
export const backupPathCheckSchema = z.object({
  items: z.array(
    z.object({
      path: z.string(),
      state: z.enum(['file', 'dir', 'missing', 'denied']),
      size: z.number().int().nullable(),
    }),
  ),
});
export type BackupPathCheck = z.infer<typeof backupPathCheckSchema>;

export const BACKUP_PROBLEM = {
  busy: 'urn:nodeservice:problem:backup-busy',
  notFound: 'urn:nodeservice:problem:backup-not-found',
  password: 'urn:nodeservice:problem:backup-password',
  unavailable: 'urn:nodeservice:problem:backup-unavailable',
  /** Восстановление сорвалось: в detail — что с текущей базой и причина по-русски. */
  restoreFailed: 'urn:nodeservice:problem:backup-restore-failed',
  /** Файл копии есть, но панель не может его прочитать. */
  unreadable: 'urn:nodeservice:problem:backup-unreadable',
} as const;

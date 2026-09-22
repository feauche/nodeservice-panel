import { z } from 'zod';

/**
 * Схема переменных окружения. Приложение не стартует, если что-то не так —
 * лучше упасть при запуске с понятной ошибкой, чем на первом запросе.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Публичный адрес панели (для ссылок, cookie-домена, CORS). */
  PUBLIC_URL: z.url().default('http://localhost:5173'),
  /** VictoriaMetrics: приём метрик агентов (import) и чтение (PromQL). */
  VM_URL: z.url().default('http://127.0.0.1:8428'),
  /** GitHub-репозиторий агента: релизы с бинарями и install.sh. */
  AGENT_REPO: z.string().default('feauche/nodeservice-agent'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  DATABASE_URL: z.url().default('postgres://nodeservice:nodeservice@localhost:5432/nodeservice'),
  VALKEY_URL: z.url().default('redis://localhost:6379'),
  VICTORIA_URL: z.url().default('http://localhost:8428'),

  /** Подпись cookie / CSRF / служебных токенов. 64 hex-символа (32 байта). */
  APP_SECRET: z.string().min(32),
  /** AES-256-GCM для секретов в БД (TOTP, токены интеграций). 64 hex-символа. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY: ожидается 64 hex-символа (openssl rand -hex 32)'),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  /**
   * Pepper для argon2 (пароли, коды восстановления): 32–64 hex-символа. Не задан —
   * выводится из APP_SECRET через HKDF-SHA256 (поменяешь APP_SECRET — пароли перестанут подходить).
   */
  PASSWORD_PEPPER: z
    .string()
    .regex(/^[0-9a-f]{32,128}$/i, 'PASSWORD_PEPPER: ожидается 32–128 hex-символов (openssl rand -hex 32)')
    .optional(),

  /** Доверяем X-Forwarded-For только от одного прокси (Caddy). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  /** Сессия: сколько минут бездействия до выхода (скользящий TTL). */
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(360),
  /** Сессия: абсолютный максимум жизни в часах (обычный вход). */
  SESSION_ABSOLUTE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(12),
  /** Сессия с доверенного устройства: абсолютный максимум в часах. */
  TRUSTED_SESSION_ABSOLUTE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(168),
  /** Проверять новый пароль по утечкам (Have I Been Pwned, k-anonymity: наружу уходят 5 символов хеша). */
  PASSWORD_LEAK_CHECK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Журнал: сколько месяцев хранить записи; старые разделы удаляются целиком (DROP PARTITION). */
  AUDIT_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(12),
  /** Применять миграции БД при старте (в проде — да, образ самодостаточен). */
  AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Некорректные переменные окружения:\n${issues}`);
  }
  return result.data;
}

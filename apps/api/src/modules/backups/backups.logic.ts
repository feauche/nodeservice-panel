import { createHash } from 'node:crypto';

import type { BackupSettings } from '@nodeservice/shared';

import { localDate, localMidnight } from '../billing/billing.logic.js';

const DAY = 86_400_000;

/** Момент копии по расписанию в конкретный местный день. */
function slotOn(y: number, m: number, d: number, time: string, tz: string): Date {
  const [h, min] = time.split(':').map(Number);
  return new Date(localMidnight(y, m, d, tz).getTime() + ((h ?? 0) * 60 + (min ?? 0)) * 60_000);
}

function slots(
  now: Date,
  s: Pick<BackupSettings, 'frequency' | 'weekday' | 'time'>,
  tz: string,
  dir: 1 | -1,
): Date | null {
  for (let k = 0; k <= 8; k += 1) {
    const ld = localDate(new Date(now.getTime() + dir * k * DAY), tz);
    if (s.frequency === 'week' && ld.wd !== s.weekday) continue;
    const t = slotOn(ld.y, ld.m, ld.d, s.time, tz);
    if (dir === 1 ? t > now : t <= now) return t;
  }
  return null;
}

/** Следующая копия по расписанию (местное время панели). */
export const nextBackupAt = (
  now: Date,
  s: Pick<BackupSettings, 'frequency' | 'weekday' | 'time'>,
  tz: string,
) => slots(now, s, tz, 1);

/** Последний момент по расписанию, который уже наступил. */
export const lastScheduledAt = (
  now: Date,
  s: Pick<BackupSettings, 'frequency' | 'weekday' | 'time'>,
  tz: string,
) => slots(now, s, tz, -1);

/** Сколько после момента расписания панель ещё берётся за копию (дальше — уже следующий момент). */
export const BACKUP_CATCH_UP_MS = 6 * 3_600_000;
/** Как часто повторяется копия по расписанию, которая не получилась. */
export const BACKUP_RETRY_MS = 3_600_000;

/**
 * Пора ли делать копию: наступил момент по расписанию, после него автокопии ещё не было, и прошло не больше
 * 6 часов (панель перезапускалась в 04:00 — сделает, как поднимется; но не догоняет старое).
 * lastAttemptAt — когда панель последний раз бралась за копию по расписанию: неудачная попытка файла не
 * оставляет, и без этой отметки копия запускалась бы заново каждую минуту. Повтор — не чаще раза в час.
 */
export function isBackupDue(
  now: Date,
  s: Pick<BackupSettings, 'auto' | 'frequency' | 'weekday' | 'time'>,
  tz: string,
  lastAutoAt: Date | null,
  lastAttemptAt: Date | null = null,
): boolean {
  if (!s.auto) return false;
  const slot = lastScheduledAt(now, s, tz);
  if (!slot || now.getTime() - slot.getTime() > BACKUP_CATCH_UP_MS) return false;
  if (lastAutoAt && lastAutoAt >= slot) return false;
  const triedForSlot = lastAttemptAt !== null && lastAttemptAt >= slot;
  return !triedForSlot || now.getTime() - lastAttemptAt.getTime() >= BACKUP_RETRY_MS;
}

/**
 * Будет ли ещё одна попытка для этого момента расписания, если нынешняя (в now) не получится. С запасом в
 * минуту: расписание проверяется раз в минуту, и обещать повтор на самой границе шести часов нельзя.
 */
export function willRetryBackup(now: Date, slot: Date): boolean {
  return now.getTime() + BACKUP_RETRY_MS + 60_000 - slot.getTime() <= BACKUP_CATCH_UP_MS;
}

/** Имя архива как у консольного бэкапа: nodeservice-backup-ГГГГММДД-ЧЧММСС.tar.gz (UTC). */
export function backupName(at: Date, encrypted: boolean, suffix = ''): string {
  const ts = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `nodeservice-backup-${ts}${suffix}.tar.gz${encrypted ? '.enc' : ''}`;
}

/** Время из имени файла (для копий без описания, например из консоли). */
export function timeFromName(name: string): Date | null {
  const m = /nodeservice-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  return new Date(Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6)));
}

/** «meta» архива: строки ключ=значение. */
export function parseMeta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** a < b по версии «0.38.1». */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Ключи установки из .env, без которых не расшифровать секреты. */
export const SECRET_KEYS = [
  'ENCRYPTION_KEY',
  'ENCRYPTION_KEY_VERSION',
  'APP_SECRET',
  'PASSWORD_PEPPER',
] as const;
export function envValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Строки файла «env» в архиве — те же, что install.sh пишет в .env установки и что читает консольное
 * восстановление (install.sh --restore, nodeservice restore): домен и почта для сертификата, пароль базы,
 * ключи шифрования.
 */
export const INSTALL_ENV_KEYS = [
  'PANEL_DOMAIN',
  'ACME_EMAIL',
  'NODESERVICE_VERSION',
  'POSTGRES_PASSWORD',
  'APP_SECRET',
  'ENCRYPTION_KEY',
  'ENCRYPTION_KEY_VERSION',
  'PASSWORD_PEPPER',
] as const;
export type InstallEnvKey = (typeof INSTALL_ENV_KEYS)[number];
export type InstallEnv = Partial<Record<InstallEnvKey, string>>;
/** Без них install.sh --restore архив не примет (та же проверка, что в нём). */
export const INSTALL_ENV_REQUIRED = ['POSTGRES_PASSWORD', 'APP_SECRET', 'ENCRYPTION_KEY'] as const;

/**
 * Ключи установки — из настроек работающей панели. Сам файл .env на сервере закрыт от пользователя, под
 * которым работает панель (0600, root), поэтому читать его нельзя; но всё его содержимое панель получила
 * при запуске. Домен и пароль базы, если их не передали отдельными переменными, видны в адресах панели
 * и базы.
 */
export function installEnv(input: {
  keys: Partial<Record<(typeof SECRET_KEYS)[number], string>>;
  publicUrl: string;
  databaseUrl: string;
  env: Record<string, string | undefined>;
}): InstallEnv {
  const part = (url: string, pick: (u: URL) => string): string => {
    try {
      return pick(new URL(url));
    } catch {
      return '';
    }
  };
  const all: Record<InstallEnvKey, string | undefined> = {
    PANEL_DOMAIN: input.env.PANEL_DOMAIN || part(input.publicUrl, (u) => u.hostname),
    ACME_EMAIL: input.env.ACME_EMAIL,
    NODESERVICE_VERSION: input.env.NODESERVICE_VERSION,
    POSTGRES_PASSWORD:
      input.env.POSTGRES_PASSWORD || part(input.databaseUrl, (u) => decodeURIComponent(u.password)),
    APP_SECRET: input.keys.APP_SECRET,
    ENCRYPTION_KEY: input.keys.ENCRYPTION_KEY,
    // Версия ключа по умолчанию — 1: в старых .env её нет, а пустая строка не дала бы панели запуститься.
    ENCRYPTION_KEY_VERSION: input.keys.ENCRYPTION_KEY_VERSION || '1',
    PASSWORD_PEPPER: input.keys.PASSWORD_PEPPER,
  };
  const out: InstallEnv = {};
  for (const k of INSTALL_ENV_KEYS) if (all[k]) out[k] = all[k];
  return out;
}

/**
 * Текст файла «env» и список обязательных ключей, которых в нём не оказалось. Значения — без кавычек:
 * консоль читает строку как есть (grep '^КЛЮЧ=' | cut -d= -f2-). Значение с переводом строки сломало бы
 * файл — оно не пишется и считается отсутствующим.
 */
export function installEnvText(values: InstallEnv, at: Date): { text: string; missing: InstallEnvKey[] } {
  const usable = (k: InstallEnvKey) => {
    const v = values[k];
    return v && !/[\r\n]/.test(v) ? v : null;
  };
  const lines = [
    `# Ключи установки NodeService: собраны панелью ${at.toISOString()} из её рабочих настроек. Не публиковать.`,
    '# Без ENCRYPTION_KEY зашифрованные секреты (TOTP, доступы к серверам) не восстановить.',
  ];
  for (const k of INSTALL_ENV_KEYS) {
    const v = usable(k);
    if (v) lines.push(`${k}=${v}`);
  }
  return { text: `${lines.join('\n')}\n`, missing: INSTALL_ENV_REQUIRED.filter((k) => !usable(k)) };
}

/**
 * Отпечаток ключа шифрования (sha256, не сам ключ) — в meta архива: по нему видно, от этой ли установки
 * копия, даже если самих ключей в архиве нет. Регистр hex-записи ключа на отпечаток не влияет.
 */
export function keyFingerprint(encryptionKey: string): string {
  return encryptionKey ? createHash('sha256').update(encryptionKey.toLowerCase(), 'utf8').digest('hex') : '';
}

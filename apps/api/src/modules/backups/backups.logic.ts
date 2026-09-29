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

/**
 * Пора ли делать копию: наступил момент по расписанию, после него автокопии ещё не было, и прошло не больше
 * 6 часов (панель перезапускалась в 04:00 — сделает, как поднимется; но не догоняет старое).
 */
export function isBackupDue(
  now: Date,
  s: Pick<BackupSettings, 'auto' | 'frequency' | 'weekday' | 'time'>,
  tz: string,
  lastAutoAt: Date | null,
): boolean {
  if (!s.auto) return false;
  const slot = lastScheduledAt(now, s, tz);
  if (!slot || now.getTime() - slot.getTime() > 6 * 3_600_000) return false;
  return !lastAutoAt || lastAutoAt < slot;
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

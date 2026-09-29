import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

/**
 * Инструменты копии: база данных (pg_dump / pg_restore), упаковка и чтение путей сервера панели.
 * В тестах подменяются (BACKUP_TOOLS) — настоящая база не трогается.
 */
export interface BackupTools {
  /** Можно ли делать копии: в образе есть pg_dump нужной версии. */
  check(): Promise<{ ok: boolean; reason: string | null }>;
  dump(out: string): Promise<void>;
  /** Дамп читается (pg_restore --list). */
  verify(dump: string): Promise<boolean>;
  /**
   * Развернуть дамп вместо текущей базы: во временную базу, потом подмена имён; прежняя база остаётся
   * как nodeservice_pre_restore_<время>. Ошибка на любом шаге — текущая база не тронута.
   */
  restore(dump: string): Promise<void>;
  /** Упаковать пути сервера панели (относительно hostRoot) в tar.gz; нечитаемые и отсутствующие — пропуск. */
  packPaths(paths: string[], hostRoot: string, out: string): Promise<void>;
  /** Что лежит по пути и сколько весит (байты). */
  probePath(
    path: string,
    hostRoot: string,
  ): Promise<{ state: 'file' | 'dir' | 'missing' | 'denied'; size: number | null }>;
}
export const BACKUP_TOOLS = Symbol('BACKUP_TOOLS');

/** Отдельные копии tar и du с правом только читать любые файлы (setcap в образе); иначе — обычные. */
const NS_TAR = existsSync('/usr/local/bin/ns-tar') ? '/usr/local/bin/ns-tar' : 'tar';
const NS_DU = existsSync('/usr/local/bin/ns-du') ? '/usr/local/bin/ns-du' : 'du';

/**
 * Запуск копии с правом чтения; если контейнеру это право не выдано (старый compose без cap_add),
 * ядро не даст её запустить (EPERM) — тогда обычная программа: прочитает то, что открыто.
 */
async function runReader(
  priv: string,
  plain: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    return await run(priv, args, opts);
  } catch (err) {
    if (priv === plain || (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    return run(plain, args, opts);
  }
}

export function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
    });
    p.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 30 * 60_000);
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1) ?? '';

export class PgBackupTools implements BackupTools {
  constructor(private readonly databaseUrl: string) {}

  async check(): Promise<{ ok: boolean; reason: string | null }> {
    try {
      const r = await run('pg_dump', ['--version'], { timeoutMs: 10_000 });
      if (r.code !== 0) return { ok: false, reason: 'pg_dump не запускается в контейнере панели.' };
      return { ok: true, reason: null };
    } catch {
      return {
        ok: false,
        reason:
          'В этой сборке панели нет инструментов базы данных (pg_dump). Обновите панель: nodeservice update.',
      };
    }
  }

  async dump(out: string): Promise<void> {
    const r = await run('pg_dump', ['-Fc', '-d', this.databaseUrl, '-f', out]);
    if (r.code !== 0) throw new Error(`pg_dump: ${lastLine(r.stderr) || `код ${r.code}`}`);
  }

  async verify(dump: string): Promise<boolean> {
    const r = await run('pg_restore', ['--list', dump], { timeoutMs: 5 * 60_000 });
    return r.code === 0 && r.stdout.includes('TABLE');
  }

  async restore(dump: string): Promise<void> {
    const url = new URL(this.databaseUrl);
    const dbName = decodeURIComponent(url.pathname.slice(1)) || 'nodeservice';
    const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const temp = `${dbName}_restore_${ts}`;
    const keep = `${dbName}_pre_restore_${ts}`;
    const admin = new URL(url.toString());
    admin.pathname = '/postgres';
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    const q = (sql: string) => client.query(sql);
    const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
    try {
      await q(`CREATE DATABASE ${ident(temp)}`);
      const target = new URL(url.toString());
      target.pathname = `/${temp}`;
      const r = await run('pg_restore', [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '-d',
        target.toString(),
        dump,
      ]);
      if (r.code !== 0) {
        await q(`DROP DATABASE IF EXISTS ${ident(temp)}`);
        throw new Error(`pg_restore: ${lastLine(r.stderr) || `код ${r.code}`}`);
      }
      // Подмена: все подключения к текущей базе закрываем (и свои тоже — панель сразу перезапустится).
      await q(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName.replaceAll("'", "''")}' AND pid <> pg_backend_pid()`,
      );
      await q(`ALTER DATABASE ${ident(dbName)} RENAME TO ${ident(keep)}`);
      await q(`ALTER DATABASE ${ident(temp)} RENAME TO ${ident(dbName)}`);
      // Держим одну прежнюю базу на случай отката, более старые — удаляем.
      const old = await q(
        `SELECT datname FROM pg_database WHERE datname LIKE '${dbName.replaceAll("'", "''")}\\_pre\\_restore\\_%' AND datname <> '${keep}' ORDER BY datname`,
      );
      for (const row of old.rows as Array<{ datname: string }>)
        await q(`DROP DATABASE IF EXISTS ${ident(row.datname)}`).catch(() => undefined);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async packPaths(paths: string[], hostRoot: string, out: string): Promise<void> {
    const rel = paths.map((p) => p.replace(/^\/+/, '')).filter(Boolean);
    const r = await runReader(NS_TAR, 'tar', [
      '-czf',
      out,
      '--ignore-failed-read',
      '-C',
      hostRoot || '/',
      ...rel,
    ]);
    // 2 — часть файлов не прочиталась (сокеты, пропавшие за время упаковки): архив всё равно годен.
    if (r.code !== 0 && r.code !== 2) throw new Error(`tar: ${lastLine(r.stderr) || `код ${r.code}`}`);
  }

  async probePath(
    path: string,
    hostRoot: string,
  ): Promise<{ state: 'file' | 'dir' | 'missing' | 'denied'; size: number | null }> {
    const full = join(hostRoot || '/', path);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(full);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return { state: 'denied', size: null };
      // Путь может лежать за закрытой папкой (например, /root): спросим у du с правом чтения.
      const r = await runReader(NS_DU, 'du', ['-sk', full], { timeoutMs: 60_000 }).catch(() => null);
      if (r && r.code === 0) return { state: 'dir', size: Number(r.stdout.split(/\s+/)[0]) * 1024 };
      return { state: 'missing', size: null };
    }
    if (st.isFile()) return { state: 'file', size: st.size };
    const r = await runReader(NS_DU, 'du', ['-sk', full], { timeoutMs: 60_000 }).catch(() => null);
    if (r?.code !== 0) return { state: r?.stderr.includes('denied') ? 'denied' : 'dir', size: null };
    return { state: 'dir', size: Number(r.stdout.split(/\s+/)[0]) * 1024 };
  }
}

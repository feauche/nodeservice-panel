import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import pg from 'pg';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { BackupToolError } from './backup-errors.js';

/**
 * Инструменты копии: база данных (pg_dump / pg_restore), упаковка и чтение путей сервера панели.
 * В тестах подменяются (BACKUP_TOOLS) — настоящая база не трогается.
 */
export interface BackupTools {
  /** Можно ли делать копии: в образе есть pg_dump нужной версии. */
  check(): Promise<{ ok: boolean; reason: string | null }>;
  dump(out: string): Promise<void>;
  /** Дамп полностью разворачивается во временную БД; обязательные данные и шифротексты читаются. */
  verify(dump: string): Promise<boolean>;
  /**
   * Развернуть дамп вместо текущей базы: во временную базу, потом подмена имён; прежняя база остаётся
   * как nodeservice_pre_restore_<время>. Ошибка на любом шаге — текущая база не тронута, временная удалена.
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
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  try {
    return await run(priv, args, opts);
  } catch (err) {
    if (priv === plain || (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    return run(plain, args, opts);
  }
}

/** timedOut — программа не уложилась в отведённое время и была остановлена (код при этом — 1). */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
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
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        p.kill('SIGKILL');
      },
      opts.timeoutMs ?? 30 * 60_000,
    );
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/** Конец вывода программы — для лога: причина бывает не в последней строке (у pg_dump за ней идёт подсказка). */
const stderrTail = (s: string) => s.trim().split('\n').filter(Boolean).slice(-8).join('\n').slice(-2000);
/** Что программа сказала о своём сбое; молча — код выхода или то, что её остановили по времени. */
export const failureText = (r: RunResult) =>
  stderrTail(r.stderr) || (r.timedOut ? 'остановлено: не уложилось в отведённое время' : `код ${r.code}`);

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Как часто завершаются сессии прежней базы, пока идёт её переименование. */
const TERMINATE_EVERY_MS = 100;

/** Сбой команды базы: код и текст Postgres — в лог, владельцу — перевод. */
function dbError(step: 'prepare' | 'swap', err: unknown): BackupToolError {
  if (err instanceof BackupToolError) return err;
  const code = (err as { code?: unknown }).code;
  const text = err instanceof Error ? err.message : String(err);
  return new BackupToolError(step, `${typeof code === 'string' ? `${code} ` : ''}${text}`);
}

/** Короткое подключение к служебной базе postgres: открыть, выполнить, закрыть. */
async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  // Недоступную базу ждём не дольше десяти секунд: иначе восстановление повисло бы на минуты.
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  // Обрыв соединения клиент сообщает событием 'error': без слушателя оно уронило бы весь процесс.
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export interface SwapNames {
  /** Рабочая база панели. */
  current: string;
  /** Временная база с развёрнутой копией — станет рабочей. */
  temp: string;
  /** Под этим именем остаётся прежняя база. */
  keep: string;
}

/**
 * Подмена базы. Оба переименования — в одной транзакции: сбой между ними ничего не меняет, панель не
 * остаётся без базы. Новые подключения запрещает сама команда переименования: она держит блокировку базы
 * до конца транзакции (и ждёт до 5 секунд, пока уйдут уже открытые сессии), а открытые сессии в это время
 * раз за разом завершает второй клиент — пул панели переподключается, как только агент пришлёт сигнал.
 * Блокировка снимается сама, даже если панель упадёт посреди подмены: после сбоя чинить нечего.
 */
export async function swapDatabases(adminUrl: string, names: SwapNames): Promise<void> {
  let committing = false;
  try {
    await withAdmin(adminUrl, (main) =>
      withAdmin(adminUrl, async (killer) => {
        const found = await main.query<{ oid: number }>('SELECT oid FROM pg_database WHERE datname = $1', [
          names.current,
        ]);
        const oid = found.rows[0]?.oid;
        if (oid === undefined) throw new Error(`database "${names.current}" does not exist`);
        let renaming = true;
        // По номеру базы, а не по имени: после подмены это имя носит уже новая база.
        const terminating = (async () => {
          while (renaming) {
            await killer
              .query(
                'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datid = $1 AND pid <> pg_backend_pid()',
                [oid],
              )
              .catch(() => undefined);
            await sleep(TERMINATE_EVERY_MS);
          }
        })();
        try {
          await main.query('BEGIN');
          await main.query(`ALTER DATABASE ${ident(names.current)} RENAME TO ${ident(names.keep)}`);
          await main.query(`ALTER DATABASE ${ident(names.temp)} RENAME TO ${ident(names.current)}`);
          committing = true;
          await main.query('COMMIT');
        } catch (err) {
          if (!committing) await main.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          renaming = false;
          await terminating;
        }
      }),
    );
  } catch (err) {
    const failure = dbError('swap', err);
    if (!committing) throw failure;
    // Связь оборвалась на самом подтверждении: подмена могла состояться. Смотрим, что в базе на самом деле.
    const swapped = await withAdmin(adminUrl, async (c) => {
      const r = await c.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [[names.temp, names.keep]],
      );
      const have = new Set(r.rows.map((x) => x.datname));
      return have.has(names.keep) && !have.has(names.temp);
    }).catch(() => null);
    if (swapped === true) return;
    failure.outcomeUnknown = swapped === null;
    throw failure;
  }
}

/** du с правом читать любой файл; null — программа не запустилась. В тестах подменяется. */
export type DiskUsage = (args: string[]) => Promise<RunResult | null>;
const readerDu: DiskUsage = (args) =>
  // Сообщения — на английском при любой локали сервера: по ним отличаем «нет такого пути» от «нет доступа».
  runReader(NS_DU, 'du', args, { timeoutMs: 60_000, env: { LC_ALL: 'C' } }).catch(() => null);
const kilobytes = (stdout: string) => Number(stdout.split(/\s+/)[0]) * 1024;

/** Аргументы упаковки: пути — только после «--», иначе путь вида «/--параметр» стал бы параметром tar. */
export function packArgs(paths: string[], hostRoot: string, out: string): string[] {
  const rel = paths.map((p) => p.replace(/^\/+/, '')).filter(Boolean);
  return ['-czf', out, '--ignore-failed-read', '-C', hostRoot || '/', '--', ...rel];
}

export class PgBackupTools implements BackupTools {
  private readonly log = new Logger('BackupTools');

  constructor(
    private readonly databaseUrl: string,
    private readonly du: DiskUsage = readerDu,
    private readonly crypto?: CryptoService,
  ) {}

  async check(): Promise<{ ok: boolean; reason: string | null }> {
    try {
      const r = await run('pg_dump', ['--version'], { timeoutMs: 10_000 });
      if (r.code !== 0)
        return {
          ok: false,
          reason:
            'Инструмент для копии базы данных в панели не запускается. Попробуйте обновить панель с сервера.',
        };
      return { ok: true, reason: null };
    } catch {
      return {
        ok: false,
        reason: 'В этой сборке панели нет инструментов для копии базы данных. Обновите панель с сервера.',
      };
    }
  }

  async dump(out: string): Promise<void> {
    const r = await run('pg_dump', ['-Fc', '-d', this.databaseUrl, '-f', out]);
    if (r.code !== 0) throw new BackupToolError('dump', failureText(r));
  }

  async verify(dump: string): Promise<boolean> {
    const url = new URL(this.databaseUrl);
    const dbName = decodeURIComponent(url.pathname.slice(1)) || 'nodeservice';
    const suffix = `${Date.now()}_${process.pid}`;
    // PostgreSQL принимает имя до 63 байт; конец уникален и должен сохраниться.
    const temp = `${dbName.slice(0, Math.max(1, 62 - suffix.length - 8))}_verify_${suffix}`;
    const admin = new URL(url.toString());
    admin.pathname = '/postgres';
    const adminUrl = admin.toString();
    const target = new URL(url.toString());
    target.pathname = `/${temp}`;
    const drop = () =>
      withAdmin(adminUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${ident(temp)} WITH (FORCE)`));
    try {
      await drop().catch(() => undefined);
      await withAdmin(adminUrl, (client) => client.query(`CREATE DATABASE ${ident(temp)}`));
      const restored = await run(
        'pg_restore',
        ['--no-owner', '--no-privileges', '--exit-on-error', '-d', target.toString(), dump],
        { timeoutMs: 30 * 60_000 },
      );
      if (restored.code !== 0) {
        this.log.warn(`Пробное восстановление копии не удалось: ${failureText(restored)}`);
        return false;
      }
      const valid = await withAdmin(target.toString(), async (client) => {
        const required = await client.query<{
          users: string | null;
          servers: string | null;
          meta: string | null;
        }>(
          `select to_regclass('public.users')::text as users,
                  to_regclass('public.servers')::text as servers,
                  to_regclass('public.app_meta')::text as meta`,
        );
        const tables = required.rows[0];
        if (!tables?.users || !tables.servers || !tables.meta) return false;
        // Запись администратора должна быть пригодна для входа: логин есть, хеш имеет формат argon2.
        const users = await client.query<{ login: string; password_hash: string }>(
          'select login, password_hash from users order by created_at limit 2',
        );
        if (users.rows.length === 0) return false;
        if (users.rows.some((user) => !user.login || !user.password_hash.startsWith('$argon2'))) return false;
        // Копия без подходящего ENCRYPTION_KEY бесполезна: SSH-ключи и ключи агентов не прочитаются.
        if (this.crypto) {
          const secrets = await client.query<{ ssh: string | null; agent: string | null }>(
            `select ssh_private_key_enc as ssh, agent_access_key_enc as agent
             from servers
             where ssh_private_key_enc is not null or agent_access_key_enc is not null`,
          );
          for (const secret of secrets.rows) {
            if (secret.ssh) this.crypto.decrypt(secret.ssh);
            if (secret.agent) this.crypto.decrypt(secret.agent);
          }
        }
        return true;
      });
      return valid;
    } catch (err) {
      this.log.warn(
        `Пробная проверка восстановления не завершилась: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    } finally {
      await drop().catch((err: unknown) =>
        this.log.warn(
          `Временная база проверки ${temp} не удалилась: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
  }

  async restore(dump: string): Promise<void> {
    const url = new URL(this.databaseUrl);
    const dbName = decodeURIComponent(url.pathname.slice(1)) || 'nodeservice';
    const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const temp = `${dbName}_restore_${ts}`;
    const keep = `${dbName}_pre_restore_${ts}`;
    const admin = new URL(url.toString());
    admin.pathname = '/postgres';
    const adminUrl = admin.toString();
    // Подключение — на каждый шаг своё: pg_restore идёт минутами, простаивающее могло бы оборваться.
    const drop = (name: string, force: boolean) =>
      withAdmin(adminUrl, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${ident(name)}${force ? ' WITH (FORCE)' : ''}`),
      );
    /** Базы, чьё имя начинается так же: временные (<база>_restore_…) и прежние (<база>_pre_restore_…). */
    const named = (prefix: string) =>
      withAdmin(adminUrl, async (c) =>
        (await c.query<{ datname: string }>('SELECT datname FROM pg_database ORDER BY datname')).rows
          .map((r) => r.datname)
          .filter((n) => n.startsWith(prefix)),
      );
    try {
      // Временные базы прошлых попыток, оставшиеся после сбоя: каждая — полная копия базы на диске.
      // Только со своим именем: <база>_restore_<14 цифр времени> — чужую базу с похожим началом не трогаем.
      const prefix = `${dbName}_restore_`;
      for (const name of await named(prefix))
        if (/^\d{14}$/.test(name.slice(prefix.length))) await drop(name, true).catch(() => undefined);
      await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE ${ident(temp)}`));
    } catch (err) {
      throw dbError('prepare', err);
    }
    try {
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
      if (r.code !== 0) throw new BackupToolError('restore', failureText(r));
      await swapDatabases(adminUrl, { current: dbName, temp, keep });
    } catch (err) {
      // Что бы ни сорвалось, временная база не остаётся. Если подмена всё же состоялась, базы с таким
      // именем уже нет — команда ничего не удалит.
      await drop(temp, true).catch((e: unknown) =>
        this.log.warn(`Временная база ${temp} не удалилась: ${e instanceof Error ? e.message : e}`),
      );
      throw err;
    }
    // Держим одну прежнюю базу на случай отката, более старые — удаляем (и оставленные консольным
    // восстановлением: у них то же начало имени).
    const old = await named(`${dbName}_pre_restore_`).catch(() => [] as string[]);
    for (const name of old) if (name !== keep) await drop(name, false).catch(() => undefined);
  }

  async packPaths(paths: string[], hostRoot: string, out: string): Promise<void> {
    const r = await runReader(NS_TAR, 'tar', packArgs(paths, hostRoot, out));
    // 2 — часть файлов не прочиталась (сокеты, пропавшие за время упаковки): архив всё равно годен.
    if (r.code !== 0 && r.code !== 2) throw new BackupToolError('files', failureText(r));
  }

  async probePath(
    path: string,
    hostRoot: string,
  ): Promise<{ state: 'file' | 'dir' | 'missing' | 'denied'; size: number | null }> {
    const full = join(hostRoot || '/', path);
    const st = await stat(full).catch((err: NodeJS.ErrnoException) => err);
    if (!(st instanceof Error)) {
      if (st.isFile()) return { state: 'file', size: st.size };
      const r = await this.du(['-sk', '--', full]);
      if (r?.code !== 0) return { state: r?.stderr.includes('denied') ? 'denied' : 'dir', size: null };
      return { state: 'dir', size: kilobytes(r.stdout) };
    }
    if (st.code !== 'EACCES' && st.code !== 'EPERM') return { state: 'missing', size: null };
    // Пользователю панели путь закрыт (лежит за папкой вроде /root). Но упаковывает его программа с правом
    // читать любой файл — спрашиваем такую же: видит она — значит, путь попадёт в копию. Сначала как папку
    // («путь/.»): так большая папка обходится один раз, а файл отсеивается сразу.
    const dir = await this.du(['-sk', '--', `${full}/.`]);
    if (dir?.code === 0) return { state: 'dir', size: kilobytes(dir.stdout) };
    // Не успела посчитать за минуту — папка есть и читается, просто большая: размера не знаем.
    if (dir?.timedOut) return { state: 'dir', size: null };
    if (dir && /not a directory/i.test(dir.stderr)) {
      // Размер файла — в байтах, как у открытого файла (а не занятое место, кратное 4 КБ).
      const file = await this.du(['-sb', '--', full]);
      if (file?.code === 0) return { state: 'file', size: Number(file.stdout.split(/\s+/)[0]) };
    }
    // «Нет доступа» — только когда и она не смогла: тогда путь не попадёт и в копию.
    return { state: dir && /no such file/i.test(dir.stderr) ? 'missing' : 'denied', size: null };
  }
}

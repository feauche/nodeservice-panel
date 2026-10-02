import { constants, createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BACKUP_KIND_LABELS,
  BACKUP_NAME_RE,
  BACKUP_PROBLEM,
  type BackupInspect,
  type BackupItem,
  type BackupKind,
  type BackupPathCheck,
  type BackupRun,
  type BackupSettings,
  type BackupSettingsUpdate,
  type BackupStage,
  type BackupsResponse,
  parseTelegramUrl,
  SHARED_VERSION,
  TELEGRAM_FILE_LIMIT_BYTES,
} from '@nodeservice/shared';
import { ClsService } from 'nestjs-cls';

import { problem } from '../../common/filters/problem-details.filter.js';
import { zoneLabel } from '../../common/local-time.js';
import { DEFAULT_TIME_ZONE, panelTimeZone } from '../../common/panel-time-zone.js';
import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { CLS_USER } from '../auth/cls-keys.js';
import { PanelLifecycleService } from '../health/panel-lifecycle.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { esc } from '../notifications/telegram/telegram.format.js';
import { backupBlocks } from '../notifications/telegram/telegram.rich.js';
import { TelegramService } from '../notifications/telegram/telegram.service.js';
import { decryptFile, encryptFile, isEncrypted } from './backup-crypto.js';
import { BackupError, BackupToolError, explainBackupError, rawErrorText } from './backup-errors.js';
import { BackupSettingsStore, type StoredBackupSettings } from './backup-settings.store.js';
import { BACKUP_TOOLS, type BackupTools, failureText, run } from './backup-tools.js';
import {
  backupName,
  envValues,
  type InstallEnv,
  type InstallEnvKey,
  installEnv,
  installEnvText,
  isBackupDue,
  keyFingerprint,
  lastScheduledAt,
  nextBackupAt,
  parseMeta,
  SECRET_KEYS,
  timeFromName,
  versionLess,
  willRetryBackup,
} from './backups.logic.js';

/** Описание копии рядом с архивом: <имя>.json. */
interface Sidecar {
  createdAt: string;
  kind: BackupKind;
  verified: boolean | null;
  telegram: { ok: boolean; note: string | null } | null;
  offsite: { ok: boolean; location: string; note: string | null } | null;
  contents: BackupItem['contents'];
  version: string | null;
}

const mb = (b: number) => `${(b / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;

/** Копия по расписанию: к какому моменту расписания относится попытка и когда она началась. */
interface Scheduled {
  slot: Date;
  at: Date;
}

/** Обязательные ключи установки — как их назвать владельцу, если какого-то не оказалось. */
const INSTALL_KEY_NAMES: Partial<Record<InstallEnvKey, string>> = {
  POSTGRES_PASSWORD: 'пароль базы данных',
  APP_SECRET: 'секрет панели',
  ENCRYPTION_KEY: 'ключ шифрования',
};

/** Дополнительные пути для Журнала: сами пути (они не секретны), а не их число. */
const extraText = (e: BackupSettings['extra']) =>
  `${e.enabled ? '' : 'выключено: '}${e.paths.join(', ') || 'путей нет'}`;

/**
 * Резервные копии панели (0.39.0). Архив совместим с консольными `nodeservice backup` / `restore`.
 * Одна операция за раз: копия или восстановление. Восстановление разворачивает дамп во временную базу и
 * подменяет имена — при сбое текущая база не тронута; после успеха панель перезапускается сама.
 */
@Injectable()
export class BackupsService implements OnModuleInit {
  private readonly log = new Logger(BackupsService.name);
  private readonly dir: string;
  private readonly hostRoot: string;
  private readonly vmUrl: string;
  /** Ключи этой установки — чтобы понять, от неё ли копия (из настроек, а не из окружения процесса). */
  private readonly keys: Record<string, string>;
  /**
   * Строки файла «env» архива — ключи, домен, пароль базы. Из настроек самой панели: файл .env установки
   * на сервере закрыт от пользователя, под которым она работает, и раньше копия молча выходила без ключей.
   */
  private readonly installEnv: InstallEnv;
  /** Отпечаток ключа шифрования: в meta архива и для сверки при проверке копии. */
  private readonly keyPrint: string;
  private runState: BackupRun = { stage: null, startedAt: null, mode: null, lastError: null };
  private toolsState: { ok: boolean; reason: string | null } = { ok: false, reason: 'Проверяю инструменты…' };

  constructor(
    config: ConfigService<Env, true>,
    @Inject(DB) private readonly db: Db,
    @Inject(BACKUP_TOOLS) private readonly tools: BackupTools,
    private readonly store: BackupSettingsStore,
    private readonly telegram: TelegramService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly lifecycle: PanelLifecycleService,
  ) {
    this.dir = resolve(config.get('BACKUPS_DIR'));
    this.hostRoot = config.get('HOST_ROOT');
    this.vmUrl = config.get('VM_URL');
    this.keys = Object.fromEntries(SECRET_KEYS.map((k) => [k, String(config.get(k) ?? '')]));
    this.installEnv = installEnv({
      keys: this.keys,
      publicUrl: config.get('PUBLIC_URL'),
      databaseUrl: config.get('DATABASE_URL'),
      // Домен, почта для сертификата и пароль базы — не настройки панели: они приходят из .env установки.
      env: process.env,
    });
    this.keyPrint = keyFingerprint(this.keys.ENCRYPTION_KEY ?? '');
  }

  async onModuleInit(): Promise<void> {
    await this.refreshState();
  }

  /** Можно ли делать копии: есть pg_dump и папка копий открыта на запись. */
  private async refreshState(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const tools = await this.tools
      .check()
      .catch(() => ({ ok: false, reason: 'Инструменты базы данных недоступны.' }));
    if (!tools.ok) {
      this.toolsState = tools;
      return;
    }
    const writable = await access(this.dir, constants.W_OK).then(
      () => true,
      () => false,
    );
    this.toolsState = writable
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason:
            'Панели не хватает прав на папку копий на сервере. Обновите панель с сервера — обновление выдаёт права заново.',
        };
  }

  private actor(): string | null {
    const u = this.cls.isActive() ? this.cls.get<{ login: string } | undefined>(CLS_USER) : undefined;
    return u?.login ?? null;
  }

  private async timeZone(): Promise<string> {
    return (
      (await panelTimeZone(this.db)) ?? (await this.notifications.timeZone().catch(() => DEFAULT_TIME_ZONE))
    );
  }

  private file(name: string): string {
    if (!BACKUP_NAME_RE.test(name))
      throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
    return join(this.dir, name);
  }

  private busy(): void {
    if (this.runState.stage)
      throw problem(HttpStatus.CONFLICT, {
        type: BACKUP_PROBLEM.busy,
        detail:
          this.runState.mode === 'restore'
            ? 'Идёт восстановление — дождитесь перезапуска панели.'
            : 'Копия уже делается — дождитесь окончания.',
      });
  }

  private stage(s: BackupStage | null): void {
    this.runState = { ...this.runState, stage: s };
  }

  /* ─────────── список и настройки ─────────── */

  private async readSidecar(name: string): Promise<Sidecar | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${name}.json`), 'utf8')) as Sidecar;
    } catch {
      return null;
    }
  }

  async items(): Promise<BackupItem[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => BACKUP_NAME_RE.test(n));
    const out: BackupItem[] = [];
    for (const name of names) {
      const st = await stat(join(this.dir, name)).catch(() => null);
      if (!st) continue;
      const sc = await this.readSidecar(name);
      out.push({
        name,
        createdAt: sc?.createdAt ?? (timeFromName(name) ?? st.mtime).toISOString(),
        size: st.size,
        kind: sc?.kind ?? 'console',
        encrypted: name.endsWith('.enc'),
        verified: sc?.verified ?? null,
        telegram: sc?.telegram ?? null,
        offsite: sc?.offsite ?? null,
        contents: sc?.contents ?? null,
        version: sc?.version ?? null,
      });
    }
    return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async list(): Promise<BackupsResponse> {
    // Права на папку могли выдать, пока панель работала, — проверяем заново, пока копии недоступны.
    if (!this.toolsState.ok) await this.refreshState();
    const items = await this.items();
    const s = await this.store.load();
    const tz = await this.timeZone();
    const fs = await statfs(this.dir).catch(() => null);
    return {
      items,
      run: this.runState,
      nextAt: s.auto ? (nextBackupAt(new Date(), s, tz)?.toISOString() ?? null) : null,
      timeZone: tz,
      totalSize: items.reduce((a, i) => a + i.size, 0),
      freeBytes: fs ? Number(fs.bavail) * Number(fs.bsize) : null,
      available: this.toolsState.ok,
      unavailableReason: this.toolsState.reason,
    };
  }

  async getSettings(): Promise<BackupSettings> {
    return this.store.toPublic(await this.store.load());
  }

  async updateSettings(patch: BackupSettingsUpdate): Promise<BackupSettings> {
    const cur = await this.store.load();
    const next: StoredBackupSettings = {
      ...cur,
      ...(patch.auto !== undefined ? { auto: patch.auto } : {}),
      ...(patch.frequency ? { frequency: patch.frequency } : {}),
      ...(patch.weekday ? { weekday: patch.weekday } : {}),
      ...(patch.time ? { time: patch.time } : {}),
      ...(patch.keep ? { keep: patch.keep } : {}),
      ...(patch.beforeUpdate !== undefined ? { beforeUpdate: patch.beforeUpdate } : {}),
      ...(patch.includeMetrics !== undefined ? { includeMetrics: patch.includeMetrics } : {}),
      ...(patch.extra
        ? { extra: { enabled: patch.extra.enabled, paths: [...new Set(patch.extra.paths)] } }
        : {}),
    };
    if (patch.telegram) {
      const t = patch.telegram;
      let ownUrlEnc = cur.telegram.ownUrlEnc;
      if (t.ownUrl === null || t.ownUrl === '') ownUrlEnc = null;
      // Не передан или вернулась маска, которую отдал сам сервер, — чат не меняли. Любая другая строка —
      // новый чат: маска с другим номером тоже не подойдёт, токена в ней нет.
      else if (t.ownUrl !== undefined && t.ownUrl !== this.store.toPublic(cur).telegram.ownUrl) {
        if (!parseTelegramUrl(t.ownUrl))
          throw problem(HttpStatus.BAD_REQUEST, {
            detail: 'Свой чат — строкой вида tgram://токен_бота/id_чата (для темы — :номер_темы в конце).',
          });
        ownUrlEnc = this.store.encrypt(t.ownUrl);
      }
      next.telegram = {
        enabled: t.enabled,
        target: t.target,
        destinationId: t.destinationId,
        notifyFailure: t.notifyFailure,
        ownUrlEnc,
      };
    }
    if (patch.offsite) {
      const o = patch.offsite;
      let accessKeyIdEnc = cur.offsite.accessKeyIdEnc;
      let secretAccessKeyEnc = cur.offsite.secretAccessKeyEnc;
      if (o.accessKeyId === null || o.accessKeyId === '') accessKeyIdEnc = null;
      else if (o.accessKeyId !== undefined) accessKeyIdEnc = this.store.encrypt(o.accessKeyId);
      if (o.secretAccessKey === null || o.secretAccessKey === '') secretAccessKeyEnc = null;
      else if (o.secretAccessKey !== undefined) secretAccessKeyEnc = this.store.encrypt(o.secretAccessKey);
      next.offsite = {
        enabled: o.enabled,
        endpoint: o.endpoint.replace(/\/+$/, ''),
        region: o.region,
        bucket: o.bucket,
        prefix: o.prefix.replace(/^\/+|\/+$/g, ''),
        accessKeyIdEnc,
        secretAccessKeyEnc,
      };
    }
    if (patch.password !== undefined)
      next.passwordEnc = patch.password ? this.store.encrypt(patch.password) : null;
    if (next.offsite.enabled) {
      if (!next.offsite.bucket || !next.offsite.region)
        throw problem(HttpStatus.BAD_REQUEST, { detail: 'Для внешнего хранилища укажите регион и bucket.' });
      if (!next.offsite.accessKeyIdEnc || !next.offsite.secretAccessKeyEnc)
        throw problem(HttpStatus.BAD_REQUEST, {
          detail: 'Для внешнего хранилища укажите оба ключа доступа.',
        });
      if (!next.passwordEnc)
        throw problem(HttpStatus.BAD_REQUEST, {
          detail: 'Внешняя копия должна быть зашифрована: сначала задайте пароль резервных копий.',
        });
    }
    await this.store.save(next);
    await this.syncBeforeUpdateMarker(next.beforeUpdate);
    const before = this.store.toPublic(cur);
    const after = this.store.toPublic(next);
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of [
      'auto',
      'frequency',
      'weekday',
      'time',
      'keep',
      'beforeUpdate',
      'includeMetrics',
      'passwordSet',
    ] as const)
      if (before[k] !== after[k]) changes[k] = { before: before[k], after: after[k] };
    if (JSON.stringify(before.telegram) !== JSON.stringify(after.telegram))
      changes.telegram = { before: before.telegram.enabled, after: after.telegram.enabled };
    if (JSON.stringify(before.extra) !== JSON.stringify(after.extra))
      changes.extra = { before: extraText(before.extra), after: extraText(after.extra) };
    if (JSON.stringify(before.offsite) !== JSON.stringify(after.offsite))
      changes.offsite = { before: before.offsite.enabled, after: after.offsite.enabled };
    this.audit.extend({ ...(Object.keys(changes).length ? { changes } : {}) });
    return after;
  }

  /** `nodeservice update` смотрит на этот файл: есть — копию перед обновлением не делает. */
  private async syncBeforeUpdateMarker(on: boolean): Promise<void> {
    const marker = join(this.dir, '.skip-before-update');
    if (on) await rm(marker, { force: true }).catch(() => undefined);
    else await writeFile(marker, 'выключено в «Настройки → Резервные копии»\n').catch(() => undefined);
  }

  async checkPaths(paths: string[]): Promise<BackupPathCheck> {
    const items: BackupPathCheck['items'] = [];
    for (const p of paths) items.push({ path: p, ...(await this.tools.probePath(p, this.hostRoot)) });
    return { items };
  }

  /* ─────────── создание копии ─────────── */

  /** Запустить копию в фоне; ответ — сразу (ход виден в списке). */
  start(kind: BackupKind, opts: { sendTelegram?: boolean; scheduled?: Scheduled } = {}): void {
    if (!this.toolsState.ok)
      throw problem(HttpStatus.SERVICE_UNAVAILABLE, {
        type: BACKUP_PROBLEM.unavailable,
        detail: this.toolsState.reason ?? 'Копии сейчас недоступны.',
      });
    this.busy();
    this.runState = { stage: 'db', startedAt: new Date().toISOString(), mode: 'backup', lastError: null };
    const actor = this.actor();
    void this.create(kind, opts, actor)
      .catch((err) => this.fail(kind, err, actor, opts.scheduled ?? null))
      .finally(() => {
        this.runState = { ...this.runState, stage: null, mode: null, startedAt: null };
      });
  }

  /**
   * Копия с ожиданием конца — для обновления панели: настройки те же, что у копии по расписанию (пароль,
   * метрики, папки, Telegram); ход виден на странице, сбой — как у обычной копии (колокольчик, Telegram).
   */
  async runAndWait(kind: BackupKind, actor: string): Promise<BackupItem> {
    if (!this.toolsState.ok)
      throw problem(HttpStatus.SERVICE_UNAVAILABLE, {
        type: BACKUP_PROBLEM.unavailable,
        detail: this.toolsState.reason ?? 'Копии сейчас недоступны.',
      });
    this.busy();
    this.runState = { stage: 'db', startedAt: new Date().toISOString(), mode: 'backup', lastError: null };
    try {
      return await this.create(kind, {}, actor);
    } catch (err) {
      await this.fail(kind, err, actor);
      throw err;
    } finally {
      this.runState = { ...this.runState, stage: null, mode: null, startedAt: null };
    }
  }

  /**
   * Сделать копию и дождаться (для «перед восстановлением» и тестов). protect — имя копии, которую чистка
   * старых не трогает: из неё сейчас восстанавливают.
   */
  async create(
    kind: BackupKind,
    opts: { sendTelegram?: boolean; protect?: string } = {},
    actor: string | null = null,
  ): Promise<BackupItem> {
    const s = await this.store.load();
    const password = this.store.password(s);
    if (s.offsite.enabled && !password)
      throw new BackupError('Внешнее хранилище включено, но пароль шифрования копий недоступен.');
    const now = new Date();
    // Без ключей копия бесполезна на новом сервере: консольное восстановление её не примет, а из панели
    // после неё не войти. Такая копия — не удача: честная ошибка вместо тихого успеха. Ключи известны
    // заранее (это настройки самой панели), поэтому базу ради обречённой копии не выгружаем.
    const env = installEnvText(this.installEnv, now);
    if (env.missing.length > 0)
      throw new BackupError(
        `В копию не попали ключи установки (${env.missing.map((k) => INSTALL_KEY_NAMES[k] ?? k).join(', ')}), поэтому она не сохранена: без них панель не восстановить на новом сервере. Пока это не исправлено, делайте копии из консоли сервера панели — там ключи берутся прямо из файла настроек установки.`,
        `в настройках панели нет ${env.missing.join(', ')}`,
      );
    const work = await mkdtemp(join(tmpdir(), 'ns-backup-'));
    const plainName = backupName(now, false);
    const name = backupName(now, Boolean(password));
    const target = join(this.dir, name);
    try {
      this.stage('db');
      await this.tools.dump(join(work, 'db.dump'));
      const files = ['meta', 'db.dump'];
      this.stage('env');
      await writeFile(join(work, 'env'), env.text, { mode: 0o600 });
      files.push('env');
      let hasMetrics = false;
      if (s.includeMetrics) {
        this.stage('metrics');
        hasMetrics = await this.exportMetrics(join(work, 'metrics.native'));
        if (hasMetrics) files.push('metrics.native');
      }
      let pathsCount = 0;
      if (s.extra.enabled && s.extra.paths.length > 0) {
        this.stage('files');
        await this.tools.packPaths(s.extra.paths, this.hostRoot, join(work, 'files.tar.gz'));
        files.push('files.tar.gz');
        pathsCount = s.extra.paths.length;
      }
      await writeFile(
        join(work, 'meta'),
        [
          'format=2',
          `created=${now.toISOString()}`,
          `domain=${this.installEnv.PANEL_DOMAIN ?? '?'}`,
          `panel=${SHARED_VERSION}`,
          `kind=${kind}`,
          `metrics=${hasMetrics ? 1 : 0}`,
          `paths=${pathsCount}`,
          `encrypted=${password ? 1 : 0}`,
          // Отпечаток ключа шифрования, не сам ключ: по нему проверка видит, от этой ли установки копия.
          `keys_sha256=${this.keyPrint}`,
          // Пустая строка в конце: консоль печатает meta как есть, и следующий её вопрос не прилипает.
          '',
        ].join('\n'),
      );
      this.stage('pack');
      const packed = join(work, plainName);
      const tar = await run('tar', ['-czf', packed, '-C', work, ...files]);
      if (tar.code !== 0) throw new BackupToolError('pack', failureText(tar));
      this.stage('verify');
      const verified = await this.tools.verify(join(work, 'db.dump'));
      if (!verified) throw new BackupError('Дамп базы не читается — копия не сохранена.');
      if (password) {
        this.stage('encrypt');
        await encryptFile(packed, `${target}.part`, password);
      } else await copyFile(packed, `${target}.part`);
      // В архиве ключи установки: без пароля — в открытом виде. Читать его может только пользователь
      // панели, как и консольную копию. Диск, где права не меняются, — не повод остаться без копии.
      await chmod(`${target}.part`, 0o600).catch(() => undefined);
      await rename(`${target}.part`, target);
      const size = (await stat(target)).size;
      const contents = { db: true, env: true, metrics: hasMetrics, paths: pathsCount };
      let offsite: Sidecar['offsite'] = null;
      if (s.offsite.enabled) {
        this.stage('offsite');
        offsite = await this.uploadOffsite(s, target, name, size);
      }
      const side: Sidecar = {
        createdAt: now.toISOString(),
        kind,
        verified,
        telegram: null,
        offsite,
        contents,
        version: SHARED_VERSION,
      };
      await writeFile(`${target}.json`, JSON.stringify(side), { mode: 0o600 });
      if (kind !== 'pre_restore' && (opts.sendTelegram ?? s.telegram.enabled)) {
        this.stage('telegram');
        side.telegram = await this.sendToTelegram(s, target, name, size, now, contents, Boolean(password));
        await writeFile(`${target}.json`, JSON.stringify(side), { mode: 0o600 });
      }
      this.stage('cleanup');
      await this.retain(s.keep, opts.protect ?? null);
      await this.audit.record({
        action: 'backup.created',
        ...(actor ? { actor: { type: 'admin', id: null, display: actor } } : { actor: SYSTEM_ACTOR }),
        target: { type: 'backup', id: name, display: name },
        metadata: {
          kind: BACKUP_KIND_LABELS[kind],
          size: mb(size),
          encrypted: Boolean(password),
          metrics: hasMetrics,
          paths: pathsCount,
          offsite: offsite?.ok ? offsite.location : (offsite?.note ?? 'выключено'),
        },
      });
      this.log.log(`Копия ${name} (${mb(size)}) готова`);
      return {
        name,
        createdAt: side.createdAt,
        size,
        kind,
        encrypted: Boolean(password),
        verified,
        telegram: side.telegram,
        offsite: side.offsite,
        contents,
        version: SHARED_VERSION,
      };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      await rm(`${target}.part`, { force: true }).catch(() => undefined);
    }
  }

  /** Зашифрованная вторая копия: загружаем и сразу подтверждаем размер отдельным запросом. */
  private async uploadOffsite(
    s: StoredBackupSettings,
    path: string,
    name: string,
    size: number,
  ): Promise<NonNullable<Sidecar['offsite']>> {
    const key = [s.offsite.prefix, name].filter(Boolean).join('/');
    const location = `s3://${s.offsite.bucket}/${key}`;
    const credentials = this.store.offsiteCredentials(s);
    if (!credentials) return { ok: false, location, note: 'ключи доступа не читаются' };
    const client = new S3Client({
      region: s.offsite.region,
      credentials,
      ...(s.offsite.endpoint ? { endpoint: s.offsite.endpoint, forcePathStyle: true } : {}),
    });
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: s.offsite.bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: 'application/octet-stream',
          Metadata: { nodeservice: SHARED_VERSION, encrypted: 'true' },
        }),
      );
      const head = await client.send(new HeadObjectCommand({ Bucket: s.offsite.bucket, Key: key }));
      if (head.ContentLength !== size)
        throw new Error(`после загрузки размер ${head.ContentLength ?? '?'} вместо ${size}`);
      return { ok: true, location, note: null };
    } catch (err) {
      const note = err instanceof Error ? err.message.slice(0, 300) : 'хранилище не ответило';
      await this.notifications.push({
        severity: 'crit',
        title: 'Копия не сохранена во внешнем хранилище',
        body: `Локальная зашифрованная копия готова, но ${location} не подтверждена. Причина: ${note}`,
        link: { to: '/settings/backups', label: 'Открыть копии' },
        telegram: { event: 'panel_health' },
      });
      return { ok: false, location, note };
    } finally {
      client.destroy();
    }
  }

  private async fail(
    kind: BackupKind,
    err: unknown,
    actor: string | null,
    scheduled: Scheduled | null = null,
  ): Promise<void> {
    const reason = explainBackupError(err);
    this.runState = { ...this.runState, lastError: reason };
    // Что написала программа или система — только в лог: владельцу этот текст ничего не скажет.
    this.log.warn(`Копия не получилась: ${rawErrorText(err)}`);
    await this.audit.record({
      action: 'backup.failed',
      result: 'failed',
      severity: 'warn',
      ...(actor ? { actor: { type: 'admin', id: null, display: actor } } : { actor: SYSTEM_ACTOR }),
      metadata: { kind: BACKUP_KIND_LABELS[kind], error: reason.slice(0, 300) },
    });
    // Копия по расписанию повторяется раз в час — о сбое сообщаем один раз на момент расписания,
    // а не после каждой попытки. Не удалось узнать, сообщали ли, — лучше сообщить.
    if (scheduled && !(await this.firstNotice(scheduled.slot).catch(() => true))) return;
    const retry = scheduled !== null && willRetryBackup(scheduled.at, scheduled.slot);
    await this.notifications.push({
      severity: 'crit',
      title: 'Резервная копия не получилась',
      body: `${reason.slice(0, 500)}${
        retry ? ' Панель попробует ещё раз через час; о повторных неудачах этой копии сообщать не будет.' : ''
      }`,
      link: { to: '/settings/backups', label: 'Открыть копии' },
    });
    const s = await this.store.load();
    if (s.telegram.enabled && s.telegram.notifyFailure) {
      const d = await this.targetOf(s);
      if (d)
        await this.telegram.sendTo(
          d,
          `🔴 <b>Резервная копия не получилась</b>\n${esc(reason.slice(0, 500))}\n\n<i>${
            retry
              ? 'Панель попробует ещё раз через час. О повторных неудачах этой копии сообщать не будет — загляните в «Настройки → Резервные копии».'
              : 'Следующая — по расписанию. Сделать вручную: «Настройки → Резервные копии».'
          }</i>`,
        );
    }
  }

  /** Первое ли это сообщение о сбое для момента расписания (отметка — в базе: переживает перезапуск). */
  private async firstNotice(slot: Date): Promise<boolean> {
    const state = await this.store.schedule();
    if (state.noticeSlot === slot.toISOString()) return false;
    await this.store.saveSchedule({ ...state, noticeSlot: slot.toISOString() });
    return true;
  }

  private async targetOf(s: StoredBackupSettings) {
    if (s.telegram.target === 'own') {
      const url = this.store.ownUrl(s);
      return url ? this.telegram.resolveTarget({ url }) : null;
    }
    return this.telegram.resolveTarget({ destinationId: s.telegram.destinationId });
  }

  private async sendToTelegram(
    s: StoredBackupSettings,
    path: string,
    name: string,
    size: number,
    at: Date,
    contents: NonNullable<BackupItem['contents']>,
    encrypted: boolean,
  ): Promise<{ ok: boolean; note: string | null }> {
    const d = await this.targetOf(s);
    if (!d) return { ok: false, note: 'чат для копий не выбран' };
    const tz = await this.timeZone();
    const when = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(at)
      .replace(' в ', ', ');
    const parts = [
      'база',
      contents.env ? 'ключи' : null,
      contents.metrics ? 'метрики' : null,
      contents.paths ? `файлов: ${contents.paths}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const zone = zoneLabel(at, tz);
    const sizeText = mb(size);
    const caption = `🗄 <b>Резервная копия NodeService</b>\n${esc(when)} (${esc(zone)}) · ${esc(sizeText)}\n${esc(parts)} · ${encrypted ? 'с паролем' : '⚠ без пароля'}\n\n<i>Восстановить: «Настройки → Резервные копии» → «Восстановить из файла».</i>`;
    const rich = await this.telegram.richEnabled();
    if (size > TELEGRAM_FILE_LIMIT_BYTES) {
      const note = 'Файл больше 50 МБ — Telegram его не примет. Скачайте копию в панели.';
      if (rich)
        await this.telegram.sendRichTo(
          d,
          `${caption}\n\n${note}`,
          backupBlocks({ when, zone, size: sizeText, contents: parts, encrypted, fileNote: note }),
        );
      else await this.telegram.sendTo(d, `${caption}\n\n${note}`);
      return { ok: false, note: 'файл больше 50 МБ' };
    }
    // Telegram не умеет прикрепить документ внутрь sendRichMessage. Поэтому карточка приходит первой,
    // а архив — коротким ответом на неё: визуально это одна связка и файл не теряется среди уведомлений.
    let replyTo: number | null = null;
    if (rich) {
      const summary = await this.telegram.sendRichTo(
        d,
        caption,
        backupBlocks({ when, zone, size: sizeText, contents: parts, encrypted }),
      );
      if (summary.ok) replyTo = summary.messageId;
    }
    const fileCaption = replyTo === null ? caption : '📎 <b>Архив резервной копии</b>';
    const res = await this.telegram.sendFileTo(d, { path, name }, fileCaption, replyTo);
    return res.ok ? { ok: true, note: null } : { ok: false, note: res.error.slice(0, 200) };
  }

  /** Метрики VictoriaMetrics в родном формате; не вышло — копия без метрик. */
  private async exportMetrics(out: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.vmUrl}/api/v1/export/native?match[]=${encodeURIComponent('{__name__!=""}')}`,
        {
          signal: AbortSignal.timeout(20 * 60_000),
        },
      );
      if (!res.ok || !res.body) return false;
      await pipeline(res.body as unknown as Readable, createWriteStream(out));
      return (await stat(out)).size > 0;
    } catch (err) {
      this.log.warn(`Метрики в копию не попали: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Держим последние keep копий; старше — удаляем вместе с описанием. */
  /**
   * Хранение: «последние N» — по обычным копиям (расписание, вручную, перед обновлением, из консоли).
   * Копии «перед восстановлением» — своя очередь из двух, загруженные с компьютера — пока не удалят:
   * иначе при N = 1 копия перед восстановлением вытеснила бы ту, из которой восстанавливаем.
   */
  private async retain(keep: number, protect: string | null = null): Promise<void> {
    const items = await this.items();
    const settings = await this.store.load();
    const regular = items.filter((i) => i.kind !== 'pre_restore' && i.kind !== 'uploaded');
    const preRestore = items.filter((i) => i.kind === 'pre_restore');
    for (const it of [...regular.slice(keep), ...preRestore.slice(2)]) {
      // Копию, из которой сейчас восстанавливают, не удаляем ни при каких условиях: иначе её стёрла бы
      // копия «перед восстановлением», сделанная за секунду до распаковки.
      if (it.name === protect) continue;
      // Не забываем внешнюю копию. Если S3 временно не ответил, оставляем локальную запись:
      // следующий проход срока хранения повторит удаление, а объект не останется сиротой.
      if (it.offsite?.ok && !(await this.deleteOffsite(settings, it.offsite))) continue;
      await rm(join(this.dir, it.name), { force: true }).catch(() => undefined);
      await rm(join(this.dir, `${it.name}.json`), { force: true }).catch(() => undefined);
    }
  }

  async remove(name: string): Promise<void> {
    const path = this.file(name);
    await stat(path).catch(() => {
      throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
    });
    const item = (await this.items()).find((candidate) => candidate.name === name);
    if (item?.offsite?.ok && !(await this.deleteOffsite(await this.store.load(), item.offsite)))
      throw problem(HttpStatus.BAD_GATEWAY, {
        detail: 'Внешнее хранилище не подтвердило удаление. Копия оставлена в панели — повторите позже.',
      });
    await rm(path, { force: true });
    await rm(`${path}.json`, { force: true });
    this.audit.extend({ target: { type: 'backup', id: name, display: name } });
  }

  /** Удалить тот же S3-объект при ручном удалении и по сроку хранения. */
  private async deleteOffsite(
    s: StoredBackupSettings,
    offsite: NonNullable<BackupItem['offsite']>,
  ): Promise<boolean> {
    if (!offsite.location.startsWith('s3://')) return true;
    const rest = offsite.location.slice('s3://'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return false;
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    const credentials = this.store.offsiteCredentials(s);
    if (!credentials) return false;
    const client = new S3Client({
      region: s.offsite.region,
      credentials,
      ...(s.offsite.endpoint ? { endpoint: s.offsite.endpoint, forcePathStyle: true } : {}),
    });
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      this.log.warn(
        `Внешняя копия ${offsite.location} не удалена: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    } finally {
      client.destroy();
    }
  }

  /**
   * Открыть архив для скачивания. Файл открывается здесь же: после этого его можно удалить (чистка старых
   * копий) — отдача не сорвётся; а если открыть нельзя, это ответ с причиной, а не сбой посреди отдачи.
   */
  async download(name: string): Promise<{ stream: Readable; size: number }> {
    const path = this.file(name);
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT')
        throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
      this.log.warn(`Копия ${name} не открывается: ${rawErrorText(err)}`);
      throw problem(HttpStatus.INTERNAL_SERVER_ERROR, {
        type: BACKUP_PROBLEM.unreadable,
        detail:
          code === 'EACCES' || code === 'EPERM'
            ? 'Панель не может прочитать файл этой копии: у неё нет прав на него. Так бывает, если файл положили в папку копий вручную. Скачать его можно с самого сервера панели.'
            : 'Панель не может прочитать файл этой копии. Подробности — в логах панели.',
      });
    }
    try {
      const st = await fh.stat();
      if (!st.isFile())
        throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
      await this.audit.record({
        action: 'backup.downloaded',
        target: { type: 'backup', id: name, display: name },
      });
      return { stream: fh.createReadStream(), size: st.size };
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
  }

  /** Загрузка архива с компьютера: сохраняем как копию «загружена», потом — проверка и восстановление. */
  async upload(stream: Readable, originalName: string): Promise<BackupItem> {
    this.busy();
    const now = new Date();
    const tmp = join(this.dir, `.upload-${now.getTime()}`);
    let bytes = 0;
    const limit = 2 * 1024 * 1024 * 1024;
    try {
      await pipeline(
        stream,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            bytes += chunk.length;
            if (bytes > limit) throw new BackupError('Файл больше 2 ГБ.');
            yield chunk;
          }
        },
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (bytes === 0) throw new BackupError('Файл пустой.');
      const encrypted = await isEncrypted(tmp);
      const name = backupName(now, encrypted, '-upload');
      await rename(tmp, join(this.dir, name));
      const side: Sidecar = {
        createdAt: now.toISOString(),
        kind: 'uploaded',
        verified: null,
        telegram: null,
        offsite: null,
        contents: null,
        version: null,
      };
      await writeFile(join(this.dir, `${name}.json`), JSON.stringify(side), { mode: 0o600 });
      await this.audit.record({
        action: 'backup.uploaded',
        target: { type: 'backup', id: name, display: originalName.slice(0, 120) },
        metadata: { size: mb(bytes) },
      });
      return {
        name,
        createdAt: side.createdAt,
        size: bytes,
        kind: 'uploaded',
        encrypted,
        verified: null,
        telegram: null,
        offsite: null,
        contents: null,
        version: null,
      };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      this.log.warn(`Файл копии не загрузился: ${rawErrorText(err)}`);
      throw problem(HttpStatus.BAD_REQUEST, { detail: explainBackupError(err, 'Файл не загрузился.') });
    }
  }

  /* ─────────── проверка и восстановление ─────────── */

  /** Распаковать архив во временную папку (расшифровать при необходимости). */
  private async unpack(
    name: string,
    password: string | undefined,
  ): Promise<{ work: string; needsPassword: boolean }> {
    const path = this.file(name);
    await stat(path).catch(() => {
      throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
    });
    const work = await mkdtemp(join(tmpdir(), 'ns-restore-'));
    let tarPath = path;
    if (await isEncrypted(path)) {
      if (!password) return { work, needsPassword: true };
      tarPath = join(work, 'archive.tar.gz');
      try {
        await decryptFile(path, tarPath, password);
      } catch {
        return { work, needsPassword: true };
      }
    }
    const r = await run('tar', ['-xzf', tarPath, '-C', work]);
    if (r.code !== 0)
      throw problem(HttpStatus.BAD_REQUEST, {
        detail: 'Архив не распаковывается — файл повреждён или это не копия панели.',
      });
    await rm(join(work, 'archive.tar.gz'), { force: true }).catch(() => undefined);
    return { work, needsPassword: false };
  }

  async inspect(name: string, password?: string): Promise<BackupInspect> {
    const { work, needsPassword } = await this.unpack(name, password);
    try {
      const encrypted = name.endsWith('.enc');
      if (needsPassword)
        return {
          name,
          createdAt: null,
          version: null,
          domain: null,
          encrypted,
          needsPassword: true,
          contents: null,
          sameKeys: null,
          compatible: false,
          problem: password ? 'Пароль не подошёл.' : 'Копия защищена паролем — введите его.',
          warning: null,
        };
      const dump = await stat(join(work, 'db.dump')).catch(() => null);
      if (!dump)
        return {
          name,
          createdAt: null,
          version: null,
          domain: null,
          encrypted,
          needsPassword: false,
          contents: null,
          sameKeys: null,
          compatible: false,
          problem: 'В архиве нет базы данных — это не копия панели.',
          warning: null,
        };
      const meta = parseMeta(await readFile(join(work, 'meta'), 'utf8').catch(() => ''));
      const hasEnv = await stat(join(work, 'env')).then(
        () => true,
        () => false,
      );
      const metrics = await stat(join(work, 'metrics.native')).then(
        () => true,
        () => false,
      );
      let sameKeys: boolean | null = null;
      if (hasEnv) {
        const env = envValues(await readFile(join(work, 'env'), 'utf8'));
        // Версия ключа по умолчанию — 1: в старых .env её нет.
        const norm = (k: string, v: string | undefined) =>
          k === 'ENCRYPTION_KEY_VERSION' ? v || '1' : (v ?? '');
        sameKeys = SECRET_KEYS.every((k) => norm(k, env[k]) === norm(k, this.keys[k]));
      }
      // Самих ключей в архиве нет — сверяем отпечаток, если копия его несёт. Нет и его (копии прежних
      // версий панели) — сверить не с чем: sameKeys остаётся null.
      else if (meta.keys_sha256) sameKeys = meta.keys_sha256 === this.keyPrint;
      const version = meta.panel ?? null;
      const newer = version ? versionLess(SHARED_VERSION, version) : false;
      const readable = await this.tools.verify(join(work, 'db.dump'));
      const problemText = !readable
        ? 'База в архиве не читается — копия повреждена.'
        : newer
          ? `Копия от более новой версии панели (${version}) — сначала обновите панель.`
          : sameKeys === false
            ? hasEnv
              ? 'Копия от другой установки (другие ключи шифрования). Её восстанавливают через консоль: nodeservice restore <файл> — там ключи переносятся вместе с базой.'
              : 'Копия от другой установки (другие ключи шифрования), а самих ключей в ней нет. Без ключей той установки её не восстановить — ни из панели, ни из консоли сервера.'
            : null;
      return {
        name,
        createdAt: meta.created ?? timeFromName(name)?.toISOString() ?? null,
        version,
        domain: meta.domain && meta.domain !== '?' ? meta.domain : null,
        encrypted,
        needsPassword: false,
        contents: { dbBytes: dump.size, env: hasEnv, metrics, paths: Number(meta.paths ?? 0) || 0 },
        sameKeys,
        compatible: problemText === null,
        problem: problemText,
        // Совместимой вслепую копию не объявляем: на этой установке она подойдёт, на другой — нет,
        // а какая перед нами, по такой копии не узнать.
        warning:
          problemText === null && sameKeys === null
            ? 'Ключей шифрования в этой копии нет — панель не может проверить, от этой ли она установки. Восстановить её можно только на установке с теми же ключами: на заново установленной панели после восстановления не подойдёт пароль и не расшифруются доступы к серверам.'
            : null,
      };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Восстановление: проверка → копия текущего состояния → база во временную БД и подмена → метрики →
   * перезапуск панели. Ответ приходит до перезапуска.
   */
  async restore(name: string, password?: string): Promise<void> {
    this.busy();
    const info = await this.inspect(name, password);
    if (info.needsPassword)
      throw problem(HttpStatus.BAD_REQUEST, {
        type: BACKUP_PROBLEM.password,
        detail: info.problem ?? 'Нужен пароль.',
      });
    if (!info.compatible)
      throw problem(HttpStatus.CONFLICT, { detail: info.problem ?? 'Копию нельзя восстановить.' });
    const actor = this.actor();
    this.runState = { stage: 'db', startedAt: new Date().toISOString(), mode: 'restore', lastError: null };
    try {
      // Сначала — копия того, что есть сейчас: передумаете — вернётесь к ней. Чистка старых копий после
      // неё не трогает ту, из которой восстанавливаем.
      await this.create('pre_restore', { sendTelegram: false, protect: name }, actor);
      this.runState = { stage: 'db', startedAt: this.runState.startedAt, mode: 'restore', lastError: null };
      const { work } = await this.unpack(name, password);
      try {
        await this.tools.restore(join(work, 'db.dump'));
        if (info.contents?.metrics) await this.importMetrics(join(work, 'metrics.native'));
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err) {
      this.log.warn(`Восстановление из ${name} не удалось: ${rawErrorText(err)}`);
      // «База не тронута» — только когда это известно: связь могла оборваться на самом подтверждении
      // подмены, и тогда панель не знает, какая база сейчас рабочая.
      const unknown = err instanceof BackupToolError && err.outcomeUnknown;
      const reason = unknown
        ? 'Связь с базой данных оборвалась в самый момент подмены, и панель не смогла проверить, какая база сейчас рабочая — прежняя или восстановленная. Перезапустите панель с сервера и посмотрите, на месте ли свежие данные.'
        : explainBackupError(err);
      this.runState = { stage: null, startedAt: null, mode: null, lastError: reason };
      // Свой тип ошибки: без него ответ 500 подменяется общим «Что-то пошло не так на сервере».
      throw problem(HttpStatus.INTERNAL_SERVER_ERROR, {
        type: BACKUP_PROBLEM.restoreFailed,
        detail: unknown
          ? `Восстановление не завершено. ${reason}`
          : `Восстановление не удалось, текущая база не тронута: ${reason}`,
      });
    }
    // Запись — уже в восстановленную базу: пусть в Журнале будет видно, что панель откатывали.
    await this.audit
      .record({
        action: 'backup.restored',
        severity: 'warn',
        ...(actor ? { actor: { type: 'admin', id: null, display: actor } } : {}),
        target: { type: 'backup', id: name, display: name },
        metadata: { createdAt: info.createdAt, version: info.version },
      })
      .catch(() => undefined);
    this.log.warn(`Панель восстановлена из ${name} — перезапуск`);
    // Панель выходит сама, минуя обработчики остановки: отметку штатной остановки ставим здесь, иначе после
    // перезапуска она сообщила бы, что упала.
    await this.lifecycle.markStopped().catch(() => undefined);
    if (process.env.NODE_ENV !== 'test') setTimeout(() => process.exit(0), 1500).unref();
    else this.runState = { stage: null, startedAt: null, mode: null, lastError: null };
  }

  private async importMetrics(path: string): Promise<void> {
    try {
      await fetch(`${this.vmUrl}/api/v1/import/native`, {
        method: 'POST',
        body: await openAsBlob(path),
        signal: AbortSignal.timeout(20 * 60_000),
      });
    } catch (err) {
      this.log.warn(`Метрики не вернулись: ${err instanceof Error ? err.message : err}`);
    }
  }

  /* ─────────── расписание ─────────── */

  async tick(now = new Date()): Promise<boolean> {
    if (this.runState.stage) return false;
    const s = await this.store.load();
    const tz = await this.timeZone();
    const lastAuto = (await this.items()).find((i) => i.kind === 'auto');
    const lastAutoAt = lastAuto ? new Date(lastAuto.createdAt) : null;
    if (!isBackupDue(now, s, tz, lastAutoAt)) return false;
    // Момент расписания наступил, копии после него нет. Была ли уже попытка — в базе: неудачная файла
    // не оставляет, и без этой отметки копия запускалась бы заново каждую минуту все шесть часов.
    const state = await this.store.schedule();
    if (!isBackupDue(now, s, tz, lastAutoAt, state.attemptAt ? new Date(state.attemptAt) : null))
      return false;
    const slot = lastScheduledAt(now, s, tz);
    if (!slot) return false;
    await this.store.saveSchedule({ ...state, attemptAt: now.toISOString() });
    const scheduled: Scheduled = { slot, at: now };
    // Копии могли быть недоступны с самого запуска панели (папка копий досталась другому пользователю):
    // состояние перепроверялось, только когда открывали страницу копий, и расписание молчало неделями.
    if (!this.toolsState.ok) await this.refreshState();
    if (!this.toolsState.ok) {
      await this.fail(
        'auto',
        new BackupError(
          `Копия по расписанию не сделана. ${this.toolsState.reason ?? 'Копии сейчас недоступны.'}`,
        ),
        null,
        scheduled,
      );
      return false;
    }
    this.start('auto', { scheduled });
    return true;
  }

  /** Для Джарвиса и «Состояния панели»: когда была последняя копия. */
  async lastBackup(): Promise<{ at: string; kind: string; size: string; verified: boolean | null } | null> {
    const last = (await this.items())[0];
    return last
      ? {
          at: last.createdAt,
          kind: BACKUP_KIND_LABELS[last.kind],
          size: mb(last.size),
          verified: last.verified,
        }
      : null;
  }

  /** Проверить свой чат для копий строкой (кнопка «Отправить тест»). */
  async testOwnChat(url: string | null): Promise<{ ok: boolean; detail: string }> {
    const s = await this.store.load();
    // Пусто или маска сохранённого чата — проверяем сохранённый; иначе — строку из поля, как она есть.
    const raw = url && url !== this.store.toPublic(s).telegram.ownUrl ? url : this.store.ownUrl(s);
    if (!raw) return { ok: false, detail: 'Укажите чат строкой tgram://…' };
    const d = await this.telegram.resolveTarget({ url: raw });
    if (!d) return { ok: false, detail: 'Строка не похожа на tgram://токен/чат.' };
    const res = await this.telegram.sendTo(
      d,
      '✅ <b>NodeService</b>\nТест: сюда будут приходить резервные копии.',
    );
    return res.ok ? { ok: true, detail: 'Сообщение отправлено.' } : { ok: false, detail: res.error };
  }
}

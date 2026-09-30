import { constants, createWriteStream, openAsBlob } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
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
import { NotificationsService } from '../notifications/notifications.service.js';
import { esc } from '../notifications/telegram/telegram.format.js';
import { TelegramService } from '../notifications/telegram/telegram.service.js';
import { decryptFile, encryptFile, isEncrypted } from './backup-crypto.js';
import { BackupSettingsStore, type StoredBackupSettings } from './backup-settings.store.js';
import { BACKUP_TOOLS, type BackupTools, run } from './backup-tools.js';
import {
  backupName,
  envValues,
  isBackupDue,
  nextBackupAt,
  parseMeta,
  SECRET_KEYS,
  timeFromName,
  versionLess,
} from './backups.logic.js';

/** Описание копии рядом с архивом: <имя>.json. */
interface Sidecar {
  createdAt: string;
  kind: BackupKind;
  verified: boolean | null;
  telegram: { ok: boolean; note: string | null } | null;
  contents: BackupItem['contents'];
  version: string | null;
}

const mb = (b: number) => `${(b / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;

/**
 * Резервные копии панели (0.39.0). Архив совместим с консольными `nodeservice backup` / `restore`.
 * Одна операция за раз: копия или восстановление. Восстановление разворачивает дамп во временную базу и
 * подменяет имена — при сбое текущая база не тронута; после успеха панель перезапускается сама.
 */
@Injectable()
export class BackupsService implements OnModuleInit {
  private readonly log = new Logger(BackupsService.name);
  private readonly dir: string;
  private readonly envPath: string;
  private readonly hostRoot: string;
  private readonly vmUrl: string;
  /** Ключи этой установки — чтобы понять, от неё ли копия (из настроек, а не из окружения процесса). */
  private readonly keys: Record<string, string>;
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
  ) {
    this.dir = resolve(config.get('BACKUPS_DIR'));
    this.envPath = config.get('INSTALL_ENV_PATH');
    this.hostRoot = config.get('HOST_ROOT');
    this.vmUrl = config.get('VM_URL');
    this.keys = Object.fromEntries(SECRET_KEYS.map((k) => [k, String(config.get(k) ?? '')]));
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
            'Панели не хватает прав на папку копий на сервере. Выполните на сервере панели «nodeservice update» — команда выдаст права.',
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
      else if (!t.ownUrl.includes('•••')) {
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
    if (patch.password !== undefined)
      next.passwordEnc = patch.password ? this.store.encrypt(patch.password) : null;
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
      changes.extra = { before: before.extra.paths.length, after: after.extra.paths.length };
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
  start(kind: BackupKind, opts: { sendTelegram?: boolean } = {}): void {
    if (!this.toolsState.ok)
      throw problem(HttpStatus.SERVICE_UNAVAILABLE, {
        type: BACKUP_PROBLEM.unavailable,
        detail: this.toolsState.reason ?? 'Копии сейчас недоступны.',
      });
    this.busy();
    this.runState = { stage: 'db', startedAt: new Date().toISOString(), mode: 'backup', lastError: null };
    const actor = this.actor();
    void this.create(kind, opts, actor)
      .catch((err) => this.fail(kind, err, actor))
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

  /** Сделать копию и дождаться (для «перед восстановлением» и тестов). */
  async create(
    kind: BackupKind,
    opts: { sendTelegram?: boolean } = {},
    actor: string | null = null,
  ): Promise<BackupItem> {
    const s = await this.store.load();
    const password = this.store.password(s);
    const now = new Date();
    const work = await mkdtemp(join(tmpdir(), 'ns-backup-'));
    const plainName = backupName(now, false);
    const name = backupName(now, Boolean(password));
    const target = join(this.dir, name);
    try {
      this.stage('db');
      await this.tools.dump(join(work, 'db.dump'));
      const files = ['meta', 'db.dump'];
      this.stage('env');
      let hasEnv = false;
      if (this.envPath) {
        await copyFile(this.envPath, join(work, 'env')).then(
          () => {
            hasEnv = true;
            files.push('env');
          },
          () => undefined,
        );
      }
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
      const env = hasEnv ? envValues(await readFile(join(work, 'env'), 'utf8')) : {};
      await writeFile(
        join(work, 'meta'),
        [
          'format=2',
          `created=${now.toISOString()}`,
          `domain=${env.PANEL_DOMAIN ?? '?'}`,
          `panel=${SHARED_VERSION}`,
          `kind=${kind}`,
          `metrics=${hasMetrics ? 1 : 0}`,
          `paths=${pathsCount}`,
          `encrypted=${password ? 1 : 0}`,
        ].join('\n'),
      );
      this.stage('pack');
      const packed = join(work, plainName);
      const tar = await run('tar', ['-czf', packed, '-C', work, ...files]);
      if (tar.code !== 0)
        throw new Error(`Архив не собрался: ${tar.stderr.trim().split('\n').at(-1) ?? tar.code}`);
      this.stage('verify');
      const verified = await this.tools.verify(join(work, 'db.dump'));
      if (!verified) throw new Error('Дамп базы не читается — копия не сохранена.');
      if (password) {
        this.stage('encrypt');
        await encryptFile(packed, `${target}.part`, password);
      } else await copyFile(packed, `${target}.part`);
      await rename(`${target}.part`, target);
      const contents = { db: true, env: hasEnv, metrics: hasMetrics, paths: pathsCount };
      const side: Sidecar = {
        createdAt: now.toISOString(),
        kind,
        verified,
        telegram: null,
        contents,
        version: SHARED_VERSION,
      };
      await writeFile(`${target}.json`, JSON.stringify(side), { mode: 0o600 });
      const size = (await stat(target)).size;
      if (kind !== 'pre_restore' && (opts.sendTelegram ?? s.telegram.enabled)) {
        this.stage('telegram');
        side.telegram = await this.sendToTelegram(s, target, name, size, now, contents, Boolean(password));
        await writeFile(`${target}.json`, JSON.stringify(side), { mode: 0o600 });
      }
      this.stage('cleanup');
      await this.retain(s.keep);
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
        contents,
        version: SHARED_VERSION,
      };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      await rm(`${target}.part`, { force: true }).catch(() => undefined);
    }
  }

  private async fail(kind: BackupKind, err: unknown, actor: string | null): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    this.runState = { ...this.runState, lastError: reason };
    this.log.warn(`Копия не получилась: ${reason}`);
    await this.audit.record({
      action: 'backup.failed',
      result: 'failed',
      severity: 'warn',
      ...(actor ? { actor: { type: 'admin', id: null, display: actor } } : { actor: SYSTEM_ACTOR }),
      metadata: { kind: BACKUP_KIND_LABELS[kind], error: reason.slice(0, 300) },
    });
    await this.notifications.push({
      severity: 'crit',
      title: 'Резервная копия не получилась',
      body: reason.slice(0, 500),
      link: { to: '/settings/backups', label: 'Открыть копии' },
    });
    const s = await this.store.load();
    if (s.telegram.enabled && s.telegram.notifyFailure) {
      const d = await this.targetOf(s);
      if (d)
        await this.telegram.sendTo(
          d,
          `🔴 <b>Резервная копия не получилась</b>\n${esc(reason.slice(0, 500))}\n\n<i>Следующая — по расписанию. Сделать вручную: «Настройки → Резервные копии».</i>`,
        );
    }
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
    const caption = `🗄 <b>Резервная копия NodeService</b>\n${esc(when)} (${esc(zoneLabel(at, tz))}) · ${esc(mb(size))}\n${esc(parts)} · ${encrypted ? 'с паролем' : '⚠ без пароля'}\n\n<i>Восстановить: «Настройки → Резервные копии» → «Восстановить из файла».</i>`;
    if (size > TELEGRAM_FILE_LIMIT_BYTES) {
      await this.telegram.sendTo(
        d,
        `${caption}\n\nФайл больше 50 МБ — Telegram его не примет. Скачайте копию в панели.`,
      );
      return { ok: false, note: 'Telegram: файл больше 50 МБ' };
    }
    const res = await this.telegram.sendFileTo(d, { path, name }, caption);
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
  private async retain(keep: number): Promise<void> {
    const items = await this.items();
    const regular = items.filter((i) => i.kind !== 'pre_restore' && i.kind !== 'uploaded');
    const preRestore = items.filter((i) => i.kind === 'pre_restore');
    for (const it of [...regular.slice(keep), ...preRestore.slice(2)]) {
      await rm(join(this.dir, it.name), { force: true }).catch(() => undefined);
      await rm(join(this.dir, `${it.name}.json`), { force: true }).catch(() => undefined);
    }
  }

  async remove(name: string): Promise<void> {
    const path = this.file(name);
    await stat(path).catch(() => {
      throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
    });
    await rm(path, { force: true });
    await rm(`${path}.json`, { force: true });
    this.audit.extend({ target: { type: 'backup', id: name, display: name } });
  }

  /** Путь к файлу для скачивания. */
  async downloadPath(name: string): Promise<{ path: string; size: number }> {
    const path = this.file(name);
    const st = await stat(path).catch(() => null);
    if (!st)
      throw problem(HttpStatus.NOT_FOUND, { type: BACKUP_PROBLEM.notFound, detail: 'Такой копии нет.' });
    await this.audit.record({
      action: 'backup.downloaded',
      target: { type: 'backup', id: name, display: name },
    });
    return { path, size: st.size };
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
            if (bytes > limit) throw new Error('Файл больше 2 ГБ.');
            yield chunk;
          }
        },
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (bytes === 0) throw new Error('Файл пустой.');
      const encrypted = await isEncrypted(tmp);
      const name = backupName(now, encrypted, '-upload');
      await rename(tmp, join(this.dir, name));
      const side: Sidecar = {
        createdAt: now.toISOString(),
        kind: 'uploaded',
        verified: null,
        telegram: null,
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
        contents: null,
        version: null,
      };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw problem(HttpStatus.BAD_REQUEST, {
        detail: err instanceof Error ? err.message : 'Файл не загрузился.',
      });
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
      const version = meta.panel ?? null;
      const newer = version ? versionLess(SHARED_VERSION, version) : false;
      const readable = await this.tools.verify(join(work, 'db.dump'));
      const problemText = !readable
        ? 'База в архиве не читается — копия повреждена.'
        : newer
          ? `Копия от более новой версии панели (${version}) — сначала обновите панель.`
          : sameKeys === false
            ? 'Копия от другой установки (другие ключи шифрования). Её восстанавливают через консоль: nodeservice restore <файл> — там ключи переносятся вместе с базой.'
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
      // Сначала — копия того, что есть сейчас: передумаете — вернётесь к ней.
      await this.create('pre_restore', { sendTelegram: false }, actor);
      this.runState = { stage: 'db', startedAt: this.runState.startedAt, mode: 'restore', lastError: null };
      const { work } = await this.unpack(name, password);
      try {
        await this.tools.restore(join(work, 'db.dump'));
        if (info.contents?.metrics) await this.importMetrics(join(work, 'metrics.native'));
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err) {
      this.runState = {
        stage: null,
        startedAt: null,
        mode: null,
        lastError: err instanceof Error ? err.message : String(err),
      };
      throw problem(HttpStatus.INTERNAL_SERVER_ERROR, {
        detail: `Восстановление не удалось, текущая база не тронута: ${err instanceof Error ? err.message : err}`,
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
    if (this.runState.stage || !this.toolsState.ok) return false;
    const s = await this.store.load();
    const tz = await this.timeZone();
    const lastAuto = (await this.items()).find((i) => i.kind === 'auto');
    if (!isBackupDue(now, s, tz, lastAuto ? new Date(lastAuto.createdAt) : null)) return false;
    this.start('auto');
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
    const raw = url && !url.includes('•••') ? url : this.store.ownUrl(s);
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

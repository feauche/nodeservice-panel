import { HttpStatus, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  SERVER_CHECK_AUTO_KEYS,
  SERVER_CHECK_INTERVAL_HOURS,
  SERVER_CHECK_META,
  SERVER_CHECK_PROBLEM,
  SERVER_CHECK_RETRY_FAILED_HOURS,
  type ServerCheckKey,
  type ServerCheckRun,
  type ServerChecksResponse,
} from '@nodeservice/shared';
import { ClsService } from 'nestjs-cls';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { ServerCheckRow } from '../../infra/db/schema/index.js';
import { type AuditActor, SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { CLS_USER } from '../auth/cls-keys.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService, type SshSession } from '../servers/ssh.service.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { ServerChecksRepository, toCheckRun } from './server-checks.repository.js';
import {
  capOutput,
  checkCommand,
  cleanOutput,
  exitReason,
  reportComplete,
  runStatus,
  SERVER_CHECK_TIMEOUT_MS,
  stripNoise,
} from './server-checks.scripts.js';

/** Живой вывод пишем в БД не чаще этого: страница опрашивает раз в пару секунд. */
const OUTPUT_FLUSH_MS = 1500;
/** Сырой вывод в памяти не растёт бесконечно: держим с запасом к хранимому пределу. */
const RAW_MAX = 256 * 1024;

const errorText = (err: unknown): string => {
  if (err && typeof err === 'object' && 'getResponse' in err) {
    const res = (err as { getResponse(): unknown }).getResponse();
    if (res && typeof res === 'object' && 'detail' in res) return String((res as { detail: unknown }).detail);
  }
  return err instanceof Error ? err.message : String(err);
};

/**
 * Реестр проверок сервера (R5/J9): запуск скрипта по SSH, живой вывод в БД, итог в Журнал.
 * На одном сервере одновременно идёт не больше одной проверки — они мешали бы друг другу замерами.
 */
@Injectable()
export class ServerChecksService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ServerChecksService.name);
  /** Идущие проверки этого процесса: serverId → отмена. */
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly repo: ServerChecksRepository,
    private readonly servers: ServersService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly notifications: NotificationsService,
    private readonly autochecks: AutochecksStore,
  ) {}

  async onModuleInit(): Promise<void> {
    const n = await this.repo.failOrphans('Прервано перезапуском панели.').catch(() => 0);
    if (n > 0) this.log.warn(`Закрыто незавершённых проверок: ${n}`);
  }

  onModuleDestroy(): void {
    for (const ctl of this.active.values()) ctl.abort();
  }

  async list(serverId: string): Promise<ServerChecksResponse> {
    await this.servers.get(serverId);
    const rows = await this.repo.latest(serverId);
    const autoEnabled = (await this.autochecks.get()).serverChecksEnabled;
    // Срок — только у того, что панель повторяет сама: свои команды и лишь при включённом тумблере.
    const auto = autoEnabled ? rows.filter((r) => SERVER_CHECK_AUTO_KEYS.includes(r.check)) : [];
    const earliest = auto.length > 0 ? Math.min(...auto.map((r) => r.startedAt.getTime())) : null;
    return {
      items: rows.map(toCheckRun),
      autoEnabled,
      nextAutoAt:
        earliest === null ? null : new Date(earliest + SERVER_CHECK_INTERVAL_HOURS * 3_600_000).toISOString(),
    };
  }

  /** Запуск по кнопке: тяжёлая проверка — только с явным согласием. */
  async start(serverId: string, check: ServerCheckKey, confirmHeavy = false): Promise<ServerCheckRun> {
    if (SERVER_CHECK_META[check].heavy && !confirmHeavy)
      throw problem(HttpStatus.BAD_REQUEST, {
        type: SERVER_CHECK_PROBLEM.heavyConfirm,
        detail: `«${SERVER_CHECK_META[check].label}» — тяжёлая проверка: ${SERVER_CHECK_META[check].duration}. Подтвердите запуск.`,
      });
    const user = this.cls.isActive()
      ? this.cls.get<{ id: string; login: string } | undefined>(CLS_USER)
      : undefined;
    const actor: AuditActor = user ? { type: 'admin', id: user.id, display: user.login } : SYSTEM_ACTOR;
    return (await this.launch(serverId, check, 'manual', actor)).run;
  }

  /**
   * Запуск от Джарвиса: актор «Джарвис» в Журнале. Тяжёлые сюда не попадают — их Джарвис только
   * предлагает карточкой, а подтверждение приходит от человека через start().
   */
  async startForJarvis(serverId: string, check: ServerCheckKey): Promise<ServerCheckRun> {
    if (SERVER_CHECK_META[check].heavy) throw new Error('Тяжёлые проверки Джарвис сам не запускает.');
    const actor: AuditActor = { ...SYSTEM_ACTOR, display: 'Джарвис' };
    return (await this.launch(serverId, check, 'manual', actor)).run;
  }

  /** Дождаться конца запуска (опрос БД); по истечению — текущее состояние, возможно ещё «идёт». */
  async waitDone(runId: string, timeoutMs: number): Promise<ServerCheckRun | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await this.repo.findById(runId);
      if (!row) return null;
      if (row.status !== 'running' || Date.now() >= deadline) return toCheckRun(row);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async history(serverId: string, check: ServerCheckKey, limit = 10): Promise<ServerCheckRun[]> {
    await this.servers.get(serverId);
    return (await this.repo.history(serverId, check, limit)).map(toCheckRun);
  }

  /**
   * Суточный запуск (джоба): занято — просто пропуск; ждём конца, чтобы идти по серверам по одному.
   * Только свои команды: сторонний скрипт по расписанию не запускается, даже если его сюда передали.
   */
  async scheduled(serverId: string, check: ServerCheckKey): Promise<void> {
    if (!SERVER_CHECK_AUTO_KEYS.includes(check)) return;
    if (this.active.has(serverId)) return;
    const { done } = await this.launch(serverId, check, 'auto', SYSTEM_ACTOR);
    await done;
  }

  private async launch(
    serverId: string,
    check: ServerCheckKey,
    trigger: 'auto' | 'manual',
    actor: AuditActor,
  ): Promise<{ run: ServerCheckRun; done: Promise<void> }> {
    const busy = () =>
      problem(HttpStatus.CONFLICT, {
        type: SERVER_CHECK_PROBLEM.busy,
        detail: 'На этом сервере уже идёт проверка. Дождитесь, пока она закончится.',
      });
    // Замок берём до первого await: два клика подряд не должны запустить две проверки.
    if (this.active.has(serverId)) throw busy();
    const ctl = new AbortController();
    this.active.set(serverId, ctl);
    let row: ServerCheckRow;
    let serverName: string;
    try {
      serverName = (await this.servers.get(serverId)).name;
      if (await this.repo.findRunning(serverId)) throw busy();
      try {
        row = await this.repo.start({ serverId, check, trigger, actorDisplay: actor.display });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw busy();
        throw err;
      }
    } catch (err) {
      this.active.delete(serverId);
      throw err;
    }
    const done = this.execute(row, serverName, actor, ctl.signal)
      .catch((err) => this.log.error({ err: errorText(err) }, 'Проверка упала вне выполнения'))
      .finally(() => this.active.delete(serverId));
    return { run: toCheckRun(row), done };
  }

  private async execute(
    row: ServerCheckRow,
    serverName: string,
    actor: AuditActor,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    let raw = '';
    let error: string | null = null;
    let status: 'ok' | 'failed' | 'cancelled' = 'ok';
    let session: SshSession | null = null;
    let timer: NodeJS.Timeout | null = null;
    let chain: Promise<void> = Promise.resolve();
    const text = () => capOutput(stripNoise(row.check, cleanOutput(raw)));
    const flush = () => {
      timer = null;
      const snapshot = text();
      chain = chain.then(() => this.repo.setOutput(row.id, snapshot)).catch(() => undefined);
    };
    try {
      const { target } = await this.servers.sshTargetFor(row.serverId);
      session = await this.ssh.connect(target);
      const res = await session.execStream(checkCommand(row.check), {
        timeoutMs: SERVER_CHECK_TIMEOUT_MS[row.check],
        signal,
        onData: (chunk) => {
          raw += chunk;
          if (raw.length > RAW_MAX) raw = raw.slice(0, RAW_MAX / 4) + raw.slice(-(RAW_MAX * 3) / 4);
          timer ??= setTimeout(flush, OUTPUT_FLUSH_MS);
        },
      });
      if (res.code !== 0 && !reportComplete(row.check, cleanOutput(raw))) {
        error = exitReason(res.code);
        status = runStatus(res.code);
      }
    } catch (err) {
      error = errorText(err).slice(0, 500);
      status = 'failed';
    } finally {
      session?.end();
      if (timer) clearTimeout(timer);
      await chain;
    }
    await this.repo.finish(row.id, status, text(), error);
    await this.repo.prune(row.serverId, row.check).catch(() => undefined);
    // Только суточные запуски: по ручному вы и так смотрите на экран.
    if (error && row.trigger === 'auto')
      await this.notifications.push({
        severity: 'info',
        title: `Проверка «${SERVER_CHECK_META[row.check].label}» не удалась · {server}`,
        body: `Причина: ${error}`,
        server: { id: row.serverId, name: serverName },
        link: { to: `/servers?open=${row.serverId}`, label: 'Открыть сервер' },
        telegram: { event: 'check_failed' },
      });
    await this.audit
      .record({
        action: 'server.check.run',
        actor,
        source: row.trigger === 'auto' ? 'auto' : 'manual',
        // Отменённый запуск — отказ панели запустить изменившийся скрипт, а не сбой на сервере.
        result: status === 'cancelled' ? 'denied' : error ? 'failed' : 'ok',
        severity: error ? 'warn' : 'info',
        target: { type: 'server', id: row.serverId, display: serverName },
        durationMs: Date.now() - startedAt,
        metadata: { runId: row.id, check: SERVER_CHECK_META[row.check].label, ...(error ? { error } : {}) },
      })
      .catch(() => undefined);
  }

  /** Свои проверки, которые пора повторить (или ещё не запускались), по серверам. Сторонние сюда не входят. */
  async dueLightChecks(serverIds: string[]): Promise<Array<{ serverId: string; check: ServerCheckKey }>> {
    const last = new Map((await this.repo.lastStarts()).map((r) => [`${r.serverId}:${r.check}`, r]));
    const deadline = Date.now() - SERVER_CHECK_INTERVAL_HOURS * 3_600_000;
    // Упавшую проверку повторяем через час, а не через сутки: причина часто разовая (сторонний сервис
    // не ответил) или уже исправлена обновлением панели.
    const failedDeadline = Date.now() - SERVER_CHECK_RETRY_FAILED_HOURS * 3_600_000;
    const out: Array<{ serverId: string; check: ServerCheckKey }> = [];
    for (const serverId of serverIds)
      for (const check of SERVER_CHECK_AUTO_KEYS) {
        const r = last.get(`${serverId}:${check}`);
        const at = r?.at.getTime();
        if (!r || at === undefined || at < deadline || (r.status === 'failed' && at < failedDeadline))
          out.push({ serverId, check });
      }
    return out;
  }
}

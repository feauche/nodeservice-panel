import { HttpStatus, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAINTENANCE_CHECK_INTERVAL_HOURS,
  MAINTENANCE_KIND_LABELS,
  MAINTENANCE_PROBLEM,
  MAINTENANCE_RUNS_LIMIT,
  type MaintenanceCheck,
  type MaintenanceKind,
  type MaintenanceRun,
  type MaintenanceRunsResponse,
  type MaintenanceState,
  type MaintenanceStep,
} from '@nodeservice/shared';
import { ClsService } from 'nestjs-cls';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import type { MaintenanceRunRow } from '../../infra/db/schema/index.js';
import { type AuditActor, SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { CLS_USER } from '../auth/cls-keys.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService, type SshSession } from '../servers/ssh.service.js';
import { AgentReleasesService } from './agent-releases.service.js';
import { MaintenanceRepository, toRun } from './maintenance.repository.js';
import { actionSteps, checkScript, MAINTENANCE_TIMEOUT_MS, parseCheckOutput } from './maintenance.scripts.js';

/** Лог пишем в БД пачками: клиент опрашивает раз в полторы секунды, чаще не нужно. */
const LOG_FLUSH_MS = 800;
const LOG_FLUSH_BYTES = 16 * 1024;
/** После обновления агента ждём, пока он выйдет на связь новой версией. */
const AGENT_WAIT_MS = 45_000;

const errorText = (err: unknown): string => {
  if (err && typeof err === 'object' && 'getResponse' in err) {
    const res = (err as { getResponse(): unknown }).getResponse();
    if (res && typeof res === 'object' && 'detail' in res) return String((res as { detail: unknown }).detail);
  }
  return err instanceof Error ? err.message : String(err);
};

class StepFailed extends Error {}

/**
 * Обслуживание сервера: чек-лист раз в сутки и действия по шагам (apt upgrade, обновление
 * агента, очистка, автообновления). Всё по SSH от имени панели; каждый запуск — строка в
 * maintenance_runs с живым логом, итог — в Журнал. Одновременно на сервере идёт не больше одного.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceService.name);
  /** Идущие запуски этого процесса: serverId → отмена. */
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly repo: MaintenanceRepository,
    private readonly servers: ServersService,
    private readonly serversRepo: ServersRepository,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
    private readonly releases: AgentReleasesService,
    private readonly config: ConfigService<Env, true>,
    private readonly cls: ClsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const n = await this.repo.failOrphans('Прервано перезапуском панели').catch(() => 0);
    if (n > 0) this.log.warn(`Закрыто незавершённых запусков обслуживания: ${n}`);
  }

  onModuleDestroy(): void {
    for (const ctl of this.active.values()) ctl.abort();
  }

  async state(serverId: string): Promise<MaintenanceState> {
    await this.servers.get(serverId);
    const [st, running, last] = await Promise.all([
      this.repo.getState(serverId),
      this.repo.findRunning(serverId),
      this.repo.lastFinished(serverId),
    ]);
    const nextCheckAt = st?.checkedAt
      ? new Date(st.checkedAt.getTime() + MAINTENANCE_CHECK_INTERVAL_HOURS * 3_600_000).toISOString()
      : null;
    return {
      serverId,
      check: st?.check ?? null,
      checkError: st?.checkError ?? null,
      nextCheckAt,
      running: running ? toRun(running) : null,
      lastRun: last ? toRun(last) : null,
    };
  }

  async runs(serverId: string, limit = 20): Promise<MaintenanceRunsResponse> {
    await this.servers.get(serverId);
    const rows = await this.repo.listRuns(serverId, Math.min(limit, MAINTENANCE_RUNS_LIMIT));
    return { items: rows.map((r) => toRun(r, false)) };
  }

  /** Плановая проверка (джоба): актор — система, конфликт с идущим запуском — просто пропуск.
   *  Ждёт завершения, чтобы джоба шла по серверам по одному, а не открывала SSH ко всем сразу. */
  async scheduledCheck(serverId: string): Promise<void> {
    if (this.active.has(serverId)) return;
    const { done } = await this.launch(serverId, 'check', SYSTEM_ACTOR);
    await done;
  }

  /** Запуск по кнопке: актор — администратор из сессии. */
  async start(serverId: string, kind: MaintenanceKind): Promise<MaintenanceRun> {
    const user = this.cls.isActive()
      ? this.cls.get<{ id: string; login: string } | undefined>(CLS_USER)
      : undefined;
    const actor: AuditActor = user ? { type: 'admin', id: user.id, display: user.login } : SYSTEM_ACTOR;
    return (await this.launch(serverId, kind, actor)).run;
  }

  private async launch(
    serverId: string,
    kind: MaintenanceKind,
    actor: AuditActor,
  ): Promise<{ run: MaintenanceRun; done: Promise<void> }> {
    const busy = () =>
      problem(HttpStatus.CONFLICT, {
        type: MAINTENANCE_PROBLEM.busy,
        detail: 'На этом сервере уже идёт обслуживание. Дождитесь завершения.',
      });
    // Замок берём синхронно, до первого await: два клика подряд не должны открыть два apt-get.
    if (this.active.has(serverId)) throw busy();
    const ctl = new AbortController();
    this.active.set(serverId, ctl);
    let row: MaintenanceRunRow;
    let serverName: string;
    try {
      const server = await this.servers.get(serverId);
      serverName = server.name;
      if (await this.repo.findRunning(serverId)) throw busy();
      if (kind !== 'check' && kind !== 'agent_update') {
        const st = await this.repo.getState(serverId);
        if (st?.check && !st.check.supported) {
          throw problem(HttpStatus.BAD_REQUEST, {
            type: MAINTENANCE_PROBLEM.unsupported,
            detail: 'Обновления через apt доступны только на Debian и Ubuntu.',
          });
        }
      }
      try {
        row = await this.repo.startRun({
          serverId,
          kind,
          actorId: actor.type === 'admin' ? (actor.id ?? null) : null,
          actorDisplay: actor.display,
          steps: this.planSteps(kind),
        });
      } catch (err) {
        // Частичный уникальный индекс «один running на сервер» — страховка на случай второго процесса панели.
        if ((err as { code?: string }).code === '23505') throw busy();
        throw err;
      }
    } catch (err) {
      this.active.delete(serverId);
      throw err;
    }
    const done = this.execute(row, serverName, actor, ctl.signal)
      .catch((err) => this.log.error({ err: errorText(err) }, 'Обслуживание упало вне шагов'))
      .finally(() => this.active.delete(serverId));
    return { run: toRun(row), done };
  }

  private planSteps(kind: MaintenanceKind): MaintenanceStep[] {
    const mk = (key: string, label: string): MaintenanceStep => ({
      key,
      label,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      detail: null,
    });
    const connect = mk('connect', 'Подключение по SSH');
    if (kind === 'check')
      return [connect, mk('collect', 'Сбор данных о системе'), mk('release', 'Версия агента на GitHub')];
    const action = actionSteps(kind, this.config.get('AGENT_REPO')).map((s) => mk(s.key, s.label));
    const tail = kind === 'agent_update' ? [mk('verify', 'Агент вышел на связь')] : [];
    return [connect, ...action, ...tail, mk('after', 'Проверка после')];
  }

  private async execute(
    row: MaintenanceRunRow,
    serverName: string,
    actor: AuditActor,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = row.steps.map((s) => ({ ...s }));
    const startedAt = Date.now();
    let session: SshSession | null = null;
    let error: string | null = null;
    let summary: Record<string, unknown> = {};

    // Лог: копим и сбрасываем пачками.
    let buffer = '';
    let flushTimer: NodeJS.Timeout | null = null;
    // Записи в БД идут строго по очереди: два параллельных append могли бы поменять куски местами.
    let chain: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (buffer) {
        const chunk = buffer;
        buffer = '';
        chain = chain.then(() => this.repo.appendLog(row.id, chunk)).catch(() => undefined);
      }
      return chain;
    };
    const write = (text: string) => {
      buffer += text;
      if (buffer.length >= LOG_FLUSH_BYTES) void flush();
      else if (!flushTimer) flushTimer = setTimeout(() => void flush(), LOG_FLUSH_MS);
    };
    const saveSteps = () => this.repo.setSteps(row.id, steps).catch(() => undefined);
    const runStep = async (key: string, fn: () => Promise<string | null>) => {
      const step = steps.find((s) => s.key === key);
      if (!step) return;
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      await saveSteps();
      write(`\n▶ ${step.label}\n`);
      try {
        step.detail = await fn();
        step.status = 'ok';
      } catch (err) {
        step.status = 'failed';
        step.detail = errorText(err).slice(0, 300);
        throw err instanceof StepFailed ? err : new StepFailed(errorText(err));
      } finally {
        step.finishedAt = new Date().toISOString();
        await saveSteps();
      }
    };
    const exec = async (command: string, kind: MaintenanceKind) => {
      if (!session) throw new StepFailed('нет SSH-сессии');
      const res = await session.execStream(command, {
        timeoutMs: MAINTENANCE_TIMEOUT_MS[kind],
        onData: write,
        signal,
      });
      if (res.code !== 0) throw new StepFailed(`команда завершилась с кодом ${res.code}`);
    };
    const collect = async (): Promise<MaintenanceCheck> => {
      if (!session) throw new StepFailed('нет SSH-сессии');
      let out = '';
      const res = await session.execStream(checkScript(), {
        timeoutMs: MAINTENANCE_TIMEOUT_MS.check,
        onData: (chunk) => {
          out += chunk;
          if (out.length > 64 * 1024) out = out.slice(-64 * 1024);
        },
        signal,
      });
      if (res.code !== 0 || !out.includes('@@done=1'))
        throw new StepFailed('скрипт проверки не отработал до конца');
      return parseCheckOutput(out, null);
    };
    const describe = (c: MaintenanceCheck): string => {
      const parts: string[] = [];
      if (c.updates) parts.push(c.updates.total === 0 ? 'обновлений нет' : `обновлений: ${c.updates.total}`);
      if (c.rebootRequired) parts.push('нужна перезагрузка');
      if (c.disk.usedPct !== null) parts.push(`диск ${Math.round(c.disk.usedPct)}%`);
      return parts.join(' · ') || 'готово';
    };

    try {
      await runStep('connect', async () => {
        const { target } = await this.servers.sshTargetFor(row.serverId);
        session = await this.ssh.connect(target);
        write(`${target.user}@${target.host}:${target.port} · ключ сервера ${session.hostKeyFp}\n`);
        return `${target.host}:${target.port}`;
      });

      if (row.kind === 'check') {
        const collected: { check: MaintenanceCheck | null } = { check: null };
        await runStep('collect', async () => {
          const check = await collect();
          collected.check = check;
          for (const w of check.warnings) write(`! ${w}\n`);
          return describe(check);
        });
        await runStep('release', async () => {
          const latest = await this.releases.latest();
          if (collected.check) collected.check.agent.latest = latest;
          return latest ? `последняя ${latest}` : 'не удалось узнать';
        });
        if (collected.check) {
          await this.repo.saveCheck(row.serverId, collected.check);
          summary = {
            updates: collected.check.updates?.total ?? null,
            rebootRequired: collected.check.rebootRequired,
          };
        }
      } else {
        for (const spec of actionSteps(row.kind, this.config.get('AGENT_REPO'))) {
          await runStep(spec.key, async () => {
            await exec(spec.command, row.kind);
            return null;
          });
        }
        if (row.kind === 'agent_update') {
          // Считаем только heartbeat после перезапуска: старый агент мог отметиться во время скачивания.
          const installedAt = Date.now();
          await runStep('verify', async () => {
            const deadline = Date.now() + AGENT_WAIT_MS;
            while (Date.now() < deadline) {
              if (signal.aborted) throw new StepFailed('отменено');
              const srv = await this.serversRepo.findById(row.serverId);
              if (
                srv?.agentStatus === 'online' &&
                srv.agentLastSeenAt &&
                srv.agentLastSeenAt.getTime() >= installedAt
              ) {
                write(`агент в сети: ${srv.agentVersion ?? '?'}\n`);
                return srv.agentVersion ? `в сети · ${srv.agentVersion}` : 'в сети';
              }
              await new Promise((r) => setTimeout(r, 2000));
            }
            throw new StepFailed(
              'агент не вышел на связь за 45 с — проверьте journalctl -u nodeservice-agent',
            );
          });
        }
        await runStep('after', async () => {
          const check = await collect();
          check.agent.latest = await this.releases.latest();
          await this.repo.saveCheck(row.serverId, check);
          summary = { updates: check.updates?.total ?? null, rebootRequired: check.rebootRequired };
          return describe(check);
        });
      }
    } catch (err) {
      error = errorText(err);
      for (const s of steps) if (s.status === 'pending') s.status = 'skipped';
      write(`\n✗ ${error}\n`);
      if (row.kind === 'check') await this.repo.saveCheckError(row.serverId, error).catch(() => undefined);
    } finally {
      (session as SshSession | null)?.end();
      await flush();
    }

    const durationMs = Date.now() - startedAt;
    if (!error) write(`\n✓ Готово за ${Math.max(1, Math.round(durationMs / 1000))} с\n`);
    await flush();
    await this.repo.finishRun(row.id, error ? 'failed' : 'ok', steps, error);
    await this.audit.record({
      action: `server.maintenance.${row.kind}`,
      actor,
      source: actor.type === 'system' ? 'auto' : 'manual',
      result: error ? 'failed' : 'ok',
      severity: error ? 'warn' : 'info',
      target: { type: 'server', id: row.serverId, display: serverName },
      durationMs,
      metadata: {
        runId: row.id,
        kind: MAINTENANCE_KIND_LABELS[row.kind],
        ...summary,
        ...(error ? { error: error.slice(0, 300) } : {}),
      },
    });
  }
}

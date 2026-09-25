import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUTOFIX_GRACE_SECONDS,
  type AutofixPolicy,
  actionByKey,
  DEFAULT_AUTOFIX_POLICY,
  INCIDENT_CHAINS,
  INCIDENT_KIND_META,
  INCIDENT_KINDS,
  type Incident,
  type IncidentAnalysis,
  type IncidentEvent,
  type IncidentKind,
  type IncidentPolicyResponse,
  type IncidentPolicyUpdate,
  type IncidentsListResponse,
  incidentTitleToken,
  type NodeState,
  type ResolveIncidentRequest,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { IncidentRow, ServerRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { SettingsService } from '../settings/settings.service.js';
import { IncidentMetricsService } from './incident-metrics.service.js';
import { IncidentRunnerService } from './incident-runner.service.js';
import { IncidentsRepository } from './incidents.repository.js';

/** Гистерезис порогов: инцидент закрывается, когда метрика ушла ниже порога на столько процентов. */
export const INCIDENT_HYSTERESIS_PCT = 5;
/**
 * После старта API агенты переподключаются не мгновенно: пока панель обновлялась, все были
 * «не в сети». Столько после старта состояния связи не оцениваем, чтобы не заводить ложные инциденты.
 */
export const STARTUP_GRACE_MS = process.env.NODE_ENV === 'test' ? 0 : 3 * 60_000;
/** «Агент не в сети» — только если молчит дольше этого (короткий обрыв при обновлении — не инцидент). */
export const AGENT_OFFLINE_FOR_MS = process.env.NODE_ENV === 'test' ? 0 : 2 * 60_000;
/** Статистика действий на вкладке «Автопочинка» — за последние N дней. */
const STATS_DAYS = 30;

const now = () => new Date().toISOString();
const ev = (by: 'auto' | 'manual', action: string, result: IncidentEvent['result']): IncidentEvent => ({
  at: now(),
  by,
  action,
  result,
});

/** Инциденты: жизненный цикл, детекция правил с гистерезисом, реестр действий (исполнение — IncidentRunnerService). */
@Injectable()
export class IncidentsService {
  private readonly log = new Logger(IncidentsService.name);
  /** Момент первого превышения порога (server:kind) — для «времени реакции» без флаппинга. */
  private readonly exceededSince = new Map<string, number>();
  private readonly bootAt = Date.now();

  constructor(
    private readonly repo: IncidentsRepository,
    private readonly serversRepo: ServersRepository,
    private readonly settings: IncidentsSettingsStore,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditService,
    private readonly runner: IncidentRunnerService,
    private readonly metrics: IncidentMetricsService,
    private readonly notifications: NotificationsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  toDto(row: IncidentRow): Incident {
    return {
      id: row.id,
      serverId: row.serverId,
      serverName: row.serverName,
      kind: row.kind as IncidentKind,
      severity: row.severity as Incident['severity'],
      status: row.status as Incident['status'],
      title: row.title,
      detail: row.detail,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: (row.resolvedBy as Incident['resolvedBy']) ?? null,
      timeline: row.timeline,
      attempts: row.attempts,
      proposal: row.proposal ?? null,
      snapshot: row.snapshot ?? null,
      analysis: row.analysis ?? null,
    };
  }

  async list(status: 'all' | 'open' | 'resolved'): Promise<IncidentsListResponse> {
    // Вид, которого в контракте уже нет (после переименований), не должен ломать страницу целиком.
    const known = new Set<string>(INCIDENT_KINDS);
    const rows = (await this.repo.list(status)).filter((r) => known.has(r.kind));
    const open = (await this.repo.list('open')).length;
    const openRows = await this.repo.list('open');
    return {
      items: rows.map((r) => this.toDto(r)),
      counts: {
        open,
        crit: openRows.filter((r) => r.severity === 'crit').length,
        warn: openRows.filter((r) => r.severity === 'warn').length,
      },
    };
  }

  /** Записать разбор Джарвиса; false — инцидента уже нет (удалили во время разбора). */
  async saveAnalysis(id: string, analysis: IncidentAnalysis): Promise<boolean> {
    return (await this.repo.update(id, { analysis })) !== undefined;
  }

  /** После перезапуска панели разбор «идёт» вечно: помечаем такие оборванными. */
  async failRunningAnalyses(reason: string): Promise<number> {
    const rows = (await this.repo.list('all')).filter((r) => r.analysis?.status === 'running');
    for (const r of rows)
      await this.repo.update(r.id, {
        analysis: { ...(r.analysis as IncidentAnalysis), status: 'failed', finishedAt: now(), error: reason },
      });
    return rows.length;
  }

  async get(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    return this.toDto(row);
  }

  async acknowledge(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row.status !== 'open') return this.toDto(row);
    const updated = await this.repo.update(id, {
      status: 'acknowledged',
      timeline: [...row.timeline, ev('manual', 'Взято в работу администратором', 'notify')],
    });
    await this.audit.record({
      action: 'incident.acknowledged',
      target: { type: 'incident', id, display: row.title },
    });
    return this.toDto(updated ?? row);
  }

  /** Ручное закрытие администратором. */
  async resolveManual(id: string, opts: ResolveIncidentRequest = {}): Promise<Incident> {
    const row0 = await this.repo.findById(id);
    if (!row0) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row0.status === 'resolved') return this.toDto(row0);
    // Идущую попытку обрываем (она дописывает хронологию) и перечитываем, чтобы не затереть.
    await this.runner.cancelRunning(id, 'Прервано: инцидент закрыт администратором');
    const row = (await this.repo.findById(id)) ?? row0;
    // «Больше не следить за нодой на этом сервере»: без этого тот же инцидент откроется снова.
    const stopWatch = opts.stopNodeWatch === true && row.kind === 'node_down' && row.serverId !== null;
    if (stopWatch && row.serverId) await this.serversRepo.update(row.serverId, { nodeWatch: 'off' });
    const updated = await this.repo.update(id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'manual',
      proposal: null,
      timeline: [
        ...row.timeline,
        ...(stopWatch ? [ev('manual', 'Слежение за нодой на этом сервере выключено', 'notify')] : []),
        ev('manual', 'Закрыт администратором', 'resolved'),
      ],
    });
    if (row.serverId) this.exceededSince.delete(`${row.serverId}:${row.kind}`);
    await this.audit.record({
      action: 'incident.resolved',
      target: { type: 'incident', id, display: row.title },
      metadata: { by: 'manual', ...(stopWatch ? { stopNodeWatch: true, server: row.serverName } : {}) },
    });
    return this.toDto(updated ?? row);
  }

  /**
   * Удалить инцидент из истории. Открытый — сначала обрываем идущую попытку; если проблема
   * не ушла, детекция заведёт новый. Статистика «помогло N из M» этот инцидент больше не учитывает.
   */
  async delete(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    await this.runner.cancelRunning(id, 'Прервано: инцидент удалён');
    await this.repo.delete(id);
    if (row.serverId) this.exceededSince.delete(`${row.serverId}:${row.kind}`);
    await this.audit.record({
      action: 'incident.deleted',
      target: { type: 'incident', id, display: row.title },
      metadata: { kind: row.kind, status: row.status, server: row.serverName },
    });
  }

  /** Очистить историю: удалить все решённые инциденты. Открытые остаются. */
  async deleteResolved(): Promise<{ deleted: number }> {
    const deleted = await this.repo.deleteResolved();
    if (deleted > 0)
      await this.audit.record({
        action: 'incident.resolved.deleted',
        target: { type: 'incident', id: 'resolved', display: 'Решённые инциденты' },
        metadata: { deleted },
      });
    return { deleted };
  }

  /** Запустить действие реестра по инциденту (T1/T2). T3 панель не выполняет. */
  async runAction(id: string, key: Parameters<IncidentRunnerService['start']>[1]): Promise<Incident> {
    const row = await this.runner.start(id, key, 'manual');
    return this.toDto(row);
  }

  /** «Автопочинка»: политика по сигналам, цепочка шагов и статистика за STATS_DAYS дней. */
  async policy(): Promise<IncidentPolicyResponse> {
    const cfg = await this.settings.get();
    const since = Date.now() - STATS_DAYS * 86_400_000;
    const stats = new Map<string, { runs: number; helped: number; lastAt: string | null }>();
    for (const row of await this.repo.list('all'))
      for (const a of row.attempts) {
        if (new Date(a.startedAt).getTime() < since) continue;
        const st = stats.get(row.kind) ?? { runs: 0, helped: 0, lastAt: null };
        st.runs += 1;
        if (a.status === 'helped') st.helped += 1;
        if (!st.lastAt || a.startedAt > st.lastAt) st.lastAt = a.startedAt;
        stats.set(row.kind, st);
      }
    const paused =
      cfg.pausedUntil && new Date(cfg.pausedUntil).getTime() > Date.now() ? cfg.pausedUntil : null;
    return {
      autofixEnabled: cfg.autofixEnabled,
      pausedUntil: paused,
      cooldownMinutes: cfg.autofixCooldownMinutes,
      items: INCIDENT_KINDS.map((kind) => {
        const chain = INCIDENT_CHAINS[kind].map((key) => {
          const a = actionByKey(key);
          return { key, title: a.title, level: a.level };
        });
        return {
          kind,
          label: INCIDENT_KIND_META[kind].label,
          component: INCIDENT_KIND_META[kind].component,
          policy: (cfg.policy[kind] as AutofixPolicy | undefined) ?? DEFAULT_AUTOFIX_POLICY,
          autoAvailable: chain.some((c) => c.level === 'T1'),
          chain,
          stats: stats.get(kind) ?? { runs: 0, helped: 0, lastAt: null },
        };
      }),
    };
  }

  /** Политика по сигналам, общий тумблер и пауза. Пишется через настройки (diff в Журнале). */
  async updatePolicy(patch: IncidentPolicyUpdate): Promise<IncidentPolicyResponse> {
    const cfg = await this.settings.get();
    const policy = { ...cfg.policy, ...(patch.policy ?? {}) };
    await this.settingsService.updateIncidents({
      ...(patch.autofixEnabled !== undefined ? { autofixEnabled: patch.autofixEnabled } : {}),
      ...(patch.policy ? { policy } : {}),
      ...(patch.pauseMinutes !== undefined
        ? {
            pausedUntil:
              patch.pauseMinutes > 0
                ? new Date(Date.now() + patch.pauseMinutes * 60_000).toISOString()
                : null,
          }
        : {}),
    });
    return this.policy();
  }

  /* ---------- детекция (джоба) ---------- */

  async evaluate(latest: {
    cpu: Map<string, number>;
    mem: Map<string, number>;
    disk: Map<string, number>;
  }): Promise<void> {
    const cfg = await this.settings.get();
    const rows = await this.serversRepo.list();
    const connectivityReady = Date.now() - this.bootAt >= STARTUP_GRACE_MS;
    for (const server of rows) {
      if (connectivityReady) {
        const offlineLongEnough =
          server.agentStatus === 'offline' &&
          (!server.agentLastSeenAt || Date.now() - server.agentLastSeenAt.getTime() >= AGENT_OFFLINE_FOR_MS);
        await this.evalBinary(server, 'agent_offline', offlineLongEnough);
        await this.evalBinary(server, 'ssh_down', server.sshOk === false);
      }
      await this.evalNode(server);
      await this.evalThreshold(
        server,
        'cpu_high',
        latest.cpu.get(server.id),
        cfg.cpuPct,
        cfg.forDurationMinutes,
      );
      await this.evalThreshold(
        server,
        'mem_high',
        latest.mem.get(server.id),
        cfg.memPct,
        cfg.forDurationMinutes,
      );
      await this.evalThreshold(
        server,
        'disk_high',
        latest.disk.get(server.id),
        cfg.diskPct,
        cfg.forDurationMinutes,
      );
    }
    this.metrics.remember(latest);
    await this.runner.autoTick();
  }

  /** Зонд контейнера (NodeProbeJob или тест) сообщает состояние; отсюда решаем про инцидент. */
  recordNodeState(serverId: string, state: NodeState | null): void {
    this.metrics.setNodeState(serverId, state);
  }

  /**
   * Зонд увидел другое состояние контейнера — судим сразу, не дожидаясь тика: инцидент
   * открывается в момент сбоя, а после возврата контейнера закрывается сам. Состояние
   * запоминаем и в записи сервера — для значка на карточке и подсказки в настройке «Нода».
   */
  async probeNodeState(serverId: string, state: NodeState | null): Promise<void> {
    const changed = (this.metrics.nodeState(serverId) ?? null) !== state;
    this.recordNodeState(serverId, state);
    if (!changed) return;
    const server = await this.serversRepo.findById(serverId);
    if (!server) return;
    if ((server.nodeState ?? null) !== state) await this.serversRepo.update(serverId, { nodeState: state });
    await this.evalNode(server);
  }

  /**
   * Настройка сервера «Нода»: off — не судим и закрываем открытое; on — нода должна быть, и «контейнер
   * не найден» тоже сбой; auto — судим только найденный контейнер. Ждать здесь нечего: пауза
   * «вдруг поднимется само» — у автопочинки (AUTOFIX_GRACE_SECONDS), а не у детекции.
   */
  private async evalNode(server: ServerRow): Promise<void> {
    const existing = await this.repo.findOpen(server.id, 'node_down');
    const quiet = existing && !existing.attempts.some((a) => a.status === 'running');
    if (server.nodeWatch === 'off') {
      if (quiet)
        await this.autoResolve(existing, 'Слежение за нодой на этом сервере выключено — инцидент закрыт');
      return;
    }
    const state = this.metrics.nodeState(server.id);
    if (state === undefined) return;
    const down = state === 'stopped' || (state === 'none' && server.nodeWatch === 'on');
    if (down) {
      if (!existing)
        await this.openIncident(
          server,
          'node_down',
          state === 'none'
            ? 'Контейнер ноды не найден, хотя нода на этом сервере должна быть.'
            : 'Контейнер ноды остановлен или упал — нода не работает.',
        );
    } else if (quiet) {
      await this.autoResolve(existing);
    }
  }

  /** Мгновенное состояние (агент офлайн / SSH недоступен): без «времени реакции». */
  private async evalBinary(server: ServerRow, kind: IncidentKind, active: boolean): Promise<void> {
    const existing = await this.repo.findOpen(server.id, kind);
    if (active && !existing) await this.openIncident(server, kind, this.binaryDetail(kind));
    else if (!active && existing) await this.autoResolve(existing);
  }

  /** Пороговое состояние с «временем реакции»: держится дольше forDuration → инцидент. */
  private async evalThreshold(
    server: ServerRow,
    kind: IncidentKind,
    value: number | undefined,
    threshold: number,
    forMinutes: number,
  ): Promise<void> {
    const key = `${server.id}:${kind}`;
    const existing = await this.repo.findOpen(server.id, kind);
    if (value === undefined) {
      // Нет метрики (агент офлайн) — этим займётся agent_offline; порог не трогаем.
      this.exceededSince.delete(key);
      return;
    }
    if (value > threshold) {
      const since = this.exceededSince.get(key) ?? Date.now();
      this.exceededSince.set(key, since);
      if (!existing && Date.now() - since >= forMinutes * 60_000)
        await this.openIncident(
          server,
          kind,
          `${INCIDENT_KIND_META[kind].component} держится на ${Math.round(value)}% дольше ${forMinutes} мин (порог ${threshold}%).`,
        );
    } else if (value < threshold - INCIDENT_HYSTERESIS_PCT) {
      // Гистерезис: закрываем только когда метрика ушла заметно ниже порога, а не дрожит на нём.
      this.exceededSince.delete(key);
      if (existing && !existing.attempts.some((a) => a.status === 'running'))
        await this.autoResolve(existing);
    } else {
      this.exceededSince.delete(key);
    }
  }

  private binaryDetail(kind: IncidentKind): string {
    return kind === 'agent_offline'
      ? 'Агент не выходит на связь — панель не получает метрики.'
      : 'Панель не может подключиться к серверу по SSH.';
  }

  private async openIncident(server: ServerRow, kind: IncidentKind, detail: string): Promise<void> {
    const meta = INCIDENT_KIND_META[kind];
    const m = await this.metrics.latestFor(server.id).catch(() => undefined);
    const row = await this.repo.open({
      serverId: server.id,
      serverName: server.name,
      kind,
      severity: meta.severity,
      title: `${meta.label} · ${server.name}`,
      detail,
      timeline: [ev('auto', `Обнаружено: ${meta.label}`, 'detect')],
      snapshot: {
        cpu: m?.cpu ?? null,
        mem: m?.mem ?? null,
        disk: m?.disk ?? null,
        node: this.metrics.nodeState(server.id) ?? null,
        agentStatus: server.agentStatus,
        agentVersion: server.agentVersion,
      },
    });
    if (!row) return;
    // Проверку обслуживания запускаем сразу: к моменту, когда вы откроете инцидент, в нём уже
    // видно, сколько занято и что можно убрать.
    this.recheckMaintenance(server.id, kind);
    // Решаем сразу: предложение шага уходит своим уведомлением, автопочинка выжидает паузу —
    // тогда сообщаем об обнаружении и о том, что ждём. Без цепочки — просто сообщаем.
    const decision = await this.runner.onOpened(row);
    if (decision === 'waiting' || decision === 'none')
      await this.notifications.push({
        severity: meta.severity === 'crit' ? 'crit' : 'warn',
        title: incidentTitleToken(meta.label),
        server: { id: server.id, name: server.name },
        body:
          decision === 'waiting'
            ? `${detail} Ждём ${AUTOFIX_GRACE_SECONDS} с — возможно, поднимется само, иначе починим автоматически.`
            : detail,
        link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
      });
    await this.audit.record({
      action: 'incident.opened',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      severity: meta.severity === 'crit' ? 'crit' : 'warn',
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { server: server.name, kind },
    });
  }

  /**
   * Сигналы, по которым полезна свежая проверка обслуживания: она показывает, что именно занимает
   * место и что можно почистить. Ждать суточного расписания в такой момент бессмысленно.
   */
  private static readonly RECHECK_KINDS = new Set<IncidentKind>(['disk_high']);

  /** Проверка обслуживания вне расписания: только чтение, ошибки и занятость игнорируем. */
  private recheckMaintenance(serverId: string | null, kind: IncidentKind): void {
    if (!serverId || !IncidentsService.RECHECK_KINDS.has(kind)) return;
    void this.maintenance.scheduledCheck(serverId).catch(() => undefined);
  }

  private async autoResolve(row: IncidentRow, reason?: string): Promise<void> {
    await this.notifications.push({
      severity: 'ok',
      title: reason
        ? `${incidentTitleToken(INCIDENT_KIND_META[row.kind as IncidentKind].label)} — закрыт`
        : `${incidentTitleToken(INCIDENT_KIND_META[row.kind as IncidentKind].label)} — проблема исчезла`,
      ...(row.serverId ? { server: { id: row.serverId, name: row.serverName } } : {}),
      body: reason ?? 'Инцидент закрыт автоматически.',
      link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
    });
    await this.repo.update(row.id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'auto',
      timeline: [...row.timeline, ev('auto', reason ?? 'Проблема исчезла — инцидент закрыт', 'resolved')],
    });
    await this.audit.record({
      action: 'incident.resolved',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { by: 'auto' },
    });
    // Место освободилось — обновим карточку обслуживания, иначе там останется старое «диск 92 %».
    this.recheckMaintenance(row.serverId, row.kind as IncidentKind);
  }
}

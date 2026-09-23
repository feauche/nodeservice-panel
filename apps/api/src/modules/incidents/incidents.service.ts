import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  INCIDENT_ACTIONS,
  INCIDENT_CHAINS,
  INCIDENT_KIND_META,
  INCIDENT_KINDS,
  type Incident,
  type IncidentActionsResponse,
  type IncidentActionsUpdate,
  type IncidentEvent,
  type IncidentKind,
  type IncidentsListResponse,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { IncidentRow, ServerRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
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
/** «Контейнер ноды не запущен» — если контейнер не работает дольше этого (перезапуск длится секунды). */
export const NODE_DOWN_FOR_MS = process.env.NODE_ENV === 'test' ? 0 : 45_000;
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
  /** Серверы, где панель хоть раз видела запущенный контейнер ноды: только для них его остановка — инцидент. */
  private readonly nodeSeen = new Set<string>();

  constructor(
    private readonly repo: IncidentsRepository,
    private readonly serversRepo: ServersRepository,
    private readonly settings: IncidentsSettingsStore,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditService,
    private readonly runner: IncidentRunnerService,
    private readonly metrics: IncidentMetricsService,
    private readonly notifications: NotificationsService,
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
  async resolveManual(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row.status === 'resolved') return this.toDto(row);
    const updated = await this.repo.update(id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'manual',
      timeline: [...row.timeline, ev('manual', 'Закрыт администратором', 'resolved')],
    });
    if (row.serverId) this.exceededSince.delete(`${row.serverId}:${row.kind}`);
    await this.audit.record({
      action: 'incident.resolved',
      target: { type: 'incident', id, display: row.title },
      metadata: { by: 'manual' },
    });
    return this.toDto(updated ?? row);
  }

  /** Запустить действие реестра по инциденту (T1/T2). T3 панель не выполняет. */
  async runAction(id: string, key: Parameters<IncidentRunnerService['start']>[1]): Promise<Incident> {
    const row = await this.runner.start(id, key, 'manual');
    return this.toDto(row);
  }

  /** Вкладка «Автопочинка»: реестр с тумблерами и статистикой за STATS_DAYS дней. */
  async actions(): Promise<IncidentActionsResponse> {
    const cfg = await this.settings.get();
    const since = Date.now() - STATS_DAYS * 86_400_000;
    const stats = new Map<string, { runs: number; helped: number; lastAt: string | null }>();
    for (const row of await this.repo.list('all'))
      for (const a of row.attempts) {
        if (new Date(a.startedAt).getTime() < since) continue;
        const st = stats.get(a.action) ?? { runs: 0, helped: 0, lastAt: null };
        st.runs += 1;
        if (a.status === 'helped') st.helped += 1;
        if (!st.lastAt || a.startedAt > st.lastAt) st.lastAt = a.startedAt;
        stats.set(a.action, st);
      }
    return {
      autofixEnabled: cfg.autofixEnabled,
      cooldownMinutes: cfg.autofixCooldownMinutes,
      items: INCIDENT_ACTIONS.map((a) => ({
        key: a.key,
        title: a.title,
        level: a.level,
        kinds: [...a.kinds],
        summary: a.summary,
        consequence: a.consequence,
        preconditions: [...a.preconditions],
        postcheck: a.postcheck,
        rollbackNote: a.rollbackNote,
        terminal: a.terminal,
        enabled: a.level === 'T1' && cfg.actions[a.key] === true,
        stats: stats.get(a.key) ?? { runs: 0, helped: 0, lastAt: null },
      })),
    };
  }

  /** Тумблеры вкладки: общий «автопочинка» и по T1-действиям. Пишется через настройки (diff в Журнале). */
  async updateActions(patch: IncidentActionsUpdate): Promise<IncidentActionsResponse> {
    const cfg = await this.settings.get();
    const actions = { ...cfg.actions };
    for (const [k, v] of Object.entries(patch.actions ?? {})) {
      const meta = INCIDENT_ACTIONS.find((a) => a.key === k);
      if (meta?.level === 'T1') actions[k] = v;
    }
    await this.settingsService.updateIncidents({
      ...(patch.autofixEnabled !== undefined ? { autofixEnabled: patch.autofixEnabled } : {}),
      actions,
    });
    return this.actions();
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
  recordNodeState(serverId: string, running: boolean | undefined): void {
    this.metrics.setNodeRunning(serverId, running);
    if (running) this.nodeSeen.add(serverId);
  }

  /**
   * Контейнер ноды не работает дольше NODE_DOWN_FOR_MS → инцидент; снова работает → закрываем.
   * Судим только серверы, где контейнер хоть раз видели запущенным: на остальных его просто нет.
   */
  private async evalNode(server: ServerRow): Promise<void> {
    const key = `${server.id}:node_down`;
    const running = this.metrics.nodeRunning(server.id);
    const existing = await this.repo.findOpen(server.id, 'node_down');
    if (running === undefined || (!this.nodeSeen.has(server.id) && !existing)) {
      this.exceededSince.delete(key);
      return;
    }
    if (!running) {
      const since = this.exceededSince.get(key) ?? Date.now();
      this.exceededSince.set(key, since);
      if (!existing && Date.now() - since >= NODE_DOWN_FOR_MS)
        await this.openIncident(
          server,
          'node_down',
          'Контейнер remnanode остановлен или упал — нода не работает.',
        );
    } else {
      this.exceededSince.delete(key);
      if (existing && !existing.attempts.some((a) => a.status === 'running'))
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
    const row = await this.repo.open({
      serverId: server.id,
      serverName: server.name,
      kind,
      severity: meta.severity,
      title: `${meta.label} · ${server.name}`,
      detail,
      timeline: [ev('auto', `Обнаружено: ${meta.label}`, 'detect')],
    });
    // Есть цепочка починки — уведомление пришлёт исполнитель одним сообщением («чиню» или «ждёт подтверждения»),
    // иначе было бы два подряд. Без цепочки (SSH недоступен) — сообщаем здесь.
    if (row && INCIDENT_CHAINS[kind].length === 0)
      await this.notifications.push({
        severity: meta.severity === 'crit' ? 'crit' : 'warn',
        title: row.title,
        body: detail,
        link: { to: `/incidents?open=${row.id}`, label: 'Открыть инцидент' },
      });
    if (row)
      await this.audit.record({
        action: 'incident.opened',
        actor: SYSTEM_ACTOR,
        source: 'auto',
        severity: meta.severity === 'crit' ? 'crit' : 'warn',
        target: { type: 'incident', id: row.id, display: row.title },
        metadata: { server: server.name, kind },
      });
  }

  private async autoResolve(row: IncidentRow): Promise<void> {
    await this.notifications.push({
      severity: 'ok',
      title: `${row.title} — проблема исчезла`,
      body: 'Инцидент закрыт автоматически.',
      link: { to: `/incidents?open=${row.id}`, label: 'Открыть инцидент' },
    });
    await this.repo.update(row.id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'auto',
      timeline: [...row.timeline, ev('auto', 'Проблема исчезла — инцидент закрыт', 'resolved')],
    });
    await this.audit.record({
      action: 'incident.resolved',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { by: 'auto' },
    });
  }
}

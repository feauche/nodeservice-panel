import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AutofixPolicy,
  actionByKey,
  DEFAULT_AUTOFIX_POLICY,
  INCIDENT_CHAINS,
  INCIDENT_KIND_META,
  INCIDENT_KINDS,
  INCIDENTS_PAGE_SIZE_DEFAULT,
  type Incident,
  type IncidentEvent,
  type IncidentKind,
  type IncidentPolicyResponse,
  type IncidentPolicyUpdate,
  type IncidentsListResponse,
  type IncidentWeekStats,
  incidentWeekStats,
  type ResolveIncidentRequest,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { IncidentRow } from '../../infra/db/schema/index.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { SettingsService } from '../settings/settings.service.js';
import { IncidentRunnerService } from './incident-runner.service.js';
import { IncidentsRepository } from './incidents.repository.js';

/** Статистика действий на вкладке «Автопочинка» — за последние N дней. */
const STATS_DAYS = 30;

const now = () => new Date().toISOString();
const ev = (by: 'auto' | 'manual', action: string, result: IncidentEvent['result']): IncidentEvent => ({
  at: now(),
  by,
  action,
  result,
});

/**
 * Инциденты: чтение, ручное закрытие и удаление, политика автопочинки. Новые дела по нодам заводит
 * FleetMonitorJob прямо через IncidentsRepository.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly repo: IncidentsRepository,
    private readonly serversRepo: ServersRepository,
    private readonly settings: IncidentsSettingsStore,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditService,
    private readonly runner: IncidentRunnerService,
    private readonly notifications: NotificationsService,
  ) {}

  toDto(row: IncidentRow): Incident {
    return {
      id: row.id,
      nodeUuid: row.nodeUuid ?? null,
      diagnostics: row.diagnostics ?? null,
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

  /**
   * `opts` не задан — вернуть список целиком (так его читают внутренние службы: джобы, ассистент).
   * `opts` задан (всегда так с HTTP-ручки, там page/pageSize приходят со значениями по умолчанию) —
   * настоящая постраничная выдача; «открытые» всё равно приходят целиком независимо от opts.
   */
  /** Итог за 7 дней для полосы над реестром — считается здесь, страница не тянет сами инциденты. */
  async weekStats(): Promise<IncidentWeekStats> {
    const now = Date.now();
    const rows = await this.repo.weekRows(new Date(now - 7 * 86_400_000));
    return incidentWeekStats(
      rows.map((r) => ({
        status: r.status as Incident['status'],
        openedAt: r.openedAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy as Incident['resolvedBy'],
        attempts: r.attempts,
      })),
      now,
    );
  }

  async list(
    status: 'all' | 'open' | 'resolved',
    opts?: {
      openedFrom?: string | undefined;
      page?: number;
      pageSize?: number;
      offset?: number | undefined;
    },
  ): Promise<IncidentsListResponse> {
    // Вид, которого в контракте уже нет (после переименований), не должен ломать страницу целиком. Постранично
    // такие записи отбирает сам запрос (и в счёте, и в выборке) — иначе сдвинулось бы листание по смещению;
    // целиком — отбираем здесь, до подсчёта.
    const known = new Set<string>(INCIDENT_KINDS);
    const counts = await this.repo.counts();
    const page = opts
      ? await this.repo.listPage({
          status,
          openedFrom: opts.openedFrom,
          page: opts.page ?? 1,
          pageSize: opts.pageSize ?? INCIDENTS_PAGE_SIZE_DEFAULT,
          offset: opts.offset,
        })
      : await (async () => {
          const rows = (await this.repo.list(status)).filter((r) => known.has(r.kind));
          return {
            items: rows,
            page: 1,
            pageSize: Math.max(rows.length, 1),
            total: rows.length,
            totalPages: rows.length > 0 ? 1 : 0,
          };
        })();
    return {
      items: page.items.map((r) => this.toDto(r)),
      counts,
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages,
    };
  }

  async get(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Событие не найдено.' });
    return this.toDto(row);
  }

  async acknowledge(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Событие не найдено.' });
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
    if (!row0) throw problem(HttpStatus.NOT_FOUND, { detail: 'Событие не найдено.' });
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
    // Тревога в Telegram могла ещё ждать разбора: дело закрыто в панели — присылать её уже незачем.
    await this.notifications.dropDeferred(id);
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
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Событие не найдено.' });
    await this.runner.cancelRunning(id, 'Прервано: инцидент удалён');
    await this.repo.delete(id);
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

  /** «Автопочинка»: политика по сигналам, цепочка шагов и статистика за STATS_DAYS дней. */
  async policy(): Promise<IncidentPolicyResponse> {
    const cfg = await this.settings.get();
    const stats = new Map<string, { runs: number; helped: number; lastAt: string | null }>();
    for (const row of await this.repo.actionStatsSince(new Date(Date.now() - STATS_DAYS * 86_400_000)))
      stats.set(row.kind, { runs: row.runs, helped: row.helped, lastAt: row.lastAt });
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
}

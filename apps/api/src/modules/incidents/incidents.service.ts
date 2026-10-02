import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActionKey,
  AUTOFIX_GRACE_SECONDS,
  type AutofixPolicy,
  actionByKey,
  DEFAULT_AUTOFIX_POLICY,
  INCIDENT_CHAINS,
  INCIDENT_KIND_META,
  INCIDENT_KINDS,
  INCIDENTS_PAGE_SIZE_DEFAULT,
  type Incident,
  type IncidentAnalysis,
  type IncidentEvent,
  type IncidentKind,
  type IncidentPolicyResponse,
  type IncidentPolicyUpdate,
  type IncidentsListResponse,
  type IncidentWeekStats,
  incidentTitleToken,
  incidentWeekStats,
  type NodeState,
  type ResolveIncidentRequest,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { tcpOpen } from '../../common/net/tcp-open.js';
import type { IncidentRow, ServerRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { PanelAlertsService } from '../health/panel-alerts.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { SettingsService } from '../settings/settings.service.js';
import { type CountryReach, countryReachLines } from './block-check.logic.js';
import { egressText } from './egress-check.logic.js';
import { EgressCheckService } from './egress-check.service.js';
import { IncidentMetricsService } from './incident-metrics.service.js';
import { IncidentRunnerService } from './incident-runner.service.js';
import { IncidentsRepository } from './incidents.repository.js';
import { type CountryReachResult, NodeBlockCheckService } from './node-block-check.service.js';
import {
  type FleetWhat,
  NO_PAYMENT_FACTS,
  type PaymentFacts,
  type PaymentPicture,
  paymentConclusion,
  paymentLines,
  serverDownLabel,
} from './payment-hint.js';

/** Гистерезис порогов: инцидент закрывается, когда метрика ушла ниже порога на столько процентов. */
export const INCIDENT_HYSTERESIS_PCT = 5;
/**
 * После старта API агенты переподключаются не мгновенно: пока панель обновлялась, все были
 * «не в сети». Столько после старта состояния связи не оцениваем, чтобы не заводить ложные инциденты.
 */
export const STARTUP_GRACE_MS = process.env.NODE_ENV === 'test' ? 0 : 3 * 60_000;
/** «Агент не в сети» — только если молчит дольше этого (короткий обрыв при обновлении — не инцидент). */
export const AGENT_OFFLINE_FOR_MS = process.env.NODE_ENV === 'test' ? 0 : 2 * 60_000;
/**
 * «SSH недоступен» — только если SSH не отвечает дольше этого и неудачу подтвердили повторные проверки:
 * одна неудачная попытка (потеря пакетов, отказ sshd из-за ботов) — ещё не «недоступен».
 */
export const SSH_DOWN_FOR_MS = process.env.NODE_ENV === 'test' ? 0 : 2 * 60_000;
/** Сколько держим ответ проверки порта SSH, пока агент молчит. */
const HOST_PROBE_TTL_MS = 60_000;
/** Проверка порта «из каждой страны» — раз в 3 минуты на сервер. */
const REACH_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 3 * 60_000;
/** Сетевые перепроверки разных серверов: быстрее последовательного обхода, без SSH-шторма по всему парку. */
const CONNECTIVITY_CONCURRENCY = 4;
/** Массовая потеря хотя бы половины наблюдаемого парка — сначала один системный сбой, не десятки дел. */
const FLEET_BLIND_MIN_SERVERS = 3;
const FLEET_BLIND_RATIO = 0.5;
/** Связь пропала с другими серверами за это время — сбой считается одновременным: общая причина. */
const FLEET_WINDOW_MS = 30 * 60_000;
/** Дело о падении онлайна узнаётся по первой строке текста: «Онлайн: 396 → 0 …». */
const ONLINE_DROP_RE = /Онлайн:\s*\d+\s*→/;

/** Что ещё сломалось у других за то же время (см. `IncidentsService.fleetTrouble`). */
export interface FleetTrouble {
  /** У скольких других нод упал онлайн — всего, вместе с нодами, у которых нет сервера в панели. */
  nodes: number;
  /** Из них нод с сервером в панели: про них точно известно, что это другая машина. */
  linkedNodes: number;
  /** Со сколькими другими серверами пропала связь: замолчал агент или открыто «Сервер недоступен». */
  servers: number;
}
/** Почему из других стран никто не проверил порт — настоящая причина, а не «проверить не с чего» на все случаи. */
const COUNTRY_BLIND: Record<NonNullable<CountryReachResult['blind']>, string> = {
  no_port: 'Проверить из других стран не с чего: нет серверов парка с известной страной и рабочим SSH.',
  no_probers: 'Проверить из других стран не с чего: нет серверов парка с известной страной и рабочим SSH.',
  bad_address: 'Проверить из других стран нельзя: адрес сервера записан с недопустимыми знаками.',
  ssh: 'Проверить из других стран не удалось: панель не зашла ни на один сервер парка — возможно, связь пропала у самой панели.',
  no_answer:
    'Проверить из других стран не удалось: команда проверки на серверах парка не вернула результата.',
  // У проверки порта SSH этих причин не бывает (порт сервера панель знает сама) — строки для полноты набора.
  remnawave: 'Проверить из других стран не удалось.',
  gone: 'Проверить из других стран не удалось.',
};
/** Начало текста дела «Недоступен из части сетей» — по нему его узнаём среди «Похоже на блокировку». */
export const PARTIAL_MARK = 'Недоступен из части сетей:';
/**
 * Начало причины закрытия, когда дело не решилось, а влилось в другое. По нему отличаем слияние от
 * настоящего закрытия: если тревога о таком деле ещё не ушла в Telegram, она снимается молча — о сбое
 * расскажет главное дело. Причина звучит иначе — уйдёт обычное сообщение о закрытии, ничего не потеряется.
 */
const MERGED_MARK = 'Объединено с делом';
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
  /** Момент первого превышения порога (server:kind) — для «времени реакции» без флаппинга. */
  private readonly exceededSince = new Map<string, number>();
  /** С какой неудачной проверки SSH у сервера идёт серия неудач (без единого успеха). */
  private readonly sshDownSince = new Map<string, number>();
  /** Два независимых одинаковых сетевых снимка подряд защищают от флаппинга одного проверяющего. */
  private readonly reachStable = new Map<
    string,
    { sampleAt: number; signature: string; consecutive: number }
  >();
  /** Только для подменённой проверки в unit-тестах; в работе время снимка берётся из reachCache. */
  private syntheticReachSample = 0;
  /** Порог «SSH недоступен»; в e2e подменяется, как probeHost. */
  sshDownForMs = SSH_DOWN_FOR_MS;
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
    private readonly billing: BillingService,
    private readonly servers: ServersService,
    private readonly blockCheck: NodeBlockCheckService,
    private readonly egress: EgressCheckService,
    private readonly panelAlerts: PanelAlertsService,
  ) {}

  /**
   * Сколько автоматических разборов ещё можно начать в этот час. Сообщает служба разбора при запуске (она
   * в модуле Джарвиса и сама ведёт свой лимит); пока не сообщила — считаем, что место есть.
   */
  autoAnalysisRoom: () => number = () => 1;

  /**
   * Джарвис сам разберёт новое дело (включены «Разбор» и «Автоматический разбор»): тогда сообщение в
   * Telegram ждёт разбора и уходит уже с его выводом (решение владельца 29.09.2026). Лимит разборов в
   * час исчерпан — разбор не начнётся, и ждать его сообщению незачем.
   */
  async analysisWillFollow(): Promise<boolean> {
    const a = await this.settingsService.getAssistant().catch(() => null);
    if (!(a?.enabled && a.permissions.analysis && a.permissions.autoAnalysis)) return false;
    return this.autoAnalysisRoom() > 0;
  }

  /**
   * Оплаты сервера в окне оплаты (срок прошёл или наступит в ближайшие сутки) — факты для текста дела.
   * null — «Биллинг» не ответил: дело заводится без них, и про оплату панель ничего не утверждает.
   */
  async paymentWindowFor(serverId: string): Promise<PaymentFacts | null> {
    return this.billing
      .paymentWindowForServer(serverId)
      .then((w) => ({
        overdue: w.overdue.map((f) => ({ kind: f.kind, text: f.text })),
        dueSoon: w.dueSoon.map((f) => ({ kind: f.kind, text: f.text })),
        paying: w.paying,
      }))
      .catch(() => null);
  }

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

  /** Закрыть инцидент как «поднялось само» по id — для внешних служб (например, перепроверка блокировки). */
  async autoResolveById(id: string, reason: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row || row.status === 'resolved') return;
    await this.autoResolve(row, reason);
  }

  /** Записать разбор Джарвиса; false — инцидента уже нет (удалили во время разбора). */
  async saveAnalysis(id: string, analysis: IncidentAnalysis): Promise<boolean> {
    return (await this.repo.update(id, { analysis })) !== undefined;
  }

  /** Ход идущего разбора; false — инцидента уже нет или этот разбор отменили (или запустили заново). */
  async saveRunningAnalysis(id: string, startedAt: string, analysis: IncidentAnalysis): Promise<boolean> {
    return this.repo.updateRunningAnalysis(id, startedAt, analysis);
  }

  /** После перезапуска панели разбор «идёт» вечно: помечаем такие оборванными. */
  async failRunningAnalyses(reason: string): Promise<number> {
    const rows = await this.repo.withRunningAnalysis();
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

  /* ---------- детекция (джоба) ---------- */

  async evaluate(latest: {
    cpu: Map<string, number>;
    mem: Map<string, number>;
    disk: Map<string, number>;
  }): Promise<void> {
    const cfg = await this.settings.get();
    const rows = await this.serversRepo.list();
    const connectivityReady = Date.now() - this.bootAt >= STARTUP_GRACE_MS;
    // Сначала правила, которые читают уже готовые данные. Долгая сеть одного сервера не должна задерживать
    // порог диска другого сервера и очередной тик автопочинки.
    for (const server of rows) {
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

    if (connectivityReady) {
      const offline = rows.filter(
        (server) =>
          server.agentStatus === 'offline' &&
          (!server.agentLastSeenAt || Date.now() - server.agentLastSeenAt.getTime() >= AGENT_OFFLINE_FOR_MS),
      );
      const observed = rows.filter((server) => server.agentStatus !== 'not_installed').length;
      // При одновременной потере большей части агентов сначала проверяем сам обзор панели. Раньше каждый
      // сервер успевал открыть своё дело, а после восстановления 10–20 накопленных тревог уходили в Telegram.
      if (
        offline.length >= FLEET_BLIND_MIN_SERVERS &&
        observed > 0 &&
        offline.length / observed >= FLEET_BLIND_RATIO &&
        (await this.massConnectivityBlind(offline))
      ) {
        await this.cancelFreshConnectivityIncidents(offline);
        await this.panelAlerts.connectivityDown(offline.length).catch(() => undefined);
        return;
      }
      let cursor = 0;
      let panelBlind = 0;
      const worker = async () => {
        while (cursor < rows.length) {
          const server = rows[cursor++];
          if (!server) return;
          const offlineLongEnough =
            server.agentStatus === 'offline' &&
            (!server.agentLastSeenAt ||
              Date.now() - server.agentLastSeenAt.getTime() >= AGENT_OFFLINE_FOR_MS);
          if ((await this.evalConnectivity(server, offlineLongEnough)) === 'panel_blind') panelBlind += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONNECTIVITY_CONCURRENCY, rows.length) }, worker));
      const report =
        panelBlind > 0 ? this.panelAlerts.connectivityDown(panelBlind) : this.panelAlerts.connectivityUp();
      await report.catch(() => undefined);
    }
  }

  /**
   * Массовый предохранитель: панель не видит напрямую ни один из одновременно пропавших серверов, а
   * перекрёстная проверка тоже не нашла ни одного открытого порта. Это один сбой наблюдения/площадки;
   * объявлять каждый сервер выключенным до следующего независимого снимка нельзя.
   */
  private async massConnectivityBlind(offline: ServerRow[]): Promise<boolean> {
    const direct = await Promise.all(offline.map((server) => this.hostAnswers(server)));
    if (direct.some(Boolean)) return false;
    const samples = offline.slice(0, Math.min(3, offline.length));
    const remote = await Promise.all(samples.map((server) => this.countryReachCached(server)));
    return remote.every((reach) => !reach.results.some((result) => result.open));
  }

  /**
   * Если массовая картина сложилась не в один тик, ранние серверы могли уже успеть открыть отдельные дела.
   * Закрываем только дела этой же свежей волны, без ложного «Починилось», и чистим их очередь Telegram.
   */
  private async cancelFreshConnectivityIncidents(offline: ServerRow[]): Promise<void> {
    const ids = new Set(offline.map((server) => server.id));
    const starts = offline
      .map((server) => server.agentLastSeenAt?.getTime() ?? Date.now())
      .filter(Number.isFinite);
    const waveStartedAt = Math.min(...starts) - AGENT_OFFLINE_FOR_MS;
    for (const row of await this.repo.list('open')) {
      if (!row.serverId || !ids.has(row.serverId) || row.openedAt.getTime() < waveStartedAt) continue;
      if (!['server_down', 'agent_offline', 'ssh_down', 'node_blocked'].includes(row.kind)) continue;
      await this.notifications.cancelIncidentDeliveries(row.id);
      await this.repo.update(row.id, {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: 'auto',
        proposal: null,
        timeline: [
          ...row.timeline,
          ev(
            'auto',
            'Отменено: одновременно пропало наблюдение за большей частью парка; отдельный сбой сервера не подтверждён',
            'resolved',
          ),
        ],
      });
    }
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
    const down =
      state === 'stopped' ||
      state === 'restarting' ||
      state === 'docker_down' ||
      (state === 'none' && server.nodeWatch === 'on');
    if (down) {
      if (!existing)
        await this.openIncident(
          server,
          'node_down',
          state === 'none'
            ? 'Контейнер ноды не найден, хотя нода на этом сервере должна быть.'
            : state === 'docker_down'
              ? 'Служба Docker на сервере не отвечает — состояние контейнера проверить нельзя, нода не работает.'
              : state === 'restarting'
                ? 'Контейнер ноды падает при запуске и перезапускается по кругу — нода не работает.'
                : 'Контейнер ноды остановлен или упал — нода не работает.',
        );
    } else if (quiet) {
      await this.autoResolve(existing);
    }
  }

  /** Проверка порта SSH с панели; в e2e подменяется. Ответ держим минуту, чтобы не стучаться каждый тик. */
  probeHost: (host: string, port: number) => Promise<boolean> = (host, port) => tcpOpen(host, port);
  private readonly hostCache = new Map<string, { at: number; ok: boolean }>();

  private async hostAnswers(server: ServerRow): Promise<boolean> {
    const hit = this.hostCache.get(server.id);
    if (hit && Date.now() - hit.at < HOST_PROBE_TTL_MS) return hit.ok;
    const ok = await this.probeHost(server.host, server.port).catch(() => false);
    this.hostCache.set(server.id, { at: Date.now(), ok });
    return ok;
  }

  /**
   * Связь с сервером — одним делом, а не тремя (решение владельца 29.09.2026). Агент замолчал — сначала
   * проверяем сам сервер: порт SSH не открывается или SSH не пускает → «Сервер недоступен» (агент и SSH —
   * следствия, переустанавливать агента бессмысленно). Сервер отвечает, а агент молчит → «Агент не в сети»
   * с переустановкой. SSH не пускает при живом агенте → «SSH недоступен». Уже открытые «Агент не в сети»,
   * «SSH недоступен» и «Похоже на блокировку» при недоступном сервере сливаются в одно дело.
   */
  private async evalConnectivity(
    server: ServerRow,
    agentOff: boolean,
  ): Promise<'checked' | 'panel_blind' | 'coverage_blind'> {
    const sshDown = server.sshOk === false;
    const sshConfirmed = this.sshDownConfirmed(server);
    const hostDown = agentOff ? !(await this.hostAnswers(server)) : false;
    const suspect = agentOff && (hostDown || sshDown);
    if (!suspect) this.reachStable.delete(server.id);
    // С панели не достучаться — это ещё не «сервер лёг»: панель смотрит из одной сети. Спрашиваем по
    // серверу парка в каждой стране; открыт хоть откуда-то — сервер жив, закрыт путь из части сетей.
    const reach = suspect ? await this.countryReachCached(server) : null;
    const seen = reach?.results ?? [];
    const anyOpen = seen.some((r) => r.open);
    // Открыт отовсюду, включая саму панель, — сервер жив и дорога к нему есть: это не «часть сетей», а
    // обычные «Агент не в сети» и «SSH недоступен».
    const allOpen = anyOpen && !hostDown && seen.every((r) => r.open);
    const partial = anyOpen && !allOpen;
    // Пустой список означает «проверка не состоялась», а не «все подтвердили недоступность».
    // Иначе обрыв исходящей сети самой панели превращается в критичный инцидент на каждом сервере.
    const serverDown = suspect && seen.length > 0 && !anyOpen;
    /** Среди проверяющих есть зарубежный: только тогда «не отвечает ни из одной страны» — проверенный факт. */
    const abroad = seen.some((r) => r.country !== null && r.country !== 'RU');
    const open = await this.repo.findOpen(server.id, 'server_down');
    if (suspect && seen.length === 0) {
      const panelBlind = reach?.blind === 'ssh' || reach?.blind === 'no_answer';
      if (!panelBlind) {
        // Проверяющих нет или адрес нельзя проверить: честно оставляем прежнее дело без изменения,
        // но отдельные подтверждённые сигналы агента и SSH по-прежнему записываем.
        const agentBack = server.agentStatus === 'online' || server.agentStatus === 'not_installed';
        await this.evalBinary(server, 'agent_offline', agentOff, agentBack);
        await this.evalBinary(server, 'ssh_down', sshConfirmed, !sshDown);
      }
      return panelBlind ? 'panel_blind' : 'coverage_blind';
    }
    if (suspect) {
      const signature = `${hostDown ? 'panel-closed' : 'panel-open'}|${seen
        .map((r) => `${r.from}:${r.country ?? '-'}:${r.open ? 'open' : 'closed'}`)
        .sort()
        .join('|')}`;
      const sampleAt = this.reachCache.get(server.id)?.at ?? ++this.syntheticReachSample;
      const prev = this.reachStable.get(server.id);
      const consecutive =
        prev?.signature === signature ? prev.consecutive + (prev.sampleAt === sampleAt ? 0 : 1) : 1;
      this.reachStable.set(server.id, { sampleAt, signature, consecutive });
      // Один свежий снимок ещё не открывает, не закрывает и не меняет вид дела. Потеря одной точки
      // проверки поэтому не вызывает цепочку «починилось → сервер недоступен → починилось».
      if (consecutive < 2) return 'checked';
    }
    await this.evalPartialReach(server, partial, seen, !hostDown, {
      serverDown,
      agentOnline: server.agentStatus === 'online',
      sshDown,
    });
    if (partial) {
      if (open && !open.attempts.some((a) => a.status === 'running'))
        await this.autoResolve(
          open,
          'Сервер жив: порт SSH открыт из части стран — это не отключение, а недоступность из части сетей (отдельное дело).',
        );
      return 'checked';
    }
    if (serverDown) {
      // Порт SSH с панели открывается — сервер включён: «выключен» и «проверьте оплату» тут были бы неправдой.
      const why = hostDown
        ? `Сервер не отвечает: агент молчит, порт SSH ${server.host}:${server.port} не открывается. Обычно это значит, что сервер выключен, завис или отрезан у хостера — проверьте в панели хостера и оплату. Агент и SSH — следствие, переустанавливать агента бессмысленно.`
        : `Сервер не отвечает панели: агент молчит и по SSH панель зайти не может, хотя порт SSH ${server.host}:${server.port} с панели открывается. Сервер включён — скорее всего, он завис или не пускает панель по SSH (сменился ключ или пароль, доступ закрыт файрволом). Проверьте сервер в панели хостера; переустанавливать агента бессмысленно, пока панель не может зайти по SSH.`;
      const pay = (open ? null : await this.paymentWindowFor(server.id)) ?? NO_PAYMENT_FACTS;
      // Об оплате — только когда порт не открывается и с панели. Сбой сразу у нескольких серверов — общая
      // причина вероятнее. Из других стран порт не проверен — сервер не отвечает только самой панели:
      // причину не называем, оплату просим проверить.
      let picture: PaymentPicture | null = null;
      let fleetWhat: FleetWhat | undefined;
      if (hostDown && !open) {
        // Дела без сервера (нода, которую панель не нашла среди серверов) здесь не считаем: это может быть
        // нода этой же машины, и один сбой посчитался бы дважды.
        const fleet = await this.fleetTrouble({ serverId: server.id, names: [server.name] });
        if (fleet.servers > 0) fleetWhat = 'link';
        else if (fleet.linkedNodes > 0) fleetWhat = 'online';
        // «Вероятнее всего» — только если порт не открылся и из-за рубежа: проверяли одни российские серверы —
        // блокировку адреса из России так не отличить, оплату просим проверить, но причиной не называем.
        picture = fleetWhat ? 'fleet-down' : seen.length === 0 ? 'panel-only' : abroad ? 'down' : 'ru-only';
      }
      const payHint = picture ? paymentConclusion(pay, picture, fleetWhat) : null;
      const reachBlock = !reach
        ? []
        : seen.length > 0
          ? [
              '',
              !hostDown
                ? `Порт SSH ${server.port} — с серверов парка не отвечает, с сервера панели открыт:`
                : abroad
                  ? `Порт SSH ${server.port} — ни из одной страны:`
                  : `Порт SSH ${server.port} — не отвечает ни с одного проверяющего сервера, но все они в России; из-за рубежа порт не проверен:`,
              ...countryReachLines(seen, !hostDown),
            ]
          : ['', COUNTRY_BLIND[reach.blind ?? 'no_probers']];
      const detail = [
        why,
        ...reachBlock,
        ...(picture && payHint ? ['', ...paymentLines(pay, picture), payHint] : []),
      ].join('\n');
      let main = open;
      if (!main) {
        const earlier =
          (await this.repo.findOpen(server.id, 'agent_offline')) ??
          (await this.repo.findOpen(server.id, 'ssh_down'));
        const label = picture ? serverDownLabel(pay, picture) : undefined;
        main = earlier ? await this.refineToServerDown(earlier, server, detail, hostDown, label) : undefined;
        if (!main) await this.openIncident(server, 'server_down', detail, label);
        main ??= await this.repo.findOpen(server.id, 'server_down');
      }
      // Остальные дела по этому серверу с той же причиной — закрываем с пояснением, куда они делись.
      for (const kind of ['agent_offline', 'ssh_down', 'node_blocked'] as const) {
        const other = await this.repo.findOpen(server.id, kind);
        if (other && other.id !== main?.id) {
          await this.autoResolve(
            other,
            'Объединено с делом «Сервер недоступен»: причина одна — сервер не отвечает.',
          );
          if (main)
            await this.repo.appendEvent(
              main.id,
              ev(
                'auto',
                `Присоединено: «${INCIDENT_KIND_META[kind].label}» — следствие недоступности сервера`,
                'detect',
              ),
            );
        }
      }
      return 'checked';
    }
    // Закрываем, только если сервер действительно ответил: агент на связи или порт SSH открылся. Дело,
    // открытое проверкой онлайна у сервера без агента (аренда), закрывает перепроверка онлайна.
    const answered = agentOff || server.agentStatus === 'online';
    if (open && answered && !open.attempts.some((a) => a.status === 'running'))
      await this.autoResolve(
        open,
        agentOff
          ? 'Сервер снова отвечает, но агент молчит — открыто отдельное дело «Агент не в сети».'
          : 'Сервер снова на связи: агент и SSH отвечают.',
      );
    // «Агент не в сети» закрываем, только когда агент действительно на связи: пока его переустанавливают
    // («Агент устанавливается…», «Ожидает агента») или он пропал меньше двух минут назад, дело остаётся.
    const agentBack = server.agentStatus === 'online' || server.agentStatus === 'not_installed';
    await this.evalBinary(server, 'agent_offline', agentOff, agentBack);
    await this.evalBinary(server, 'ssh_down', sshConfirmed, !sshDown);
    return 'checked';
  }

  /**
   * SSH не отвечает дольше порога: между первой и последней неудачной проверкой прошло не меньше
   * sshDownForMs, и ни одна проверка за это время не прошла. По одной неудачной попытке дело не заводим —
   * неудачу подтверждают повторные проверки (их делает IncidentSshRecheckJob, раз в 20 секунд). Отметка —
   * в памяти: после перезапуска панели серия считается заново, уже открытое дело при этом остаётся.
   */
  private sshDownConfirmed(server: ServerRow): boolean {
    if (server.sshOk !== false) {
      this.sshDownSince.delete(server.id);
      return false;
    }
    const last = server.lastSshCheckAt?.getTime() ?? Date.now();
    let since = this.sshDownSince.get(server.id);
    // Отметки нет или после неё SSH успел ответить — серия неудач началась заново, с последней проверки.
    if (since === undefined || (server.lastSshOkAt && server.lastSshOkAt.getTime() > since)) since = last;
    this.sshDownSince.set(server.id, since);
    return last - since >= this.sshDownForMs;
  }

  /**
   * С чем ещё случился сбой за последние полчаса, кроме этого сервера. Больше нуля — сбой не у одного:
   * общая причина (сеть, хостер, общий счёт) вероятнее, чем неоплата именно этого. Считают этим и детекция
   * связи, и проверка онлайна — иначе на вопрос «упало сразу у нескольких?» они отвечали бы по-разному.
   * Счёт раздельный: панель пишет то, что видела, — «упал онлайн у других нод» или «пропала связь с
   * другими серверами».
   */
  async fleetTrouble(me: {
    serverId: string | null;
    /** Имена самого сервера и его ноды: своё прежнее дело «другим» не считается. */
    names: ReadonlyArray<string | null | undefined>;
  }): Promise<FleetTrouble> {
    const now = Date.now();
    const since = now - FLEET_WINDOW_MS;
    const mine = new Set(me.names.filter((n): n is string => Boolean(n)));
    const lost = new Set<string>();
    const dropped = new Set<string>();
    const droppedLoose = new Set<string>();
    for (const s of await this.serversRepo.list().catch(() => [])) {
      if (s.id === me.serverId || mine.has(s.name) || s.agentStatus !== 'offline' || !s.agentLastSeenAt)
        continue;
      const seen = s.agentLastSeenAt.getTime();
      // Замолчал — после того же порога, что и для своего дела «Агент не в сети»: двадцать секунд тишины
      // (обновление агента, короткий обрыв) — ещё не сбой.
      if (seen >= since && now - seen >= AGENT_OFFLINE_FOR_MS) lost.add(s.id);
    }
    for (const i of await this.repo.list('open').catch(() => [])) {
      if (i.openedAt.getTime() < since) continue;
      if ((i.serverId !== null && i.serverId === me.serverId) || mine.has(i.serverName)) continue;
      if (ONLINE_DROP_RE.test(i.detail)) {
        // Дело без сервера заведено под именем ноды: та же ли это машина, что и наш сервер, неизвестно.
        if (i.serverId) dropped.add(i.serverId);
        else droppedLoose.add(i.serverName);
      } else if (i.kind === 'server_down' && i.serverId) lost.add(i.serverId);
    }
    return { nodes: dropped.size + droppedLoose.size, linkedNodes: dropped.size, servers: lost.size };
  }

  private readonly reachCache = new Map<string, { at: number; value: CountryReachResult }>();

  /** Проверка «из каждой страны» — не чаще раза в 3 минуты на сервер (каждая — SSH на несколько машин). */
  private async countryReachCached(server: ServerRow): Promise<CountryReachResult> {
    const hit = this.reachCache.get(server.id);
    if (hit && Date.now() - hit.at < REACH_TTL_MS) return hit.value;
    const all = await this.servers.list().catch(() => []);
    const value = await this.blockCheck
      .countryReach(server.host, server.port, server.id, all)
      .catch((): CountryReachResult => ({ results: [], blind: 'no_answer' }));
    this.reachCache.set(server.id, { at: Date.now(), value });
    return value;
  }

  /**
   * «Недоступен из части сетей»: агент и SSH с панели молчат, а порт SSH открыт из других стран. Сервер
   * работает — отрезан путь из части сетей (часто это блокировка страны или сбой маршрута). Одно дело вида
   * «Похоже на блокировку»; «Агент не в сети» и «SSH недоступен» — следствие, присоединяются.
   */
  private async evalPartialReach(
    server: ServerRow,
    partial: boolean,
    reach: CountryReach[],
    panelOpen: boolean,
    /** Что сейчас со связью — чтобы закрыть дело словами о том, что есть на самом деле. */
    now: { serverDown: boolean; agentOnline: boolean; sshDown: boolean },
  ): Promise<void> {
    const existing = await this.repo.findOpen(server.id, 'node_blocked');
    const mine = existing?.detail.startsWith(PARTIAL_MARK) ? existing : undefined;
    if (!partial) {
      // Сервер перестал отвечать совсем — это не «связь восстановилась»: дело присоединит «Сервер недоступен».
      if (now.serverDown) return;
      if (mine && !mine.attempts.some((a) => a.status === 'running'))
        await this.autoResolve(
          mine,
          now.agentOnline
            ? 'Связь восстановилась: агент снова на связи.'
            : now.sshDown
              ? 'Порт SSH снова открыт отовсюду, в том числе с сервера панели. Агент пока молчит, и по SSH панель зайти не может — дальше это отдельные дела «Агент не в сети» и «SSH недоступен».'
              : 'Порт SSH снова открыт отовсюду, и панель заходит по SSH. Агент пока молчит — если он не выйдет на связь, откроется отдельное дело «Агент не в сети».',
        );
      return;
    }
    const closed = reach.filter((r) => !r.open).map((r) => r.from);
    const opened = reach.filter((r) => r.open).map((r) => r.from);
    // Заходим на сам сервер через тот, откуда он доступен, и смотрим, куда он может выйти: так видно, что
    // режет сеть сервера (Россию, панель), а не сам сервер. Не вышло — дело всё равно заводится.
    const all = await this.servers.list().catch(() => []);
    const me = all.find((x) => x.id === server.id);
    const out = me ? await this.egress.check(me, all, opened) : null;
    const detail = [
      `${PARTIAL_MARK} агент не выходит на связь и панель не заходит по SSH, но сам сервер работает: порт SSH ${server.port} открыт не отовсюду.`,
      '',
      `Порт SSH ${server.port}:`,
      ...countryReachLines(reach, panelOpen),
      '',
      closed.length === 0
        ? // Все проверяющие видят порт, не видит только панель: «закрыт из части стран» было бы неправдой.
          `Похоже: закрыт путь между сервером и панелью — со всех проверяющих серверов (${opened.join(', ')}) порт открыт, а с сервера панели не отвечает (поэтому молчат агент и SSH). Обычно это фильтрация у хостера одной из сторон или сбой маршрута между ними. Сервер выключать и переустанавливать ничего не нужно.`
        : `Путь до сервера недоступен из части проверенных сетей: не отвечает с ${closed.join(', ')}${panelOpen ? '' : ' и с сервера панели (поэтому молчат агент и SSH)'}, а с ${opened.join(', ')} открыт. Сервер работает, но одна TCP-проверка не определяет причину: это могут быть правила доступа, фильтрация маршрута или сетевой сбой. Не меняйте IP только по этому результату — сначала сравните страны и проверку выхода самого сервера.`,
      ...(out && out.results.length > 0 ? ['', egressText(out)] : []),
    ].join('\n');
    if (!existing) {
      await this.openIncident(server, 'node_blocked', detail, 'Недоступен из части сетей');
    } else if (mine && mine.detail !== detail) {
      await this.repo.update(mine.id, { detail });
    }
    const main = existing ?? (await this.repo.findOpen(server.id, 'node_blocked'));
    for (const kind of ['agent_offline', 'ssh_down'] as const) {
      const other = await this.repo.findOpen(server.id, kind);
      if (other && main) {
        await this.autoResolve(
          other,
          'Объединено с делом «Недоступен из части сетей»: сервер жив, отрезан путь из части сетей.',
        );
        await this.repo.appendEvent(
          main.id,
          ev(
            'auto',
            `Присоединено: «${INCIDENT_KIND_META[kind].label}» — следствие недоступности из части сетей`,
            'detect',
          ),
        );
      }
    }
  }

  /**
   * Уже открытое «Агент не в сети» или «SSH недоступен» оказалось частью большего: сервер не отвечает целиком.
   * Дело уточняем на месте (та же история), предложение шага снимаем — на недоступном сервере его не выполнить.
   */
  private async refineToServerDown(
    row: IncidentRow,
    server: ServerRow,
    detail: string,
    /** Порт SSH не открывается и с панели; false — порт открыт, панель не может зайти по SSH. */
    hostDown: boolean,
    /** Своя подпись вместо вида: «Сервер недоступен — проверьте оплату». */
    label?: string,
  ): Promise<IncidentRow | undefined> {
    const meta = INCIDENT_KIND_META.server_down;
    const dropped = row.proposal
      ? ` Предложение «${actionByKey(row.proposal.action as ActionKey).title}» снято: на недоступном сервере его не выполнить.`
      : '';
    const updated = await this.repo.update(row.id, {
      kind: 'server_down',
      severity: meta.severity,
      title: `${label ?? meta.label} · ${server.name}`,
      detail,
      proposal: null,
      // Прежний разбор был про агента или SSH — пусть Джарвис разберёт уже «Сервер недоступен».
      analysis: null,
      timeline: [
        ...row.timeline,
        ev(
          'auto',
          // Хронология не должна спорить с текстом дела: порт с панели открывается — «порт не отвечает» не пишем.
          `Уточнено: ${
            row.kind !== 'agent_offline'
              ? 'сервер недоступен целиком — агент тоже молчит'
              : hostDown
                ? 'сервер недоступен целиком — порт SSH тоже не отвечает'
                : 'сервер не отвечает панели — по SSH панель зайти не может, хотя порт SSH открывается'
          }.${dropped}`,
          'detect',
        ),
      ],
    });
    if (!updated) return undefined;
    await this.notifications.push({
      severity: 'crit',
      title: incidentTitleToken(label ?? meta.label),
      server: { id: server.id, name: server.name, host: server.host },
      telegram: {
        event: 'incident_crit',
        incidentId: updated.id,
        kind: 'server_down',
        awaitAnalysis: await this.analysisWillFollow(),
      },
      body: `Уточнено: ${detail}`,
      link: { to: `/incidents/${updated.id}`, label: 'Открыть инцидент' },
    });
    await this.audit.record({
      action: 'incident.opened',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      severity: 'crit',
      target: { type: 'incident', id: updated.id, display: updated.title },
      metadata: { server: server.name, kind: 'server_down', refinedFrom: row.kind },
    });
    return updated;
  }

  /**
   * Состояние «есть / нет» (агент не в сети, SSH недоступен). `active` — пора заводить дело, `gone` — причина
   * точно ушла; между ними (агента переустанавливают, неудачу SSH ещё подтверждают) дело не заводим и не
   * закрываем. Пока по делу идёт действие, тоже не закрываем: иначе «проблема исчезла» опережала итог
   * самого действия, и следующий шаг цепочки не предлагался.
   */
  private async evalBinary(
    server: ServerRow,
    kind: IncidentKind,
    active: boolean,
    gone: boolean,
  ): Promise<void> {
    const existing = await this.repo.findOpen(server.id, kind);
    if (active && !existing) await this.openIncident(server, kind, this.binaryDetail(kind));
    else if (gone && existing && !existing.attempts.some((a) => a.status === 'running'))
      await this.autoResolve(existing);
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

  private async openIncident(
    server: ServerRow,
    kind: IncidentKind,
    detail: string,
    /** Своя подпись вместо вида (например, «Сервер недоступен — просрочена оплата»). */
    label?: string,
  ): Promise<void> {
    const meta = INCIDENT_KIND_META[kind];
    const m = await this.metrics.latestFor(server.id).catch(() => undefined);
    const row = await this.repo.open({
      serverId: server.id,
      serverName: server.name,
      kind,
      severity: meta.severity,
      title: `${label ?? meta.label} · ${server.name}`,
      detail,
      timeline: [ev('auto', `Обнаружено: ${label ?? meta.label}`, 'detect')],
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
    const awaitAnalysis = await this.analysisWillFollow();
    const decision = await this.runner.onOpened(row, awaitAnalysis);
    if (decision === 'waiting' || decision === 'none')
      await this.notifications.push({
        severity: meta.severity === 'crit' ? 'crit' : 'warn',
        // Своя подпись («Сервер недоступен — проверьте оплату») должна быть и в уведомлении, не только в списке.
        title: incidentTitleToken(label ?? meta.label),
        server: { id: server.id, name: server.name, host: server.host },
        telegram: {
          event: meta.severity === 'crit' ? 'incident_crit' : 'incident_warn',
          incidentId: row.id,
          kind,
          awaitAnalysis,
        },
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
    // Закрытие называем так же, как открывали дело («Резко упал онлайн — проверьте оплату»), а не видом:
    // иначе ответ на своё же сообщение приходил под чужим заголовком «Похоже на блокировку».
    // Имя сервера или ноды стоит в конце заголовка после « · » — и само может содержать « · ».
    const suffix = ` · ${row.serverName}`;
    const cut = row.title.endsWith(suffix) ? row.title.length - suffix.length : row.title.lastIndexOf(' · ');
    const label = cut > 0 ? row.title.slice(0, cut) : INCIDENT_KIND_META[row.kind as IncidentKind].label;
    await this.notifications.push({
      severity: 'ok',
      title: `${row.serverId ? incidentTitleToken(label) : label} — ${reason ? 'закрыт' : 'проблема исчезла'}`,
      ...(row.serverId ? { server: { id: row.serverId, name: row.serverName } } : {}),
      body: reason ?? 'Инцидент закрыт автоматически.',
      link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
      telegram: {
        event: 'resolved',
        incidentId: row.id,
        kind: row.kind as IncidentKind,
        // Тревога могла ещё ждать разбора и не уйти: тогда вместо пары «тревога → починилось» уйдёт одно
        // сообщение о коротком сбое. Без причины — проблема исчезла сама; с причиной — пересказываем её.
        closed: !reason
          ? { recovered: true }
          : reason.startsWith(MERGED_MARK)
            ? 'merged'
            : { recovered: false, how: reason },
      },
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

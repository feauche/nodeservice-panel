import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  type IncidentEvent,
  type IncidentKind,
  type MonitoringSettings,
  type NodeTcpDiagnostics,
  type RemnawaveNode,
  tcpBlockedInRussia,
  tcpCheckReportSchema,
  tcpReachSummary,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { PanelPulse } from '../health/panel-pulse.js';
import { NodeMetricsService } from '../node-metrics/node-metrics.controller.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { RecoveryFacts } from '../notifications/telegram/telegram.format.js';
import { NodeMaintenanceStore } from '../remnawave/node-maintenance.store.js';
import { NodePreferencesStore } from '../remnawave/node-preferences.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { CheckHostService, describeTcp, type TcpReport } from './check-host.service.js';
import {
  channelLoad,
  dropDetected,
  loadPerCore,
  memoryPercent,
  perCoreText,
  type Sample,
  stableBaseline,
} from './fleet-monitor.logic.js';
import { IncidentsRepository } from './incidents.repository.js';
import { WaveService, type WaveVerdict } from './wave.service.js';

type State = {
  samples: Sample[];
  lastAt: number;
  dropSeen: number;
  baseline: number | null;
  recovered: number;
  downSeen: number;
  cpuSince: number | null;
  memSince: number | null;
  /** С какого замера нагрузка или память ниже порога с запасом: закрываем, только если так держится. */
  cpuBelow?: number | null;
  memBelow?: number | null;
  /** Канал (0.110.0): с какого замера выше порога и с какого ниже с запасом. */
  chanSince?: number | null;
  chanBelow?: number | null;
  /** Адрес ноды в прошлом снимке: событие следит за нодой, а смена адреса — шаг в событии. */
  address?: string;
  /** Нода была не на связи подтверждённо: при возвращении — строка «Нода снова на связи» в открытых событиях. */
  downConfirmed?: boolean;
  /** В событие уже написано «Онлайн возвращается» — повторно не пишем, пока онлайн снова не упадёт. */
  returningNoted?: boolean;
};
const empty = (): State => ({
  samples: [],
  lastAt: 0,
  dropSeen: 0,
  baseline: null,
  recovered: 0,
  downSeen: 0,
  cpuSince: null,
  memSince: null,
  cpuBelow: null,
  memBelow: null,
});
type ProbeState = {
  report: TcpReport | null;
  attemptAt: number;
  address: string;
  port: number;
  nodePort?: number | null;
  /** Повторная проверка после возвращения онлайна: её «нет полного результата» уже не держит событие открытым. */
  recheck?: boolean;
};
/** События о доступности ноды: их закрывает возвращение ноды, а не порог ресурса. */
const TCP_KINDS: IncidentKind[] = ['node_blocked', 'server_down'];
/** Повторная проверка порта при восстановлении — не чаще раза в минуту, если прошлая была неудачной. */
const RECOVERY_RECHECK_MS = 60_000;

/** Строка «Что происходило» от мониторинга. */
function entry(
  action: string,
  extra: Partial<IncidentEvent> = {},
  result: IncidentEvent['result'] = 'notify',
): IncidentEvent {
  return { at: new Date().toISOString(), by: 'auto', action, result, ...extra };
}
/** Порт из «1.2.3.4:5492» — для строк события. */
const portOf = (report: TcpReport) => report.target.split(':').at(-1) ?? '';
/** Итог проверки порта для строки события: заголовок, тон и «Из РФ 3 из 3, из других стран 3 из 3». */
function tcpLine(
  report: TcpReport,
  where: 'new' | 'again',
): Pick<IncidentEvent, 'action' | 'tone' | 'detail' | 'link'> {
  const port = portOf(report),
    parsed = tcpCheckReportSchema.safeParse(report),
    summary = parsed.success ? tcpReachSummary(parsed.data) : '';
  const place = where === 'new' ? ' на новом адресе' : '';
  const action =
    report.verdict === 'reachable'
      ? where === 'new'
        ? `Порт ${port} на новом адресе доступен`
        : `Порт ${port} снова доступен`
      : report.verdict === 'russia_unreachable'
        ? `Порт ${port}${place} недоступен из РФ`
        : report.verdict === 'russia_partial'
          ? `Порт ${port}${place} частично недоступен из РФ`
          : report.verdict === 'port_unreachable'
            ? `Порт ${port}${place} не отвечает`
            : `Порт ${port}${place}: нет полного результата проверки`;
  const repeat =
    report.verdict === 'russia_partial'
      ? report.confirmed
        ? ' Повторная проверка через минуту показала то же.'
        : ' Повторной проверки не было.'
      : '';
  return {
    action,
    tone:
      report.verdict === 'reachable'
        ? 'ok'
        : report.verdict === 'unknown' || (report.verdict === 'russia_partial' && !report.confirmed)
          ? 'warn'
          : 'crit',
    ...(summary ? { detail: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.${repeat}` } : {}),
    ...(report.link ? { link: { label: 'Отчёт Check-Host', href: report.link } } : {}),
  };
}

@Injectable()
export class FleetMonitorJob {
  private log = new Logger(FleetMonitorJob.name);
  private busy = false;
  private tcpBusy = false;
  private verifying = new Set<string>();
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly remna: RemnawaveService,
    private readonly settings: MonitoringStore,
    private readonly repo: IncidentsRepository,
    private readonly notifications: NotificationsService,
    private readonly checkHost: CheckHostService,
    private readonly pulse: PanelPulse,
    @Optional() private readonly preferences?: NodePreferencesStore,
    @Optional() private readonly metrics?: NodeMetricsService,
    @Optional() private readonly maintenance?: NodeMaintenanceStore,
    @Optional() private readonly wave?: WaveService,
  ) {}
  /** Решение волны о сообщении ноды; сбой волны не должен глушить обычную тревогу. */
  private async waveVerdict(ask: () => Promise<WaveVerdict> | undefined): Promise<WaveVerdict> {
    try {
      return (await ask()) ?? 'notify';
    } catch (e) {
      this.log.warn(`Волна: ${e instanceof Error ? e.message : e}`);
      return 'notify';
    }
  }
  /** Ноды на обслуживании сейчас (0.106.0): по ним событий нет, а счётчики после окончания начинаются заново. */
  private async maintained(domain: string | null): Promise<Set<string>> {
    if (!this.maintenance) return new Set();
    try {
      return new Set((await this.maintenance.active(domain)).keys());
    } catch {
      return new Set();
    }
  }
  private scope(domain: string | null) {
    return createHash('sha256')
      .update(domain ?? '')
      .digest('hex')
      .slice(0, 16);
  }
  private async read<T>(key: string): Promise<T | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  private async write(key: string, value: unknown) {
    await this.db
      .insert(appMeta)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
  }
  /** Строка во все открытые события ноды нужных видов. */
  private async note(nodeUuid: string, kinds: IncidentKind[], e: IncidentEvent) {
    for (const row of (await this.repo.list('open')).filter(
      (r) => r.nodeUuid === nodeUuid && kinds.includes(r.kind as IncidentKind),
    ))
      await this.repo.appendTimeline(row.id, e);
  }
  /**
   * Уровень, к которому должен вернуться онлайн, чтобы закрыть падение: доля от онлайна до сбоя, но не выше
   * обычного для этого часа — после смены адреса ночью дневной уровень не вернётся, и событие висело бы.
   */
  private async recoveryTarget(
    domain: string | null,
    node: RemnawaveNode,
    baseline: number,
    cfg: MonitoringSettings,
  ) {
    const typical =
      domain && this.metrics ? await this.metrics.typicalOnline(domain, node.uuid).catch(() => null) : null;
    const usual = typical ? Math.round((typical.low + typical.high) / 2) : null;
    const reference = usual !== null && usual > 0 ? Math.min(baseline, usual) : baseline;
    return { target: Math.ceil((reference * cfg.recoveryPercent) / 100), usual };
  }
  /** Чего ждём до закрытия падения онлайна — для страницы события: тот же расчёт, что при закрытии. */
  async recoveryGoal(
    nodeUuid: string,
  ): Promise<{ target: number; usual: number | null; before: number } | null> {
    const [cfg, status] = await Promise.all([this.settings.get(), this.remna.status()]);
    const node = status.nodes.find((n) => n.uuid === nodeUuid);
    if (!status.domain || !node) return null;
    const st = await this.read<State>(`monitor.history.${this.scope(status.domain)}.${nodeUuid}`);
    if (!st?.baseline) return null;
    const goal = await this.recoveryTarget(status.domain, node, st.baseline, cfg);
    return { target: goal.target, usual: goal.usual, before: st.baseline };
  }
  // Новый снимок разбирается в течение 5 секунд после опроса.
  @Interval(5000)
  async tick() {
    if (process.env.NODE_ENV !== 'test') await this.run();
  }
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.settings.get(),
        status = await this.remna.status();
      // Job remains healthy even if monitoring is disabled or upstream is unavailable.
      this.pulse.incidentsTick();
      if (
        !cfg.enabled ||
        !status.connected ||
        status.error ||
        !status.checkedAt ||
        Date.now() - Date.parse(status.checkedAt) > cfg.staleAfterMinutes * 60000
      )
        return;
      const stamp = Date.parse(status.checkedAt),
        scope = this.scope(status.domain),
        maintained = await this.maintained(status.domain);
      for (const node of status.nodes) {
        if (node.isDisabled) continue;
        const key = `monitor.history.${scope}.${node.uuid}`;
        const st = (await this.read<State>(key)) ?? empty();
        if (stamp <= st.lastAt) continue;
        if (maintained.has(node.uuid)) {
          // Обслуживание: ни событий, ни подтверждений. Счётчики обнуляются на каждом снимке — после окончания
          // нода проходит обычное подтверждение заново, а не получает тревогу по накопленным за время работ опросам.
          await this.write(key, { ...empty(), address: node.address, lastAt: stamp } satisfies State);
          continue;
        }
        if (st.lastAt && stamp - st.lastAt > cfg.staleAfterMinutes * 60000) {
          Object.assign(st, empty(), { address: st.address });
        }
        const open = (await this.repo.list('open')).filter((r) => r.nodeUuid === node.uuid);
        const dropOpen = open.some((r) => TCP_KINDS.includes(r.kind as IncidentKind));
        // Адрес ноды в Remnawave сменили (например, при блокировке): событие следит за нодой, а не за IP.
        if (
          st.address &&
          st.address !== node.address &&
          (dropOpen || open.some((r) => r.kind === 'node_down'))
        )
          await this.addressChanged(node, st.address, cfg, scope);
        st.address = node.address;
        st.downSeen = node.isConnected ? 0 : st.downSeen + 1;
        if (st.downSeen >= cfg.confirmSamples) {
          st.downConfirmed = true;
          await this.open(
            node,
            'node_down',
            'Нода не на связи',
            `Remnawave не видит ноду в ${st.downSeen} последовательных опросах.`,
          );
        }
        if (node.isConnected && st.downConfirmed) {
          st.downConfirmed = false;
          if (dropOpen)
            await this.note(
              node.uuid,
              TCP_KINDS,
              entry('Нода снова на связи с Remnawave', { step: 'node', tone: 'ok' }),
            );
        }
        if (node.isConnected && open.some((r) => r.kind === 'node_down')) {
          const count = Number((await this.read<number>(`${key}.connected`)) ?? 0) + 1;
          await this.write(`${key}.connected`, count);
          if (count >= cfg.recoverySamples)
            await this.resolve(node, 'node_down', () => 'Связь с Remnawave восстановлена.');
        } else await this.write(`${key}.connected`, 0);
        if (node.usersOnline !== null) {
          const base = st.baseline ?? stableBaseline(st.samples, stamp, cfg);
          const goal =
            st.baseline === null ? null : await this.recoveryTarget(status.domain, node, st.baseline, cfg);
          if (goal && node.usersOnline >= goal.target) {
            st.dropSeen = 0;
            st.recovered++;
            if (dropOpen && !st.returningNoted && st.recovered < cfg.recoverySamples) {
              st.returningNoted = true;
              await this.note(
                node.uuid,
                TCP_KINDS,
                entry(`Онлайн возвращается: ${node.usersOnline}`, {
                  step: 'online',
                  tone: 'wait',
                  detail: `${goal.usual !== null ? `Обычно в это время около ${goal.usual}` : `До падения было ${st.baseline}`}. Закрою событие сам, когда онлайн около минуты продержится не ниже ${goal.target}.`,
                }),
              );
            }
            if (st.recovered >= cfg.recoverySamples) {
              // Событие о доступности закрывает свежая проверка порта именно на нынешнем адресе ноды: успешная — или
              // без полного результата, но сделанная уже после возвращения онлайна. Check-Host не ответил, а
              // пользователи подключаются: доказательства сбоя нет — закрываем по онлайну, а не ждём часами.
              const probe = await this.read<ProbeState>(`monitor.tcp.${scope}.${node.uuid}`);
              const fresh = probe?.address === node.address ? (probe.report ?? null) : null;
              const recent =
                fresh !== null &&
                Date.parse(fresh.checkedAt) > Date.now() - cfg.checkHostCooldownMinutes * 60000;
              const unclear = recent && fresh.verdict === 'unknown' && probe?.recheck === true;
              if (!cfg.checkHostOnDrop || (recent && fresh.verdict === 'reachable') || unclear) {
                const online = node.usersOnline;
                for (const kind of TCP_KINDS)
                  await this.resolve(
                    node,
                    kind,
                    (row) => closeSummary(row.timeline, online, goal.usual, unclear ? 'unclear' : 'ok'),
                    (row) => recoveryFacts(row, online, goal.usual, fresh),
                  );
                st.baseline = null;
                st.returningNoted = false;
              } else if (!this.verifying.has(node.uuid))
                this.verifyDrop(node, st.baseline ?? 0, node.usersOnline, cfg, scope, true);
            }
          } else if (dropDetected(node.usersOnline, base, cfg)) {
            st.dropSeen++;
            st.baseline = base;
            if (st.returningNoted && dropOpen)
              await this.note(
                node.uuid,
                TCP_KINDS,
                entry(`Онлайн снова упал: ${node.usersOnline}`, { step: 'online', tone: 'warn' }),
              );
            st.recovered = 0;
            st.returningNoted = false;
            if (st.dropSeen >= cfg.confirmSamples && !dropOpen)
              this.verifyDrop(node, base ?? 0, node.usersOnline, cfg, scope);
          } else {
            st.dropSeen = 0;
            st.recovered = 0;
          }
          st.samples = [
            ...st.samples.filter((s) => s.at > stamp - cfg.dropWindowMinutes * 60000),
            { at: stamp, online: node.usersOnline },
          ].slice(-500);
        } else {
          st.dropSeen = 0;
          st.recovered = 0;
        }
        // Процента процессора Remnawave не отдаёт: судим по нагрузке на ядро — как в строке ноды.
        const load = loadPerCore(node),
          mem = memoryPercent(node);
        const thresholds = this.preferences
          ? await this.preferences.forMonitoring(status.domain, node.uuid)
          : null;
        const cpu = await this.resource(
          node,
          'cpu_high',
          load,
          cfg.cpuEnabled,
          thresholds?.loadWarningPerCore ?? cfg.loadPerCore,
          { since: st.cpuSince, below: st.cpuBelow ?? null },
          stamp,
          cfg,
        );
        st.cpuSince = cpu.since;
        st.cpuBelow = cpu.below;
        const memory = await this.resource(
          node,
          'mem_high',
          mem,
          cfg.memoryEnabled,
          thresholds?.memoryWarningPercent ?? cfg.memoryPercent,
          { since: st.memSince, below: st.memBelow ?? null },
          stamp,
          cfg,
        );
        st.memSince = memory.since;
        st.memBelow = memory.below;
        // Канал — в процентах от «Лимита канала» ноды; ноды без лимита не проверяются.
        const channel = channelLoad(node, thresholds?.channelMbps);
        const chan = await this.resource(
          node,
          'channel_high',
          channel?.percent ?? null,
          cfg.channelEnabled,
          thresholds?.channelWarningPercent ?? cfg.channelPercent,
          { since: st.chanSince ?? null, below: st.chanBelow ?? null },
          stamp,
          cfg,
          channel && thresholds?.channelMbps
            ? { mbps: channel.mbps, limit: thresholds.channelMbps, direction: channel.direction }
            : undefined,
        );
        st.chanSince = chan.since;
        st.chanBelow = chan.below;
        st.lastAt = stamp;
        await this.write(key, st);
      }
      // Ноды волны могли подняться в обход наблюдения (закрыли вручную, обслуживание) — волна закрывается и тогда.
      await this.wave
        ?.reconcileAll()
        .catch((e) => this.log.warn(`Волна: ${e instanceof Error ? e.message : e}`));
    } catch (e) {
      this.log.warn(e instanceof Error ? e.message : 'Ошибка мониторинга');
    } finally {
      this.busy = false;
    }
  }
  /**
   * Адрес ноды сменился, пока открыто событие: строка «Адрес ноды изменён» и сразу проверка порта на новом адресе —
   * её итог тоже в событие. DNS-запись ноды проверяют «DNS интеграции» и пишут в это же событие.
   */
  private async addressChanged(
    node: RemnawaveNode,
    previous: string,
    cfg: MonitoringSettings,
    scope: string,
  ) {
    const kinds: IncidentKind[] = [...TCP_KINDS, 'node_down'];
    await this.note(
      node.uuid,
      kinds,
      entry('Адрес ноды изменён в Remnawave', {
        step: 'address',
        tone: 'change',
        detail: `${previous} → ${node.address}`,
      }),
    );
    if ((!cfg.checkHostEnabled && !cfg.checkHostOnDrop) || this.verifying.has(node.uuid)) return;
    this.verifying.add(node.uuid);
    void (async () => {
      const report = await this.checkHost.checkNode(node.address, cfg.checkHostPort, node.port);
      await this.write(`monitor.tcp.${scope}.${node.uuid}`, {
        report,
        attemptAt: Date.now(),
        address: node.address,
        port: cfg.checkHostPort,
        nodePort: node.port ?? null,
      } satisfies ProbeState);
      await this.note(node.uuid, kinds, entry('', { step: 'port', ...tcpLine(report, 'new') }));
    })()
      .catch((e) => this.log.warn(e instanceof Error ? e.message : 'Ошибка проверки нового адреса'))
      .finally(() => this.verifying.delete(node.uuid));
  }
  private async resource(
    node: RemnawaveNode,
    kind: IncidentKind,
    value: number | null,
    enabled: boolean,
    threshold: number,
    track: { since: number | null; below: number | null },
    at: number,
    cfg: MonitoringSettings,
    /** Канал: сколько Мбит/с, из какого лимита и в какую сторону — для текста события. */
    channel?: { mbps: number; limit: number; direction: 'входящий' | 'исходящий' },
  ): Promise<{ since: number | null; below: number | null }> {
    if (!enabled || value === null) return { since: null, below: null };
    const cpu = kind === 'cpu_high',
      hold = cfg.resourceDurationMinutes * 60000,
      minutes = cfg.resourceDurationMinutes;
    const mbit = (v: number) => Math.round(v).toLocaleString('ru-RU');
    if (value >= threshold) {
      const start = track.since ?? at;
      if (at - start >= hold)
        await this.open(
          node,
          kind,
          cpu ? 'Высокая нагрузка на процессор' : channel ? 'Канал перегружен' : 'Высокая занятость памяти',
          cpu
            ? `Нагрузка на ядро — ${perCoreText(value)} (порог ${perCoreText(threshold)}, ядер: ${node.cpuCount}) держится дольше ${minutes} мин. Источник: Remnawave.`
            : channel
              ? `${channel.direction === 'исходящий' ? 'Исходящий' : 'Входящий'} трафик — ${Math.round(value)} % лимита канала (${mbit(channel.mbps)} из ${mbit(channel.limit)} Мбит/с, порог ${threshold} %) дольше ${minutes} мин.${typeof node.usersOnline === 'number' ? ` Онлайн ${node.usersOnline.toLocaleString('ru-RU')}.` : ''} Источник: Remnawave.`
              : `Занято ${Math.round(value)} % памяти (порог ${threshold} %) дольше ${minutes} мин. Источник: Remnawave.`,
        );
      return { since: start, below: null };
    }
    // Закрываем с запасом и не сразу, чтобы событие не мигало у порога: память и канал — на 5 %, нагрузка — на
    // десятую часть порога, и держится так столько же минут, сколько ждали превышения.
    if (value <= (cpu ? threshold * 0.9 : threshold - 5)) {
      const below = track.below ?? at;
      if (at - below >= hold)
        await this.resolve(node, kind, () =>
          cpu
            ? `Нагрузка на ядро ниже порога с запасом дольше ${minutes} мин: ${perCoreText(value)}.`
            : channel
              ? `Канал ниже порога с запасом дольше ${minutes} мин: ${Math.round(value)} % лимита.`
              : `Память ниже порога с запасом дольше ${minutes} мин: занято ${Math.round(value)} %.`,
        );
      return { since: null, below };
    }
    return { since: null, below: null };
  }
  private verifyDrop(
    node: RemnawaveNode,
    before: number,
    after: number,
    cfg: MonitoringSettings,
    scope: string,
    recovery = false,
  ) {
    if (this.verifying.has(node.uuid)) return;
    this.verifying.add(node.uuid);
    void (async () => {
      const key = `monitor.tcp.${scope}.${node.uuid}`,
        old = await this.read<ProbeState>(key);
      let report: TcpReport | null = null;
      if (cfg.checkHostOnDrop) {
        const current =
          old?.address === node.address &&
          old.port === cfg.checkHostPort &&
          old.nodePort === (node.port ?? null);
        const age = old?.report ? Date.now() - Date.parse(old.report.checkedAt) : Number.POSITIVE_INFINITY;
        // При восстановлении неудачную проверку не берём из запаса на 5 минут: порт мог уже ожить — проверяем
        // заново, но не чаще раза в минуту.
        const reuse =
          current &&
          old?.report &&
          (recovery && old.report.verdict !== 'reachable'
            ? age < RECOVERY_RECHECK_MS
            : age < cfg.checkHostCooldownMinutes * 60000);
        report =
          reuse && old?.report
            ? old.report
            : await this.checkHost.checkNode(node.address, cfg.checkHostPort, node.port);
        if (report !== old?.report)
          await this.write(key, {
            report,
            attemptAt: Date.now(),
            address: node.address,
            port: cfg.checkHostPort,
            nodePort: node.port ?? null,
            ...(recovery ? { recheck: true } : {}),
          } satisfies ProbeState);
        // Итог повторной проверки — в событие, только когда он изменился: без строки на каждый опрос.
        if (recovery && report !== old?.report && report.verdict !== old?.report?.verdict)
          await this.note(node.uuid, TCP_KINDS, entry('', { step: 'port', ...tcpLine(report, 'again') }));
      }
      // Ignore completion after reconnecting another panel, disabling monitoring, removing node or changing target.
      const latest = await this.remna.status(),
        latestCfg = await this.settings.get();
      const actual = latest.nodes.find((n) => n.uuid === node.uuid);
      if (
        this.scope(latest.domain) !== scope ||
        !latestCfg.enabled ||
        latest.error ||
        !actual ||
        actual.isDisabled ||
        actual.address !== node.address ||
        latestCfg.checkHostPort !== cfg.checkHostPort
      )
        return;
      if (
        !latest.connected ||
        !latest.checkedAt ||
        Date.now() - Date.parse(latest.checkedAt) > latestCfg.staleAfterMinutes * 60000 ||
        (actual.port ?? null) !== (node.port ?? null)
      )
        return;
      if (recovery) return;
      if (actual.usersOnline !== null && actual.usersOnline >= (before * cfg.recoveryPercent) / 100) return;
      const kind: IncidentKind = report?.verdict === 'port_unreachable' ? 'server_down' : 'node_blocked';
      const blocked = report ? tcpBlockedInRussia(report) : false;
      const conclusion =
        report?.verdict === 'russia_unreachable'
          ? 'TCP-порт недоступен из РФ, доступен из других стран. Вероятное ограничение из РФ.'
          : report?.verdict === 'russia_partial'
            ? blocked
              ? 'TCP-порт доступен из других стран, а из РФ — не со всех точек, и повторная проверка через минуту показала то же. Вероятная блокировка у части провайдеров РФ.'
              : 'TCP-порт доступен из других стран, а из РФ — не со всех точек; повторной проверки не было, вывод не подтверждён.'
            : report?.verdict === 'port_unreachable'
              ? 'TCP-порт недоступен из РФ и других стран. Нода или порт недоступны.'
              : report?.verdict === 'reachable'
                ? 'TCP-порт доступен из РФ и других стран. Причина падения онлайна не подтверждена.'
                : 'Доступность из РФ не подтверждена: недостаточно данных TCP-проверки.';
      await this.open(
        node,
        kind,
        blocked
          ? 'Падение онлайна · недоступность из РФ'
          : report?.verdict === 'port_unreachable'
            ? 'Падение онлайна · TCP-порт недоступен'
            : 'Падение онлайна',
        `Онлайн: ${before} → ${after}.\n${conclusion}\n${report ? describeTcp(report) : ''}`,
        report ? { source: 'checkhost', report, online: { before, after } } : undefined,
      );
    })()
      .catch((e) => this.log.warn(e instanceof Error ? e.message : 'Ошибка TCP-проверки'))
      .finally(() => this.verifying.delete(node.uuid));
  }
  private async open(
    node: RemnawaveNode,
    kind: IncidentKind,
    title: string,
    detail: string,
    diagnostics?: NodeTcpDiagnostics,
  ) {
    // Проверка падения идёт в фоне и могла закончиться, когда владелец уже включил обслуживание.
    if ((await this.maintained((await this.remna.status()).domain)).has(node.uuid)) return;
    const row = await this.repo.open({
      nodeUuid: node.uuid,
      serverId: null,
      serverName: node.name,
      ...(diagnostics ? { diagnostics } : {}),
      kind,
      severity: kind === 'cpu_high' || kind === 'mem_high' || kind === 'channel_high' ? 'warn' : 'crit',
      title,
      detail,
      timeline: [
        {
          at: new Date().toISOString(),
          by: 'auto',
          action: 'Обнаружено мониторингом Remnawave',
          result: 'detect',
        },
      ],
    });
    // Волна: нода вошла в волну своего провайдера — вместо её сообщения правится сообщение волны.
    if (row && (await this.waveVerdict(() => this.wave?.onNodeOpened(node, row))) === 'absorbed') return;
    if (row)
      await this.notifications.push({
        severity: row.severity as 'crit' | 'warn',
        title,
        body: detail,
        link: { to: `/incidents/${row.id}`, label: 'Открыть событие' },
        telegram: {
          event: row.severity === 'crit' ? 'incident_crit' : 'incident_warn',
          incidentId: row.id,
          kind,
          serverKey: `node:${node.uuid}`,
          server: { name: node.name, host: node.address },
          awaitAnalysis: false,
          tcp: diagnostics ?? null,
        },
      });
  }
  /**
   * Закрыть открытое событие ноды этого вида: строка-итог дописывается атомарно (параллельные строки «DNS
   * интеграций» не теряются), текст итога складывается из хронологии события.
   */
  private async resolve(
    node: RemnawaveNode,
    kind: IncidentKind,
    detail: (row: { timeline: IncidentEvent[] }) => string,
    facts?: (row: RecoverySource) => RecoveryFacts,
  ) {
    const row = (await this.repo.list('open')).find((r) => r.nodeUuid === node.uuid && r.kind === kind);
    if (!row) return;
    const text = detail(row);
    await this.repo.appendTimeline(row.id, entry(text, { step: 'close', tone: 'ok' }, 'resolved'));
    await this.repo.update(row.id, { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'auto' });
    // Нода из волны поднялась: её «Восстановление» заменит одно «Волна закончилась».
    if ((await this.waveVerdict(() => this.wave?.onNodeResolved(row))) === 'absorbed') return;
    const recovery = facts?.(row) ?? null;
    // DNS-запись ждёт ручной замены — кнопка прямо к ней (окно записи в «DNS интеграциях» откроется само).
    const dnsLink = recovery ? dnsManualLink(row.timeline) : null;
    await this.notifications.push({
      severity: 'ok',
      title: `Восстановление · ${node.name}`,
      body: text,
      link: dnsLink,
      telegram: {
        event: 'resolved',
        incidentId: row.id,
        kind,
        serverKey: `node:${node.uuid}`,
        server: { name: node.name, host: node.address },
        closed: { recovered: true },
        recovery,
        lastedMs: Math.max(0, Date.now() - new Date(row.openedAt).getTime()),
      },
    });
  }
  @Interval(60000)
  async tcpTick() {
    if (process.env.NODE_ENV !== 'test') await this.runScheduledTcp();
  }
  async runScheduledTcp() {
    if (this.tcpBusy) return;
    this.tcpBusy = true;
    try {
      const cfg = await this.settings.get(),
        status = await this.remna.status();
      if (
        !cfg.enabled ||
        !cfg.checkHostEnabled ||
        !status.connected ||
        status.error ||
        !status.checkedAt ||
        Date.now() - Date.parse(status.checkedAt) > cfg.staleAfterMinutes * 60000
      )
        return;
      const scope = this.scope(status.domain);
      const openRows = await this.repo.list('open');
      const maintained = await this.maintained(status.domain);
      let count = 0;
      for (const node of status.nodes) {
        if (node.isDisabled || this.verifying.has(node.uuid) || maintained.has(node.uuid)) continue;
        const key = `monitor.tcp.${scope}.${node.uuid}`,
          old = await this.read<ProbeState>(key);
        // Пока открыто событие о доступности — проверяем чаще (как повторная проверка при падении), иначе оно
        // ждало бы закрытия до следующей плановой проверки через сутки.
        const openTcp = openRows.some(
          (r) => r.nodeUuid === node.uuid && TCP_KINDS.includes(r.kind as IncidentKind),
        );
        const every = openTcp ? cfg.checkHostCooldownMinutes * 60000 : cfg.checkHostHours * 3600000;
        if (
          old?.address === node.address &&
          old.port === cfg.checkHostPort &&
          old.nodePort === (node.port ?? null) &&
          Date.now() - old.attemptAt < every
        )
          continue;
        const report = await this.checkHost.checkNode(node.address, cfg.checkHostPort, node.port);
        await this.write(key, {
          report,
          attemptAt: Date.now(),
          address: node.address,
          port: cfg.checkHostPort,
          nodePort: node.port ?? null,
        } satisfies ProbeState);
        const latest = await this.remna.status(),
          latestCfg = await this.settings.get(),
          actual = latest.nodes.find((n) => n.uuid === node.uuid);
        if (
          !latestCfg.enabled ||
          !latestCfg.checkHostEnabled ||
          this.scope(latest.domain) !== scope ||
          latest.error ||
          !actual ||
          actual.isDisabled ||
          actual.address !== node.address ||
          (actual.port ?? null) !== (node.port ?? null) ||
          latestCfg.checkHostPort !== cfg.checkHostPort
        )
          continue;
        // Открытое событие о доступности не дублируем новым: его ход пишется в него же.
        if (!openTcp && (report.verdict === 'russia_unreachable' || report.verdict === 'port_unreachable'))
          await this.open(
            node,
            report.verdict === 'port_unreachable' ? 'server_down' : 'node_blocked',
            report.verdict === 'port_unreachable' ? 'TCP-порт недоступен' : 'TCP-порт недоступен из РФ',
            `${describeTcp(report)}\n${report.verdict === 'russia_unreachable' ? 'Из других стран порт доступен. Вероятное ограничение из РФ.' : 'Порт не отвечает из РФ и других стран; это не доказательство остановки всего сервера.'}\n${report.link ?? ''}`,
            { source: 'checkhost', report },
          );
        if (report.verdict === 'reachable') {
          const history = await this.read<State>(`monitor.history.${scope}.${node.uuid}`);
          // Падения онлайна нет — событие о порте закрывает сам порт; есть — закроет вернувшийся онлайн.
          if (!history?.baseline)
            for (const kind of TCP_KINDS)
              await this.resolve(
                node,
                kind,
                (row) => closeSummary(row.timeline, null, null),
                (row) => recoveryFacts(row, null, null, report),
              );
        }
        if (++count >= 2) break;
      }
    } catch (e) {
      this.log.warn(e instanceof Error ? e.message : 'Ошибка плановой TCP-проверки');
    } finally {
      this.tcpBusy = false;
    }
  }
}

/**
 * Итог закрытия события о доступности из его хронологии: что сделали и что вернулось. «Нода снова работает: адрес
 * сменили, DNS-запись обновлена, порт доступен, онлайн 455 (обычно около 500).» Порт без полного результата
 * Check-Host — так и сказано: закрыто по онлайну.
 */
export function closeSummary(
  timeline: IncidentEvent[],
  online: number | null,
  usual: number | null,
  port: 'ok' | 'unclear' = 'ok',
): string {
  const facts = [
    timeline.some((e) => e.step === 'address') && 'адрес сменили',
    timeline.some((e) => e.step === 'dns' && e.tone === 'ok') && 'DNS-запись обновлена',
    port === 'ok' && 'порт доступен',
    online !== null && `онлайн ${online}${usual !== null ? ` (обычно около ${usual})` : ''}`,
  ].filter(Boolean);
  const unclear = port === 'unclear' ? ' Порт Check-Host проверить не смог — закрыто по онлайну.' : '';
  return `Нода снова работает: ${facts.join(', ')}.${unclear}`;
}

/** Что из события нужно для «Восстановления»: хронология и онлайн при обнаружении. */
type RecoverySource = { timeline: IncidentEvent[]; diagnostics?: NodeTcpDiagnostics | null };
/**
 * Строки «Восстановления» из события (витрина telegram-2026-10, вариант A): онлайн при обнаружении → сейчас (до
 * падения), прежний адрес, если его меняли, свежая проверка порта на нынешнем адресе, последнее о DNS-записи.
 */
export function recoveryFacts(
  row: RecoverySource,
  online: number | null,
  usual: number | null,
  report: TcpReport | null,
): RecoveryFacts {
  const drop = row.diagnostics?.online ?? null;
  const moved =
    row.timeline
      .find((e) => e.step === 'address')
      ?.detail?.split(' → ')[0]
      ?.trim() || null;
  const parsed = report?.verdict === 'reachable' ? tcpCheckReportSchema.safeParse(report) : null;
  return {
    online:
      online === null ? null : { low: drop?.after ?? null, now: online, before: drop?.before ?? null, usual },
    oldAddress: moved,
    tcp: parsed?.success ? parsed.data : null,
    dns: dnsFact(row.timeline),
  };
}
/** Последнее о DNS-записи ноды: «DNS-запись nl1.example.ru» — «обновлена автоматически» или ⚠️ что не так. */
function dnsFact(timeline: IncidentEvent[]): NonNullable<RecoveryFacts['dns']> | null {
  const last = timeline.filter((e) => e.step === 'dns' && e.tone !== 'info').at(-1);
  if (!last) return null;
  const m = /^DNS-запись (\S+) (.+)$/.exec(last.action);
  const label = m ? `DNS-запись ${m[1]}` : 'DNS-запись';
  const what = m?.[2] ?? `${last.action.charAt(0).toLowerCase()}${last.action.slice(1)}`;
  if (last.tone === 'ok') return { label, text: what };
  return { label, text: `⚠️ ${what}${/старый адрес/.test(what) ? ' — замените вручную' : ''}` };
}
/** Кнопка к DNS-записи, которую нужно заменить вручную: последний DNS-шаг события не «готово». */
export function dnsManualLink(timeline: IncidentEvent[]): { to: string; label: string } | null {
  const last = timeline.filter((e) => e.step === 'dns' && e.tone !== 'info').at(-1);
  const link = last && last.tone !== 'ok' ? last.link : null;
  if (!link?.to) return null;
  const record = link.search?.record;
  return {
    to: `${link.to}${record ? `?record=${encodeURIComponent(record)}` : ''}`,
    label: 'Открыть запись DNS',
  };
}

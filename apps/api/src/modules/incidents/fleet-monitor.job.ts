import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type {
  IncidentKind,
  MonitoringSettings,
  NodeTcpDiagnostics,
  RemnawaveNode,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { PanelPulse } from '../health/panel-pulse.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NodePreferencesStore } from '../remnawave/node-preferences.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { CheckHostService, describeTcp, type TcpReport } from './check-host.service.js';
import { dropDetected, memoryPercent, type Sample, stableBaseline } from './fleet-monitor.logic.js';
import { IncidentsRepository } from './incidents.repository.js';

type State = {
  samples: Sample[];
  lastAt: number;
  dropSeen: number;
  baseline: number | null;
  recovered: number;
  downSeen: number;
  cpuSince: number | null;
  memSince: number | null;
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
});
type ProbeState = {
  report: TcpReport | null;
  attemptAt: number;
  address: string;
  port: number;
  nodePort?: number | null;
};
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
  ) {}
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
  @Interval(10000)
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
        scope = this.scope(status.domain);
      for (const node of status.nodes) {
        if (node.isDisabled) continue;
        const key = `monitor.history.${scope}.${node.uuid}`;
        const st = (await this.read<State>(key)) ?? empty();
        if (stamp <= st.lastAt) continue;
        if (st.lastAt && stamp - st.lastAt > cfg.staleAfterMinutes * 60000) {
          Object.assign(st, empty());
        }
        const open = (await this.repo.list('open')).filter((r) => r.nodeUuid === node.uuid);
        st.downSeen = node.isConnected ? 0 : st.downSeen + 1;
        if (st.downSeen >= cfg.confirmSamples)
          await this.open(
            node,
            'node_down',
            'Нода не на связи',
            `Remnawave не видит ноду в ${st.downSeen} последовательных опросах.`,
          );
        if (node.isConnected && open.some((r) => r.kind === 'node_down')) {
          const count = Number((await this.read<number>(key + '.connected')) ?? 0) + 1;
          await this.write(key + '.connected', count);
          if (count >= cfg.recoverySamples)
            await this.resolve(node, 'node_down', 'Связь с Remnawave восстановлена.');
        } else await this.write(key + '.connected', 0);
        if (node.usersOnline !== null) {
          const base = st.baseline ?? stableBaseline(st.samples, stamp, cfg);
          if (dropDetected(node.usersOnline, base, cfg)) {
            st.dropSeen++;
            st.baseline = base;
            st.recovered = 0;
            if (
              st.dropSeen >= cfg.confirmSamples &&
              !open.some((r) => ['node_blocked', 'server_down'].includes(r.kind))
            )
              this.verifyDrop(node, base ?? 0, node.usersOnline, cfg, scope);
          } else {
            st.dropSeen = 0;
            if (st.baseline !== null && node.usersOnline >= (st.baseline * cfg.recoveryPercent) / 100)
              st.recovered++;
            else st.recovered = 0;
            if (st.recovered >= cfg.recoverySamples) {
              // A TCP incident only recovers after a new positive TCP test, not merely a rising online count.
              const probe = await this.read<ProbeState>(`monitor.tcp.${scope}.${node.uuid}`);
              if (
                !cfg.checkHostOnDrop ||
                (probe?.report?.verdict === 'reachable' &&
                  Date.parse(probe.report.checkedAt) > Date.now() - cfg.checkHostCooldownMinutes * 60000)
              ) {
                await this.resolve(
                  node,
                  'node_blocked',
                  'Онлайн восстановился, TCP-проверка не показывает ограничения.',
                );
                await this.resolve(node, 'server_down', 'Онлайн и доступность TCP-порта восстановились.');
                st.baseline = null;
              } else if (!this.verifying.has(node.uuid))
                this.verifyDrop(node, st.baseline ?? 0, node.usersOnline, cfg, scope, true);
            }
          }
          st.samples = [
            ...st.samples.filter((s) => s.at > stamp - cfg.dropWindowMinutes * 60000),
            { at: stamp, online: node.usersOnline },
          ].slice(-500);
        } else {
          st.dropSeen = 0;
          st.recovered = 0;
        }
        const cpu = typeof node.cpuPercent === 'number' ? node.cpuPercent : null,
          mem = memoryPercent(node);
        const thresholds = this.preferences
          ? await this.preferences.forMonitoring(status.domain, node.uuid)
          : null;
        st.cpuSince = await this.resource(
          node,
          'cpu_high',
          cpu,
          cfg.cpuEnabled,
          thresholds?.cpuWarningPercent ?? cfg.cpuPercent,
          st.cpuSince,
          stamp,
          cfg,
        );
        st.memSince = await this.resource(
          node,
          'mem_high',
          mem,
          cfg.memoryEnabled,
          thresholds?.memoryWarningPercent ?? cfg.memoryPercent,
          st.memSince,
          stamp,
          cfg,
        );
        st.lastAt = stamp;
        await this.write(key, st);
      }
    } catch (e) {
      this.log.warn(e instanceof Error ? e.message : 'Ошибка мониторинга');
    } finally {
      this.busy = false;
    }
  }
  private async resource(
    node: RemnawaveNode,
    kind: IncidentKind,
    value: number | null,
    enabled: boolean,
    threshold: number,
    since: number | null,
    at: number,
    cfg: MonitoringSettings,
  ): Promise<number | null> {
    if (!enabled || value === null) return null;
    if (value >= threshold) {
      const start = since ?? at;
      if (at - start >= cfg.resourceDurationMinutes * 60000)
        await this.open(
          node,
          kind,
          kind === 'cpu_high' ? 'Высокая загрузка процессора' : 'Высокая занятость памяти',
          `${Math.round(value)}% в течение ${cfg.resourceDurationMinutes} мин. Источник: Remnawave API.`,
        );
      return start;
    }
    if (value <= threshold - 5) await this.resolve(node, kind, 'Метрика вернулась ниже порога с запасом 5%.');
    return null;
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
        report =
          current &&
          old?.report &&
          Date.now() - Date.parse(old.report.checkedAt) < cfg.checkHostCooldownMinutes * 60000
            ? old.report
            : await this.checkHost.checkNode(node.address, cfg.checkHostPort, node.port);
        await this.write(key, {
          report,
          attemptAt: Date.now(),
          address: node.address,
          port: cfg.checkHostPort,
          nodePort: node.port ?? null,
        });
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
      const conclusion =
        report?.verdict === 'russia_unreachable'
          ? 'TCP-порт недоступен из РФ, доступен из других стран. Вероятное ограничение из РФ.'
          : report?.verdict === 'port_unreachable'
            ? 'TCP-порт недоступен из РФ и других стран. Сервер или порт недоступен.'
            : report?.verdict === 'reachable'
              ? 'TCP-порт доступен из РФ и других стран. Причина падения онлайна не подтверждена.'
              : 'Доступность из РФ не подтверждена: недостаточно данных TCP-проверки.';
      await this.open(
        node,
        kind,
        report?.verdict === 'russia_unreachable'
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
    const row = await this.repo.open({
      nodeUuid: node.uuid,
      serverId: null,
      serverName: node.name,
      ...(diagnostics ? { diagnostics } : {}),
      kind,
      severity: kind === 'cpu_high' || kind === 'mem_high' ? 'warn' : 'crit',
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
    if (row)
      await this.notifications.push({
        severity: row.severity as 'crit' | 'warn',
        title,
        body: detail,
        link: { to: '/incidents/' + row.id, label: 'Открыть инцидент' },
        telegram: {
          event: row.severity === 'crit' ? 'incident_crit' : 'incident_warn',
          incidentId: row.id,
          kind,
          serverKey: 'node:' + node.uuid,
          server: { name: node.name, host: node.address },
          awaitAnalysis: false,
        },
      });
  }
  private async resolve(
    node: RemnawaveNode,
    kind: IncidentKind,
    detail: string,
    diagnostics?: NodeTcpDiagnostics,
  ) {
    const row = (await this.repo.list('open')).find((r) => r.nodeUuid === node.uuid && r.kind === kind);
    if (!row) return;
    await this.repo.update(row.id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'auto',
      timeline: [
        ...row.timeline,
        { at: new Date().toISOString(), by: 'auto', action: detail, result: 'detect' },
      ],
    });
    await this.notifications.push({
      severity: 'ok',
      title: 'Восстановление · ' + node.name,
      body: detail,
      telegram: {
        event: 'resolved',
        incidentId: row.id,
        kind,
        serverKey: 'node:' + node.uuid,
        server: { name: node.name, host: node.address },
        closed: { recovered: true },
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
      let count = 0;
      for (const node of status.nodes) {
        if (node.isDisabled || this.verifying.has(node.uuid)) continue;
        const key = `monitor.tcp.${scope}.${node.uuid}`,
          old = await this.read<ProbeState>(key);
        if (
          old?.address === node.address &&
          old.port === cfg.checkHostPort &&
          old.nodePort === (node.port ?? null) &&
          Date.now() - old.attemptAt < cfg.checkHostHours * 3600000
        )
          continue;
        const report = await this.checkHost.checkNode(node.address, cfg.checkHostPort, node.port);
        await this.write(key, {
          report,
          attemptAt: Date.now(),
          address: node.address,
          port: cfg.checkHostPort,
          nodePort: node.port ?? null,
        });
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
        if (report.verdict === 'russia_unreachable' || report.verdict === 'port_unreachable')
          await this.open(
            node,
            report.verdict === 'port_unreachable' ? 'server_down' : 'node_blocked',
            report.verdict === 'port_unreachable' ? 'TCP-порт недоступен' : 'TCP-порт недоступен из РФ',
            `${describeTcp(report)}\n${report.verdict === 'russia_unreachable' ? 'Из других стран порт доступен. Вероятное ограничение из РФ.' : 'Порт не отвечает из РФ и других стран; это не доказательство остановки всего сервера.'}\n${report.link ?? ''}`,
            { source: 'checkhost', report },
          );
        if (report.verdict === 'reachable') {
          const history = await this.read<State>(`monitor.history.${scope}.${node.uuid}`);
          if (!history?.baseline) {
            await this.resolve(node, 'node_blocked', 'TCP-порт снова доступен.');
            await this.resolve(node, 'server_down', 'TCP-порт снова доступен.');
          }
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

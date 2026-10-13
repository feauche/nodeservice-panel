import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  formatScenarioHostName,
  type MonitoringSettings,
  type RemnawaveNode,
  type Scenario,
  scenarioConditionLabel,
  scenarioConditionMatches,
  scenarioConditions,
  type TcpCheckReport,
  tcpCheckReportSchema,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { CheckHostService } from '../incidents/check-host.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { NodeEventsStore } from '../node-events/node-events.store.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { HOSTS_UPDATE_SCOPE, RemnaPermissionsService } from '../remnawave/remna-permissions.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { getJson, RemnawaveApiError } from '../remnawave/remnawave-client.js';
import { RemnawaveSettingsStore } from '../remnawave/remnawave-settings.store.js';
import { RemnawaveTopologyService } from '../remnawave/remnawave-topology.service.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { ScenariosStore } from './scenarios.store.js';

type State = {
  since: number | null;
  stamp: number;
  latched: boolean;
  lastRun: number;
  healthySamples?: number;
  /** Сценарий менял Host на этом сбое: после восстановления ноды вернуть его или сказать, почему нельзя. */
  pendingRestore?: boolean;
};
type Ledger = {
  ruleId: string;
  nodeUuid: string;
  hostUuid: string;
  afterHash: string | null;
  confirmed: boolean;
  hasVersion: boolean;
  restored: boolean;
  original?: { isDisabled?: boolean; remark?: string };
  /** Что поставил сценарий: по этим полям видно, меняли ли Host вручную после него. */
  after?: { isDisabled?: boolean; remark?: string };
};
const stable = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.entries(x)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stable(v)]),
        )
      : x;
export const hostFingerprint = (host: Record<string, unknown>) =>
  createHash('sha256')
    .update(JSON.stringify(stable(host)))
    .digest('hex');
export const renameHost = formatScenarioHostName;
/** Предел имени Host в Remnawave (знаков, как считает её проверка). */
export const HOST_REMARK_MAX = 100;
const previousName = (host: Record<string, unknown>) => String(host.remark ?? host.uuid ?? 'Host').trim();
const keepDisabled = (host: Record<string, unknown>) =>
  typeof host.isDisabled === 'boolean' ? { isDisabled: host.isDisabled } : {};
/** Значение поля Host после изменения то, что отправляли; у имени пробелы по краям не считаются. */
export const sameHostValue = (key: string, actual: unknown, expected: unknown) =>
  key === 'remark' ? String(actual ?? '').trim() === String(expected ?? '').trim() : actual === expected;
/**
 * Host после сценария не трогали. Если Remnawave отдаёт версию Host, сверяем полный снимок: видна любая ручная
 * правка. Версии нет (Remnawave 3.4 её не отдаёт) — сверяем имя и «выключен», которые поставил сценарий: прочие
 * настройки Host возврату не мешают. У записей до 0.93.0 этих полей нет — полный снимок.
 */
const stillOurs = (host: Record<string, unknown>, ledger: Ledger) =>
  ledger.hasVersion || !ledger.after
    ? hostFingerprint(host) === ledger.afterHash
    : Object.entries(ledger.after).every(([key, value]) => sameHostValue(key, host[key], value));
/** Host сейчас такой же, каким был до изменения: значит, прошлая неподтверждённая попытка его не изменила. */
const untouched = (host: Record<string, unknown>, original: Ledger['original']) =>
  !!original &&
  Object.keys(original).length > 0 &&
  Object.entries(original).every(([key, value]) => host[key] === value);
export const hostNodes = (host: Record<string, unknown>) =>
  Array.isArray(host.nodes) ? host.nodes.map((v) => (typeof v === 'string' ? v : String(v?.uuid ?? ''))) : [];
export const scenarioSignals = (node: RemnawaveNode, rows: Record<string, unknown>[]) => ({
  offline: !node.isConnected,
  online_drop: rows.some(
    (i) => i.node_uuid === node.uuid && ['node_blocked', 'server_down'].includes(String(i.kind)),
  ),
  tcp_unreachable: rows.some(
    (i) =>
      i.node_uuid === node.uuid &&
      ['node_blocked', 'server_down'].includes(String(i.kind)) &&
      ['russia_unreachable', 'port_unreachable'].includes(
        String((i.diagnostics as { report?: { verdict?: string } } | null)?.report?.verdict),
      ),
  ),
});
/** Название события без подстановки имени сервера: «Нода не на связи · {server}» → «Нода не на связи». */
const incidentName = (title: string) => title.replace(/ · \{server\}$/, '');
/** Первая буква строчной в середине фразы — только у русского слова: «TCP доступен» и «Host …» не трогаем. */
const lowerFirst = (s: string) => (/^[А-ЯЁ][а-яё]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
@Injectable()
export class ScenariosJob {
  private busy = false;
  private log = new Logger(ScenariosJob.name);
  constructor(
    @Inject(DB) private db: Db,
    private store: ScenariosStore,
    private remna: RemnawaveService,
    private credentials: RemnawaveSettingsStore,
    private monitoring: MonitoringStore,
    private tcp: CheckHostService,
    private events: NodeEventsStore,
    private notify: NotificationsService,
    @Optional() private topology?: RemnawaveTopologyService,
    @Optional() private permissions?: RemnaPermissionsService,
    @Optional() private incidents?: IncidentsService,
  ) {}
  /**
   * Изменение Host в Remnawave с учётом права ключа: отказ виден в «Разрешениях API-ключа», а в итоге
   * сценария — словами, какого права не хватает (а не «токен неверный»).
   */
  private async patchHost(c: { domain: string; apiKey: string }, body: Record<string, unknown>) {
    const call = () =>
      getJson(`https://${c.domain}/api/hosts`, c.apiKey, { method: 'PATCH', body: JSON.stringify(body) });
    try {
      return await (this.permissions ? this.permissions.observe(HOSTS_UPDATE_SCOPE, c, call) : call());
    } catch (e) {
      if (e instanceof RemnawaveApiError && e.status === 403)
        throw new RemnawaveApiError(
          'У API-ключа нет права «Изменение Host» — Host не изменён. Права ключа в Remnawave не меняются: нужен новый ключ с правом на изменение Host.',
          'unauthorized',
          403,
        );
      throw e;
    }
  }
  @Interval(30000) async tick() {
    if (process.env.NODE_ENV !== 'test') await this.run();
  }
  private async hosts(domain: string, key: string) {
    const r = await getJson(`https://${domain}/api/hosts`, key);
    const v = r.response;
    return (
      Array.isArray(v)
        ? v
        : v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).hosts)
          ? (v as Record<string, unknown>).hosts
          : []
    ) as Record<string, unknown>[];
  }
  private async event(
    panel: string,
    rule: Scenario,
    node: RemnawaveNode,
    summary: string,
    id = randomUUID(),
  ) {
    await this.events.append(panel, {
      id: `scenario:${rule.id}:${node.uuid}:${id}`,
      t: Date.now(),
      nodeUuid: node.uuid,
      nodeName: node.name,
      type: 'automation',
      title: `Сценарий · ${rule.name}`,
      summary,
      link: '/scenarios',
    });
  }
  private async tcpReport(
    panel: string,
    node: RemnawaveNode,
    cfg: MonitoringSettings,
    probe: boolean,
    maxAge?: number,
  ): Promise<TcpCheckReport | null> {
    const key = `scenarios.tcp.${this.store.scope(panel)}.${node.uuid}`;
    const target = `${node.address}:${cfg.checkHostPort}:${node.port ?? ''}`;
    const cached = await this.store.read<{ target: string; report: unknown }>(key);
    const parsed = tcpCheckReportSchema.safeParse(cached?.report);
    if (cached?.target === target && parsed.success) {
      const age = Date.now() - Date.parse(parsed.data.checkedAt);
      const ttl =
        maxAge ?? (parsed.data.verdict === 'unknown' ? 60000 : cfg.checkHostCooldownMinutes * 60000);
      if (age >= 0 && age < ttl) return parsed.data;
    }
    if (!probe || !cfg.checkHostEnabled) return null;
    const report = tcpCheckReportSchema.parse(
      await this.tcp.checkNode(node.address, cfg.checkHostPort, node.port),
    );
    await this.store.write(key, { target, report });
    await this.events.append(panel, {
      id: `scenario-tcp:${node.uuid}:${report.checkedAt}`,
      t: Date.parse(report.checkedAt),
      nodeUuid: node.uuid,
      nodeName: node.name,
      type: 'tcp_check',
      title: 'TCP-проверка условия сценария',
      summary: `${report.target}: ${report.verdict === 'reachable' ? 'доступен' : report.verdict === 'unknown' ? 'недостаточно данных' : report.verdict === 'russia_unreachable' ? 'недоступен из РФ' : 'порты недоступны'}`,
      link: report.link,
    });
    return report;
  }
  private async signals(
    panel: string,
    rule: Scenario,
    node: RemnawaveNode,
    rows: Record<string, unknown>[],
    cfg: MonitoringSettings,
    probe: boolean,
  ) {
    const signals = scenarioSignals(node, rows);
    if (scenarioConditions(rule).includes('tcp_unreachable')) {
      const report = cfg.checkHostEnabled ? await this.tcpReport(panel, node, cfg, probe) : null;
      signals.tcp_unreachable =
        report?.verdict === 'russia_unreachable' || report?.verdict === 'port_unreachable';
    }
    return signals;
  }
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      const [status, cfg] = await Promise.all([this.remna.status(), this.monitoring.get()]);
      if (
        !cfg.enabled ||
        !status.domain ||
        status.error ||
        !status.checkedAt ||
        Date.now() - Date.parse(status.checkedAt) > cfg.staleAfterMinutes * 60000
      )
        return;
      const panel = status.domain,
        rules = await this.store.list(panel),
        scope = this.store.scope(panel),
        stamp = Date.parse(status.checkedAt);
      if (!rules.some((r) => r.enabled)) return;
      const incidents = await this.db.execute(
        sql`SELECT node_uuid,kind,diagnostics FROM incidents WHERE status IN ('open','acknowledged') AND node_uuid IS NOT NULL`,
      );
      const issue = (uuid: string, kinds: string[]) =>
        incidents.rows.some((i) => i.node_uuid === uuid && kinds.includes(String(i.kind)));
      for (const rule of rules.filter((r) => r.enabled))
        for (const node of status.nodes.filter(
          (n) => !n.isDisabled && (rule.scope === 'all' || rule.nodes.includes(n.uuid)),
        )) {
          const stateKey = `scenarios.state.${scope}.${rule.id}.${node.uuid}`,
            state = (await this.store.read<State>(stateKey)) ?? {
              since: null,
              stamp: 0,
              latched: false,
              lastRun: 0,
            };
          if (stamp <= state.stamp) continue;
          if (state.stamp && stamp - state.stamp > cfg.staleAfterMinutes * 60000) state.since = null;
          const condition = scenarioConditionMatches(
            rule,
            await this.signals(panel, rule, node, incidents.rows, cfg, true),
          );
          if (!condition) {
            state.since = null;
            state.latched = false;
          } else state.since ??= Math.min(stamp, Date.now());
          state.healthySamples =
            !condition && node.isConnected && !issue(node.uuid, ['node_down', 'node_blocked', 'server_down'])
              ? (state.healthySamples ?? 0) + 1
              : 0;
          state.stamp = stamp;
          if (
            condition &&
            !state.latched &&
            state.since !== null &&
            Date.now() - state.since >= rule.holdMinutes * 60000 &&
            Date.now() - state.lastRun >= rule.cooldownMinutes * 60000
          ) {
            // Durable reservation prevents a process restart from repeating an external action.
            state.latched = true;
            state.lastRun = Date.now();
            await this.store.write(stateKey, state);
            const runId = randomUUID(),
              results: string[] = [];
            let hostActionDone = false,
              failed = false,
              incident: { id: string; title: string } | null = null;
            for (const action of rule.actions.filter((a) => a !== 'notify'))
              try {
                const current = await this.remna.status();
                if (current.domain !== panel || current.error) throw new Error('Подключение изменилось');
                if (action === 'check_tcp') {
                  const report = await this.tcpReport(panel, node, cfg, true, 60000);
                  if (!report) throw new Error('TCP-проверки выключены в настройках');
                  results.push(
                    report.verdict === 'reachable'
                      ? 'TCP доступен'
                      : report.verdict === 'unknown'
                        ? 'TCP: недостаточно данных'
                        : 'TCP недоступен',
                  );
                }
                if (action === 'record_event') {
                  // Событие заводит мониторинг; сценарий дописывает в него, что сделал. Нет события — только «Метрики».
                  incident = (await this.incidents?.forNode(node.uuid)) ?? null;
                  results.push(
                    incident
                      ? `Записано в событие «${incidentName(incident.title)}»`
                      : 'Открытого события у ноды нет — запись только в «Метриках»',
                  );
                }
                if ((action === 'hide_host' || action === 'rename_host') && !hostActionDone) {
                  hostActionDone = true;
                  results.push(await this.hide(panel, scope, rule, node));
                  state.pendingRestore = true;
                }
              } catch (e) {
                failed = true;
                results.push(e instanceof Error ? e.message : 'Действие не выполнено');
                break;
              }
            const summary = results.join('; ');
            await this.event(panel, rule, node, summary, runId);
            if (incident)
              await this.incidents?.note(
                incident.id,
                `Сценарий «${rule.name}»: ${lowerFirst(summary)}`,
                failed ? 'failed' : 'applied',
              );
            if (rule.actions.includes('notify'))
              await this.notify.push({
                severity: 'warn',
                title: `Сценарий: ${rule.name}`,
                // Сценарий только с уведомлением: шагов нет — строки «Результат:» без значения тоже нет.
                body: [
                  `Нода: ${node.name}`,
                  `Условие: ${scenarioConditionLabel(rule)}`,
                  summary && `Результат: ${summary}`,
                ]
                  .filter(Boolean)
                  .join('\n'),
                link: { to: '/scenarios', label: 'Открыть сценарии' },
                telegram: {
                  event: 'scenario',
                  serverKey: `node:${node.uuid}`,
                  server: { name: node.name, host: node.address },
                },
              });
          }
          // Возврат Host — когда нода здорова нужное число опросов подряд; не вышло (нет ответа) — на следующем опросе.
          // Состояния до 0.93.0 без отметки проверяются один раз.
          if (
            !condition &&
            state.pendingRestore !== false &&
            state.lastRun > 0 &&
            (state.healthySamples ?? 0) >= cfg.recoverySamples &&
            node.isConnected &&
            !issue(node.uuid, ['node_down', 'node_blocked', 'server_down'])
          )
            state.pendingRestore = (await this.restore(panel, scope, rule, node)) === 'retry';
          await this.store.write(stateKey, state);
        }
    } catch (e) {
      this.log.warn(e instanceof Error ? e.message : 'Сценарии не выполнены');
    } finally {
      this.busy = false;
    }
  }
  private async hostLinks() {
    if (!this.topology) return new Map<string, string[]>();
    const topology = await this.topology.get(true);
    return new Map(topology.hosts.map((h) => [h.id, h.nodeUuids]));
  }
  private linkedNodes(host: Record<string, unknown>, links: Map<string, string[]>, rule?: Scenario) {
    const automatic = links.get(String(host.uuid)) ?? hostNodes(host);
    const manual = rule?.hostBindings?.find((b) => b.hostUuid === host.uuid);
    // Explicit multi-node Host cannot be made exclusive by a scenario override.
    if (hostNodes(host).length > 1 || automatic.length > 1)
      return automatic.length > 1 ? automatic : hostNodes(host);
    return automatic.length ? automatic : manual ? [manual.nodeUuid] : [];
  }
  async previewHosts() {
    const [status, c] = await Promise.all([this.remna.status(), this.credentials.credentials()]);
    if (!c || !status.domain || c.domain !== status.domain) throw new Error('Подключите Remnawave.');
    const scope = this.store.scope(c.domain);
    const [hosts, links, rules] = await Promise.all([
      this.hosts(c.domain, c.apiKey),
      this.hostLinks(),
      this.store.list(c.domain),
    ]);
    return {
      hosts: await Promise.all(
        hosts
          .filter((h) => typeof h.uuid === 'string')
          .map(async (h) => {
            const nodes = this.linkedNodes(h, links),
              saved = await this.store.read<Ledger>(`scenarios.host.${scope}.${h.uuid}`),
              // Неподтверждённая попытка, после которой Host не изменился, — не владение и не повод для тревоги.
              ledger = saved && (saved.confirmed || !untouched(h, saved.original)) ? saved : null;
            return {
              uuid: String(h.uuid),
              name: String(h.remark ?? h.name ?? h.uuid),
              address: String(h.address ?? ''),
              port: typeof h.port === 'number' ? h.port : null,
              nodes,
              bindingSource:
                links.has(String(h.uuid)) && nodes.length
                  ? 'IP/DNS, UUID ноды или уникальный inbound'
                  : hostNodes(h).length
                    ? 'UUID ноды в Host'
                    : 'Требуется ручная привязка',
              nodeNames: nodes.map((id) => status.nodes.find((n) => n.uuid === id)?.name ?? id),
              disabled: h.isDisabled === true,
              eligible: nodes.length === 1 && !h.isDisabled,
              reason:
                nodes.length !== 1
                  ? nodes.length
                    ? 'Общий Host: изменение пропускается'
                    : 'Связь не определена; назначьте ноду вручную'
                  : h.isDisabled
                    ? 'Уже выключен'
                    : 'Может быть скрыт по сценарию',
              ownedBy: ledger && !ledger.restored ? ledger.ruleId : null,
              restoration:
                ledger && !ledger.restored
                  ? !ledger.confirmed
                    ? 'Результат изменения не подтверждён — требуется ручная проверка'
                    : !stillOurs(h, ledger)
                      ? 'Host изменён вручную после сценария — сценарий его не вернёт'
                      : rules.find((r) => r.id === ledger.ruleId)?.autoRestore
                        ? 'Изменён сценарием — вернётся после восстановления ноды'
                        : 'Изменён сценарием — возврат выключен, верните его в Remnawave сами'
                  : null,
            };
          }),
      ),
    };
  }
  async hide(panel: string, scope: string, rule: Scenario, node: RemnawaveNode) {
    const c = await this.credentials.credentials();
    if (!c || c.domain !== panel) throw new Error('Подключение изменилось');
    const [hosts, links] = await Promise.all([this.hosts(panel, c.apiKey), this.hostLinks()]);
    let changed = 0,
      shared = 0;
    const names: string[] = [];
    for (const host of hosts) {
      const nodes = this.linkedNodes(host, links, rule);
      if (!nodes.includes(node.uuid)) continue;
      if (nodes.length !== 1) {
        shared++;
        continue;
      }
      if (typeof host.uuid !== 'string') continue;
      const patch: { isDisabled?: boolean; remark?: string } = {},
        original: { isDisabled?: boolean; remark?: string } = {};
      if (rule.actions.includes('hide_host') && !host.isDisabled) {
        patch.isDisabled = true;
        original.isDisabled = false;
      }
      if (rule.actions.includes('rename_host')) {
        const previous = String(host.remark ?? '');
        const next = renameHost(previous, rule.renameMode, rule.renameText);
        // Remnawave принимает имя Host до 100 знаков: длиннее — отказ, лучше сказать об этом словами заранее.
        if (next !== previous && next.length > HOST_REMARK_MAX)
          throw new Error(
            `Новое имя Host «${previous}» длиннее ${HOST_REMARK_MAX} знаков — Remnawave его не примет. Сократите текст сценария.`,
          );
        if (next !== previous) {
          patch.remark = next;
          original.remark = previous;
        }
      }
      if (!Object.keys(patch).length) continue;
      const key = `scenarios.host.${scope}.${host.uuid}`,
        old = await this.store.read<Ledger>(key);
      // Неподтверждённая прошлая попытка, а Host как был: изменение тогда не прошло — Host снова свободен.
      if (old && !old.restored && (old.confirmed || !untouched(host, old.original))) continue;
      const ledger: Ledger = {
        ruleId: rule.id,
        nodeUuid: node.uuid,
        hostUuid: host.uuid,
        afterHash: null,
        confirmed: false,
        hasVersion: false,
        restored: false,
        original,
      };
      const current = await this.remna.status();
      const currentRules = await this.store.list(panel);
      if (
        current.domain !== panel ||
        current.error ||
        !currentRules.some(
          (r) =>
            r.id === rule.id &&
            r.enabled &&
            (r.scope === 'all' || r.nodes.includes(node.uuid)) &&
            JSON.stringify(r) === JSON.stringify(rule),
        )
      )
        throw new Error('Сценарий или подключение изменились');
      const freshNode = current.nodes.find((n) => n.uuid === node.uuid);
      const freshIssues = await this.db.execute(
        sql`SELECT node_uuid,kind,diagnostics FROM incidents WHERE status IN ('open','acknowledged') AND node_uuid = ${node.uuid}`,
      );
      if (
        !freshNode ||
        freshNode.isDisabled ||
        !scenarioConditionMatches(
          rule,
          await this.signals(panel, rule, freshNode, freshIssues.rows, await this.monitoring.get(), false),
        )
      )
        throw new Error('Условия больше не подтверждены или нода исключена — изменение Host отменено');
      const freshLinks = await this.hostLinks();
      const fresh = (await this.hosts(panel, c.apiKey)).find((h) => h.uuid === host.uuid);
      if (!fresh || hostFingerprint(fresh) !== hostFingerprint(host))
        throw new Error('Host изменён другим администратором; действие пропущено');
      const currentNodes = this.linkedNodes(fresh, freshLinks, rule);
      if (currentNodes.length !== 1 || currentNodes[0] !== node.uuid)
        throw new Error('Привязка Host изменилась — действие отменено');
      await this.store.write(key, ledger);
      try {
        // «Выключен» передаём явно: в старых Remnawave (до 3.4) изменение без него включало выключенный Host.
        await this.patchHost(c, { uuid: host.uuid, ...keepDisabled(host), ...patch });
      } catch (e) {
        // Remnawave ответила отказом (4xx) — изменение точно не применено, запись о владении снимаем. Без ответа
        // (сеть, таймаут, 5xx) итог неизвестен: запись остаётся, следующая попытка сверит Host с исходным.
        if (e instanceof RemnawaveApiError && e.status !== null && e.status < 500)
          await this.store.remove(key);
        throw e;
      }
      const after = (await this.hosts(panel, c.apiKey)).find((h) => h.uuid === host.uuid);
      if (!after || Object.entries(patch).some(([key, value]) => !sameHostValue(key, after[key], value)))
        throw new Error('Изменение Host не подтверждено');
      ledger.afterHash = hostFingerprint(after);
      ledger.after = patch;
      ledger.confirmed = true;
      ledger.hasVersion = typeof after.updatedAt === 'string';
      await this.store.write(key, ledger);
      changed++;
      names.push(
        patch.remark ? `«${original.remark}» → «${patch.remark.trim()}»` : `«${previousName(host)}»`,
      );
    }
    const what = rule.actions.includes('rename_host')
      ? rule.actions.includes('hide_host')
        ? 'Изменено и скрыто'
        : 'Изменено имя'
      : 'Скрыто';
    // До трёх Host — по именам, больше — числом: строка уходит и в событие, и в Telegram.
    return `${what} Host: ${changed > 0 && changed <= 3 ? names.join(', ') : changed}${shared ? `; общих Host пропущено: ${shared}` : ''}`;
  }
  /**
   * После восстановления ноды: вернуть Host, которые менял этот сценарий, или сказать в событии ноды, почему
   * нельзя. 'retry' — нода или подключение ещё не готовы либо Remnawave не ответила: попробуем на следующем опросе.
   */
  async restore(
    panel: string,
    scope: string,
    rule: Scenario,
    node: RemnawaveNode,
  ): Promise<'done' | 'retry'> {
    const c = await this.credentials.credentials();
    if (!c || c.domain !== panel) return 'retry';
    const hosts = await this.hosts(panel, c.apiKey);
    let retry = false;
    const report = async (text: string, result: 'helped' | 'failed') => {
      await this.event(panel, rule, node, text);
      // Событие ноды к этому времени обычно уже закрыто — дописываем в недавнее (за последние сутки).
      const incident = await this.incidents?.forNode(node.uuid, 86_400_000);
      if (incident)
        await this.incidents?.note(incident.id, `Сценарий «${rule.name}»: ${lowerFirst(text)}`, result);
    };
    for (const host of hosts) {
      if (typeof host.uuid !== 'string') continue;
      const key = `scenarios.host.${scope}.${host.uuid}`,
        ledger = await this.store.read<Ledger>(key);
      if (
        !ledger ||
        ledger.restored ||
        !ledger.confirmed ||
        ledger.ruleId !== rule.id ||
        ledger.nodeUuid !== node.uuid
      )
        continue;
      const name = previousName(host);
      const release = async () => {
        ledger.restored = true;
        await this.store.write(key, ledger);
      };
      if (!rule.autoRestore) {
        await release();
        await report(
          `Host «${name}» остаётся изменённым: возврат выключен в сценарии. Верните его в Remnawave сами.`,
          'failed',
        );
        continue;
      }
      if (untouched(host, ledger.original)) {
        // Host уже такой, каким был до сценария (вернули вручную) — возвращать нечего.
        await release();
        await report(`Host «${name}» уже в исходном виде — его вернули вручную`, 'helped');
        continue;
      }
      if (!stillOurs(host, ledger)) {
        await release();
        await report(
          `Host «${name}» не возвращён: после сценария его изменили вручную. Проверьте его в Remnawave.`,
          'failed',
        );
        continue;
      }
      const current = await this.remna.status();
      if (
        current.domain !== panel ||
        current.error ||
        !current.nodes.find((n) => n.uuid === node.uuid)?.isConnected
      )
        return 'retry';
      const fresh = (await this.hosts(panel, c.apiKey)).find((h) => h.uuid === host.uuid);
      if (!fresh || !stillOurs(fresh, ledger)) {
        await release();
        await report(
          `Host «${name}» не возвращён: его изменили вручную. Проверьте его в Remnawave.`,
          'failed',
        );
        continue;
      }
      const back = ledger.original ?? { isDisabled: false };
      try {
        await this.patchHost(c, { uuid: host.uuid, ...keepDisabled(fresh), ...back });
      } catch (e) {
        // Без ответа Remnawave итог неизвестен — повторим на следующем опросе; отказ — сообщаем и больше не пробуем.
        if (!(e instanceof RemnawaveApiError) || e.status === null || e.status >= 500) {
          retry = true;
          continue;
        }
        await release();
        await report(
          `Host «${name}» не возвращён: ${lowerFirst(e.message)} Верните его в Remnawave сами.`,
          'failed',
        );
        continue;
      }
      const after = (await this.hosts(panel, c.apiKey)).find((h) => h.uuid === host.uuid);
      await release();
      if (!after || Object.entries(back).some(([k, value]) => !sameHostValue(k, after[k], value))) {
        await report(`Возврат Host «${name}» не подтверждён — проверьте его в Remnawave.`, 'failed');
        continue;
      }
      await report(`Host «${previousName(after)}» возвращён после восстановления ноды`, 'helped');
    }
    return retry ? 'retry' : 'done';
  }
}

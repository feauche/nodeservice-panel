import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  formatScenarioHostName,
  type MonitoringSettings,
  type RemnawaveNode,
  type Scenario,
  type ScenarioRunStep,
  scenarioConditionLabel,
  scenarioConditionMatches,
  scenarioConditions,
  scenarioLabels,
  TCP_VERDICT_LABELS,
  type TcpCheckReport,
  tcpBlockedInRussia,
  tcpCheckReportSchema,
  tcpReachSummary,
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
  // Событие о падении онлайна, а проверка порта показала блокировку из РФ (полную или частичную, подтверждённую
  // повтором через минуту) или что порт не отвечает вовсе.
  tcp_unreachable: rows.some((i) => {
    const report = (i.diagnostics as { report?: { verdict?: string; confirmed?: boolean } } | null)?.report;
    return (
      i.node_uuid === node.uuid &&
      ['node_blocked', 'server_down'].includes(String(i.kind)) &&
      !!report?.verdict &&
      (tcpBlockedInRussia({ verdict: report.verdict, confirmed: report.confirmed }) ||
        report.verdict === 'port_unreachable')
    );
  }),
});
/** «нода потеряла связь и TCP недоступен» — условия сценария фразой для журнала. */
const conditionPhrase = (rule: Scenario) =>
  scenarioConditions(rule)
    .map((c) => lowerFirst(scenarioLabels[c]))
    .join(rule.conditionMode === 'all' ? ' и ' : ' или ');
/** Название события без подстановки имени сервера: «Нода не на связи · {server}» → «Нода не на связи». */
const incidentName = (title: string) => title.replace(/ · \{server\}$/, '');
/** Первая буква строчной в середине фразы — только у русского слова: «TCP доступен» и «Host …» не трогаем. */
const lowerFirst = (s: string) => (/^[А-ЯЁ][а-яё]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** Что сделал шаг с Host: какие скрыты, какие переименованы и почему ничего, если ничего. */
export type HostChange = {
  /** Итог одной строкой — для события ноды и Telegram. */
  text: string;
  hidden: string[];
  renamed: Array<{ from: string; to: string }>;
  shared: number;
  /** Своих Host у ноды (привязаны только к ней). */
  own: number;
  /** Своих Host, которые ещё держит прошлое срабатывание (не вернули). */
  held: number;
  /** Сколько Host видит Remnawave всего. */
  scanned: number;
  /** Host, чей адрес не разрешился в DNS: чьи они, неизвестно, — их не трогали. */
  unresolved: number;
};
/** До трёх имён — списком, больше — «и ещё N». */
const someNames = (list: string[]) =>
  list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} и ещё ${list.length - 3}`;
/** Шаг «Скрыть Host» или «Изменить имя Host» для журнала: слово-итог и какие Host. */
export function hostStep(action: 'hide_host' | 'rename_host', n: number, d: HostChange): ScenarioRunStep {
  const shared = d.shared ? `общих Host пропущено: ${d.shared}` : '';
  const hide = action === 'hide_host';
  const done = hide ? d.hidden.map((h) => `«${h}»`) : d.renamed.map((r) => `«${r.from}» → «${r.to}»`);
  if (done.length) {
    const word = hide ? (done.length === 1 ? 'скрыт' : `скрыто ${done.length}`) : 'изменено';
    const unknown = d.unresolved ? `не проверено Host (DNS не ответил): ${d.unresolved}` : '';
    const detail = [someNames(done), shared, unknown].filter(Boolean).join('; ');
    const what = hide
      ? done.length === 1
        ? 'Скрыт Host'
        : `Скрыто Host (${done.length})`
      : 'Изменено имя Host';
    return { action, n, tone: 'change', word, detail, text: `${what}: ${detail}` };
  }
  const word = hide ? 'не скрыт' : 'не изменено';
  const why = !d.own
    ? d.shared
      ? `у ноды только общие Host (${d.shared}) — их не трогаем`
      : d.scanned
        ? `у ноды нет своих Host (в Remnawave Host: ${d.scanned}, к этой ноде не привязан ни один)`
        : 'у ноды нет своих Host (в Remnawave нет ни одного Host)'
    : d.held
      ? 'Host ещё не вернули после прошлого срабатывания'
      : hide
        ? 'Host уже скрыт'
        : 'метка уже есть в имени';
  return {
    action,
    n,
    tone: d.own ? 'info' : 'warn',
    word,
    detail: why,
    text: `${hide ? 'Host не скрыт' : 'Имя Host не изменено'}: ${why}`,
  };
}
/**
 * Шаг «Уведомить в Telegram»: «отправлено» — только если сообщение действительно уйдёт сейчас. Выключенных
 * сообщений сценариев не бывает: шаг сам и есть согласие (event_off для них не приходит).
 */
export function notifyStep(
  n: number,
  outlook: 'send' | 'quiet' | 'off' | 'event_off' | null,
): ScenarioRunStep {
  const base = { action: 'notify' as const, n };
  if (outlook === 'quiet')
    return {
      ...base,
      tone: 'info',
      word: 'отложено',
      detail: 'тихие часы — придёт в утренней сводке',
      text: 'Уведомление в Telegram отложено до утра',
    };
  if (outlook === 'off')
    return {
      ...base,
      tone: 'warn',
      word: 'не отправлено',
      detail: 'Telegram не подключён — добавьте чат в «Настройки → Уведомления»',
      text: 'Уведомление в Telegram не отправлено: Telegram не подключён',
    };
  return {
    ...base,
    tone: 'info',
    word: outlook === 'send' ? 'отправлено' : 'передано',
    text: 'Уведомление в Telegram',
  };
}
/**
 * Шаг «Проверить TCP»: проверка — сведения для журнала, а не условие действий. Не вышла (Check-Host выключен или не
 * ответил) — замечание жёлтым, остальные шаги уже выполнены.
 */
export function tcpStep(
  n: number,
  result: { report: TcpCheckReport | null } | { error: string },
): ScenarioRunStep {
  const base = { action: 'check_tcp' as const, n };
  if ('error' in result || !result.report) {
    const why = 'error' in result ? result.error : 'TCP-проверки выключены в настройках';
    return { ...base, tone: 'warn', word: 'не проверили', detail: why, text: `TCP не проверили: ${why}` };
  }
  const { report } = result,
    word = lowerFirst(TCP_VERDICT_LABELS[report.verdict]),
    detail = tcpReachSummary(report);
  return {
    ...base,
    tone: report.verdict === 'reachable' ? 'ok' : report.verdict === 'unknown' ? 'warn' : 'crit',
    word,
    detail,
    text: `TCP ${word}${detail ? `: ${detail}` : ''}`,
  };
}
/** Значок итога проверки порта в строке шага: доступен, частично, недоступен, нет данных. */
const TCP_MARK: Record<TcpCheckReport['verdict'], string> = {
  reachable: '✅',
  russia_partial: '🟠',
  russia_unreachable: '🔴',
  port_unreachable: '🔴',
  unknown: '⚪',
};
/** Что не вышло — подпись строки ❌ для каждого шага. */
const FAILED_LABEL: Partial<Record<NonNullable<ScenarioRunStep['action']>, string>> = {
  record_event: 'Запись в событие не вышла',
  hide_host: 'Host не скрыт',
  rename_host: 'Имя Host не изменено',
};
/**
 * Строка шага в сообщении Telegram (витрина telegram-2026-10, сценарий A): значок итога — ✅ сделано, 🟠 замечание,
 * ❌ не вышло — и коротко что именно. Пропущенные шаги и само уведомление в сообщение не попадают.
 */
export function telegramStepLine(step: ScenarioRunStep, report: TcpCheckReport | null): string | null {
  if (step.skipped || step.action === 'notify') return null;
  if (step.failed)
    return `❌ ${(step.action && FAILED_LABEL[step.action]) || 'Шаг не вышел'}: ${step.detail ?? step.text}`;
  if (step.action === 'check_tcp')
    return report ? `${TCP_MARK[report.verdict]} TCP: ${step.word}` : `🟠 ${step.text}`;
  if (step.tone === 'change')
    return step.action === 'rename_host' ? `✅ Имя Host: ${step.detail}` : `✅ ${step.text}`;
  if (step.action === 'record_event' && step.incidentId) return `✅ ${step.text}`;
  return `🟠 ${step.text}`;
}
@Injectable()
export class ScenariosJob {
  private busy = false;
  private log = new Logger(ScenariosJob.name);
  /** Завершения срабатываний, ждущие проверку порта: журнал и сообщение дописываются, не задерживая другие ноды. */
  private inflight = new Set<Promise<unknown>>();
  /** Ноды, у которых сейчас идёт фоновая проверка порта для условия «TCP недоступен». */
  private probing = new Set<string>();
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
  /** Дождаться фоновых проверок и завершений срабатываний (тесты, остановка). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
  private track(work: Promise<unknown>) {
    const p = work
      .catch((e) => this.log.warn(e instanceof Error ? e.message : 'Сценарий не завершён'))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }
  /** Проверка порта для условия — в фоне: результат подхватит следующий снимок, остальные сценарии не ждут. */
  private probeLater(panel: string, node: RemnawaveNode, cfg: MonitoringSettings) {
    if (this.probing.has(node.uuid)) return;
    this.probing.add(node.uuid);
    this.track(this.tcpReport(panel, node, cfg, true).finally(() => this.probing.delete(node.uuid)));
  }
  // Сценарии смотрят свежий снимок раз в 5 секунд: без нового снимка проход почти ничего не стоит.
  @Interval(5000) async tick() {
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
      summary: `${report.target}: ${report.verdict === 'reachable' ? 'доступен' : report.verdict === 'unknown' ? 'недостаточно данных' : report.verdict === 'russia_unreachable' ? 'недоступен из РФ' : report.verdict === 'russia_partial' ? `частично недоступен из РФ${report.confirmed ? ', подтверждено повтором' : ''}` : 'порты недоступны'}`,
      link: report.link,
    });
    return report;
  }
  /** Сохранённая проверка порта ноды: свежая или устаревшая; для другого адреса или порта её нет. */
  private async tcpKnown(
    panel: string,
    node: RemnawaveNode,
    cfg: MonitoringSettings,
  ): Promise<{ report: TcpCheckReport; fresh: boolean } | null> {
    const cached = await this.store.read<{ target: string; report: unknown }>(
      `scenarios.tcp.${this.store.scope(panel)}.${node.uuid}`,
    );
    const parsed = tcpCheckReportSchema.safeParse(cached?.report);
    if (!parsed.success || cached?.target !== `${node.address}:${cfg.checkHostPort}:${node.port ?? ''}`)
      return null;
    const age = Date.now() - Date.parse(parsed.data.checkedAt),
      ttl = parsed.data.verdict === 'unknown' ? 60000 : cfg.checkHostCooldownMinutes * 60000;
    return { report: parsed.data, fresh: age >= 0 && age < ttl };
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
      const known = cfg.checkHostEnabled ? await this.tcpKnown(panel, node, cfg) : null;
      // Устаревшая проверка того же адреса действует, пока новая идёт в фоне: условие не «мигает» раз в 5 минут
      // и отсчёт «держится» не сбрасывается.
      if (cfg.checkHostEnabled && probe && !known?.fresh) this.probeLater(panel, node, cfg);
      const verdict = known?.report.verdict;
      // Частичная недоступность из РФ — блокировка, только если подтверждена повтором и онлайн упал: сбойная точка
      // Check-Host в РФ сама по себе сценарий не запускает.
      signals.tcp_unreachable =
        verdict === 'russia_unreachable' ||
        verdict === 'port_unreachable' ||
        (!!known && tcpBlockedInRussia(known.report) && signals.online_drop);
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
      // Связь Host с нодой определяет DNS: держим его ответы «тёплыми», чтобы сбой в момент падения ноды не застал
      // сценарий с пустой памятью (например, сразу после перезапуска панели) — у него останется прежний удачный ответ.
      if (rules.some((r) => r.enabled && r.actions.some((a) => a === 'hide_host' || a === 'rename_host')))
        this.warmLinks();
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
          // Здоровые опросы считаем сразу, а не после закрытия «нода не на связи» (раньше подтверждение шло
          // дважды). Пока открыто падение онлайна или недоступен порт — Host не возвращаем: нода ещё не в порядке.
          state.healthySamples =
            !condition && node.isConnected && !issue(node.uuid, ['node_blocked', 'server_down'])
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
              steps: ScenarioRunStep[] = [];
            let failed = false,
              incident: { id: string; title: string } | null = null;
            // Номер шага — как в сценарии на момент срабатывания: журнал показывает те же номера, что и список.
            const n = (a: Scenario['actions'][number]) => rule.actions.indexOf(a) + 1;
            // «Скрыть Host» и «Изменить имя Host» — одно изменение Host, на месте первого из них.
            const hostActions = rule.actions.filter(
              (a): a is 'hide_host' | 'rename_host' => a === 'hide_host' || a === 'rename_host',
            );
            const firedAt = Date.now();
            // Проверка порта идёт параллельно и не задерживает смену Host; её итог встанет в журнал под своим номером.
            const tcpCheck = rule.actions.includes('check_tcp')
              ? this.tcpReport(panel, node, cfg, true, 60000).then(
                  (report) => ({ report }),
                  (e: unknown) => ({ error: e instanceof Error ? e.message : 'проверка не выполнена' }),
                )
              : null;
            for (const action of rule.actions.filter(
              (a) => a !== 'notify' && a !== 'check_tcp' && a !== hostActions[1],
            ))
              try {
                const current = await this.remna.status();
                if (current.domain !== panel || current.error) throw new Error('Подключение изменилось');
                if (action === 'record_event') {
                  // Событие заводит мониторинг; сценарий дописывает в него, что сделал. Нет события — только «Метрики».
                  incident = (await this.incidents?.forNode(node.uuid)) ?? null;
                  steps.push(
                    incident
                      ? {
                          action,
                          n: n(action),
                          tone: 'info',
                          word: 'записано',
                          detail: `в «${incidentName(incident.title)}»`,
                          incidentId: incident.id,
                          text: `Записано в событие «${incidentName(incident.title)}»`,
                        }
                      : {
                          action,
                          n: n(action),
                          tone: 'info',
                          word: 'события нет',
                          detail: 'запись только в «Метриках»',
                          text: 'Открытого события у ноды нет — запись только в «Метриках»',
                        },
                  );
                }
                if (action === 'hide_host' || action === 'rename_host') {
                  const change = await this.hideHosts(panel, scope, rule, node);
                  for (const a of hostActions) steps.push(hostStep(a, n(a), change));
                  state.pendingRestore = true;
                }
              } catch (e) {
                failed = true;
                const message = e instanceof Error ? e.message : 'Действие не выполнено';
                steps.push({
                  action,
                  n: n(action),
                  tone: 'crit',
                  failed: true,
                  word: 'не вышло',
                  detail: message,
                  text: message,
                });
                // Шаги после него не выполнялись — журнал так и скажет.
                for (const rest of rule.actions)
                  if (
                    rest !== 'notify' &&
                    rest !== 'check_tcp' &&
                    n(rest) > n(action) &&
                    !steps.some((x) => x.action === rest)
                  )
                    steps.push({
                      action: rest,
                      n: n(rest),
                      tone: 'info',
                      skipped: true,
                      word: 'не выполнялся',
                      detail: `шаг ${n(action)} не вышел`,
                      text: '',
                    });
                break;
              }
            const finish = async () => {
              const tcpResult = tcpCheck ? await tcpCheck : null;
              const tcpReport = tcpResult && 'report' in tcpResult ? tcpResult.report : null;
              if (tcpResult) steps.push(tcpStep(n('check_tcp'), tcpResult));
              // Уведомление уходит и после ошибки шага — журнал скажет, ушло ли оно на самом деле.
              if (rule.actions.includes('notify'))
                steps.push(notifyStep(n('notify'), await this.notify.telegramOutlook('scenario')));
              steps.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
              const summary = steps
                .filter((x) => !x.skipped && x.action !== 'notify')
                .map((x) => x.text)
                .join('; ');
              await this.event(panel, rule, node, summary, runId);
              await this.store.addRun(panel, {
                id: runId,
                ruleId: rule.id,
                ruleName: rule.name,
                t: firedAt,
                nodeUuid: node.uuid,
                nodeName: node.name,
                kind: 'run',
                title: `Сработал: ${conditionPhrase(rule)}, ${rule.holdMinutes} мин`,
                condition: conditionPhrase(rule),
                holdMinutes: rule.holdMinutes,
                steps,
                failed,
              });
              if (incident)
                await this.incidents?.note(
                  incident.id,
                  `Сценарий «${rule.name}»: ${lowerFirst(summary)}`,
                  failed ? 'failed' : 'applied',
                );
              if (rule.actions.includes('notify')) {
                // Строка на шаг со значком итога, под ними — таблица портов (витрина telegram-2026-10, сценарий A);
                // нода — под заголовком. Сценарий только с уведомлением: шагов нет — только условие.
                const lines = steps
                  .map((x) => telegramStepLine(x, tcpReport))
                  .filter((x): x is string => x !== null);
                await this.notify.push({
                  severity: 'warn',
                  title: `Сценарий: ${rule.name}`,
                  body: [
                    `Условие: ${scenarioConditionLabel(rule)}`,
                    ...(lines.length ? ['', ...lines] : []),
                  ].join('\n'),
                  link: { to: '/scenarios', label: 'Открыть сценарии' },
                  telegram: {
                    event: 'scenario',
                    serverKey: `node:${node.uuid}`,
                    server: { name: node.name, host: node.address },
                    ports: tcpReport,
                  },
                });
              }
            };
            // Ждём проверку порта — дописываем в фоне: следующие ноды не стоят в очереди за Check-Host.
            if (tcpCheck) this.track(finish());
            else await finish();
          }
          // Возврат Host — когда нода здорова нужное число опросов подряд; не вышло (нет ответа) — на следующем опросе.
          // Состояния до 0.93.0 без отметки проверяются один раз.
          if (
            !condition &&
            state.pendingRestore !== false &&
            state.lastRun > 0 &&
            (state.healthySamples ?? 0) >= cfg.recoverySamples &&
            node.isConnected &&
            !issue(node.uuid, ['node_blocked', 'server_down'])
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
  /**
   * Связи Host с нодами по карте Remnawave (читается принудительно) и Host, чей адрес не разрешился: DNS не ответил,
   * поэтому «чей это Host» неизвестно — это не то же самое, что «у ноды нет своих Host».
   */
  private async hostLinks() {
    if (!this.topology) return { links: new Map<string, string[]>(), unresolved: new Set<string>() };
    const topology = await this.topology.get(true);
    return {
      links: new Map(topology.hosts.map((h) => [h.id, h.nodeUuids])),
      unresolved: new Set(topology.hosts.filter((h) => h.addressResolved === false).map((h) => h.id)),
    };
  }
  private warmedAt = 0;
  /** Раз в несколько минут читает карту Remnawave в фоне — только чтобы ответы DNS были в памяти; сбой не важен. */
  private warmLinks() {
    if (Date.now() - this.warmedAt < 5 * 60_000) return;
    this.warmedAt = Date.now();
    void this.topology?.get().catch(() => undefined);
  }
  /** Паузы перед повторным чтением связей при сбое DNS: короткий сбой проходит, дольше шагу ждать не стоит. */
  private readonly relinkDelaysMs = process.env.NODE_ENV === 'test' ? [0, 0] : [1500, 3500];
  private async pause(ms: number) {
    if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  /** Host без связи, у которых причина — DNS (адрес не разрешился), а не то, что они ничьи. */
  private undetermined(
    hosts: Record<string, unknown>[],
    view: { links: Map<string, string[]>; unresolved: Set<string> },
  ) {
    return hosts.filter(
      (h) =>
        typeof h.uuid === 'string' &&
        view.unresolved.has(h.uuid) &&
        !(view.links.get(h.uuid)?.length ?? 0) &&
        hostNodes(h).length === 0,
    );
  }
  /**
   * Host и их связи. Если у ноды не нашлось ни одного Host, а у каких-то DNS не ответил, читает ещё раз (короткий сбой
   * проходит), прежде чем делать вывод о том, чьи Host. Когда у ноды Host уже определились, не ждёт: Host с молчащим DNS
   * (например, давно мёртвый домен) тогда просто попадают в итог как «не проверены».
   */
  private async readHosts(panel: string, apiKey: string, node: RemnawaveNode, rule: Scenario) {
    const read = async () => {
      const [hosts, view] = await Promise.all([this.hosts(panel, apiKey), this.hostLinks()]);
      return {
        hosts,
        view,
        unknown: this.undetermined(hosts, view),
        owned: hosts.some((h) => this.linkedNodes(h, view.links, rule).includes(node.uuid)),
      };
    };
    let result = await read();
    for (const delay of this.relinkDelaysMs) {
      if (result.owned || result.unknown.length === 0) break;
      await this.pause(delay);
      result = await read();
    }
    return result;
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
    const [hosts, view, rules] = await Promise.all([
      this.hosts(c.domain, c.apiKey),
      this.hostLinks(),
      this.store.list(c.domain),
    ]);
    const links = view.links;
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
                    : view.unresolved.has(String(h.uuid))
                      ? 'DNS не ответил — связь с нодой пока неизвестна'
                      : 'Требуется ручная привязка',
              nodeNames: nodes.map((id) => status.nodes.find((n) => n.uuid === id)?.name ?? id),
              disabled: h.isDisabled === true,
              eligible: nodes.length === 1 && !h.isDisabled,
              reason:
                nodes.length !== 1
                  ? nodes.length
                    ? 'Общий Host: изменение пропускается'
                    : view.unresolved.has(String(h.uuid))
                      ? 'DNS не ответил: связь определится при следующем чтении'
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
  /** Изменить Host ноды по сценарию; итог одной строкой (для события ноды и Telegram). */
  async hide(panel: string, scope: string, rule: Scenario, node: RemnawaveNode) {
    return (await this.hideHosts(panel, scope, rule, node)).text;
  }
  /** Скрыть и (или) переименовать Host ноды; что вышло — по Host, для журнала срабатываний. */
  async hideHosts(panel: string, scope: string, rule: Scenario, node: RemnawaveNode): Promise<HostChange> {
    const c = await this.credentials.credentials();
    if (!c || c.domain !== panel) throw new Error('Подключение изменилось');
    // Сбой DNS в момент падения ноды не должен оставить сценарий без Host: связи перечитываются, а если Host так и
    // остались неопределёнными, шаг говорит об этом, а не «у ноды нет своих Host».
    const { hosts, view, unknown } = await this.readHosts(panel, c.apiKey, node, rule);
    let changed = 0,
      shared = 0,
      own = 0,
      held = 0;
    const names: string[] = [],
      hidden: string[] = [],
      renamed: HostChange['renamed'] = [];
    for (const host of hosts) {
      const nodes = this.linkedNodes(host, view.links, rule);
      if (!nodes.includes(node.uuid)) continue;
      if (nodes.length !== 1) {
        shared++;
        continue;
      }
      if (typeof host.uuid !== 'string') continue;
      own++;
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
      if (old && !old.restored && (old.confirmed || !untouched(host, old.original))) {
        held++;
        continue;
      }
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
      let freshLinks = await this.hostLinks();
      // Привязку подтверждаем тем же DNS: короткий сбой на этом чтении не должен отменять изменение.
      for (const delay of this.relinkDelaysMs) {
        if (!freshLinks.unresolved.has(host.uuid) || (freshLinks.links.get(host.uuid)?.length ?? 0) > 0)
          break;
        await this.pause(delay);
        freshLinks = await this.hostLinks();
      }
      const fresh = (await this.hosts(panel, c.apiKey)).find((h) => h.uuid === host.uuid);
      if (!fresh || hostFingerprint(fresh) !== hostFingerprint(host))
        throw new Error('Host изменён другим администратором; действие пропущено');
      const currentNodes = this.linkedNodes(fresh, freshLinks.links, rule);
      if (currentNodes.length === 0 && freshLinks.unresolved.has(host.uuid))
        throw new Error(
          `Не удалось подтвердить привязку Host «${previousName(host)}»: DNS не ответил — действие отменено`,
        );
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
      if (patch.isDisabled) hidden.push(previousName(host));
      if (patch.remark) renamed.push({ from: original.remark ?? '', to: patch.remark.trim() });
    }
    if (own === 0 && shared === 0 && held === 0) {
      // В журнал сервера — цифры, по которым видно, почему Host не нашлись (на экране панели их не всегда достаточно).
      this.log.warn(
        `Сценарий «${rule.name}»: у ноды «${node.name}» (${node.address}) Host не найдены — всего Host ${hosts.length}, DNS не ответил для ${unknown.length}`,
      );
      if (unknown.length > 0) {
        // Ничего не определили, а Host с молчащим DNS есть: «нет своих Host» было бы неправдой. Host не тронуты.
        const named = unknown.slice(0, 3).map((h) => `«${previousName(h)}»`);
        throw new Error(
          `Не удалось определить, какие Host у ноды: DNS не ответил для ${unknown.length} из ${hosts.length} Host (${someNames(named)}). Host не тронуты — проверьте DNS на сервере панели`,
        );
      }
    }
    const what = rule.actions.includes('rename_host')
      ? rule.actions.includes('hide_host')
        ? 'Изменено и скрыто'
        : 'Изменено имя'
      : 'Скрыто';
    // До трёх Host — по именам, больше — числом: строка уходит и в событие, и в Telegram.
    const text = `${what} Host: ${changed > 0 && changed <= 3 ? names.join(', ') : changed}${shared ? `; общих Host пропущено: ${shared}` : ''}`;
    return { text, hidden, renamed, shared, own, held, scanned: hosts.length, unresolved: unknown.length };
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
    /** Итог возврата: фраза — в событие ноды, слово-итог и подробности — в журнал срабатываний. */
    const report = async (
      text: string,
      result: 'helped' | 'failed',
      step: { word: string; detail: string; tone?: ScenarioRunStep['tone'] },
    ) => {
      await this.event(panel, rule, node, text);
      await this.store.addRun(panel, {
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        t: Date.now(),
        nodeUuid: node.uuid,
        nodeName: node.name,
        kind: 'restore',
        title: result === 'helped' ? 'Host вернули после восстановления ноды' : 'Host не вернули',
        steps: [
          {
            text,
            tone: step.tone ?? (result === 'helped' ? 'ok' : 'crit'),
            word: step.word,
            detail: step.detail,
          },
        ],
        failed: result === 'failed',
      });
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
          {
            word: 'не возвращали',
            detail: `«${name}»: возврат выключен в сценарии — верните его в Remnawave сами`,
            tone: 'warn',
          },
        );
        continue;
      }
      if (untouched(host, ledger.original)) {
        // Host уже такой, каким был до сценария (вернули вручную) — возвращать нечего.
        await release();
        await report(`Host «${name}» уже в исходном виде — его вернули вручную`, 'helped', {
          word: 'уже на месте',
          detail: `«${name}» вернули вручную`,
        });
        continue;
      }
      if (!stillOurs(host, ledger)) {
        await release();
        await report(
          `Host «${name}» не возвращён: после сценария его изменили вручную. Проверьте его в Remnawave.`,
          'failed',
          {
            word: 'не вернули',
            detail: `«${name}»: после сценария его изменили вручную. Проверьте его в Remnawave.`,
          },
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
          { word: 'не вернули', detail: `«${name}»: его изменили вручную. Проверьте его в Remnawave.` },
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
          { word: 'не вернули', detail: `«${name}»: ${lowerFirst(e.message)} Верните его в Remnawave сами.` },
        );
        continue;
      }
      const after = (await this.hosts(panel, c.apiKey)).find((h) => h.uuid === host.uuid);
      await release();
      if (!after || Object.entries(back).some(([k, value]) => !sameHostValue(k, after[k], value))) {
        await report(`Возврат Host «${name}» не подтверждён — проверьте его в Remnawave.`, 'failed', {
          word: 'не подтверждён',
          detail: `«${name}» — проверьте его в Remnawave`,
        });
        continue;
      }
      await report(`Host «${previousName(after)}» возвращён после восстановления ноды`, 'helped', {
        word: 'вернули',
        detail: `«${previousName(after)}»`,
      });
    }
    return retry ? 'retry' : 'done';
  }
}

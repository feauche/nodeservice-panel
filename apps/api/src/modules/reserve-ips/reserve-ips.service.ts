import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  type NodeReserve,
  nodeReserveSchema,
  RESERVE_IPS_MAX,
  type RemnawaveNode,
  type ReserveIpCheck,
  type ReserveSwitchPlan,
  type ReserveSwitchStep,
  reserveSwitchByLabels,
  tcpReachSummary,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { CheckHostService, publicIp, type TcpReport } from '../incidents/check-host.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { DnsService } from '../integrations/dns.service.js';
import { NodeEventsStore } from '../node-events/node-events.store.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { HOSTS_UPDATE_SCOPE, RemnaPermissionsService } from '../remnawave/remna-permissions.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { getJson, RemnawaveApiError } from '../remnawave/remnawave-client.js';
import { RemnawaveSettingsStore } from '../remnawave/remnawave-settings.store.js';
import { MonitoringStore } from '../settings/monitoring.store.js';

const EMPTY: NodeReserve = { items: [], auto: false, lastSwitch: null };
/** «Само» и сценарий переключают не чаще — чтобы не сжечь все адреса подряд. */
const AUTO_EVERY_MS = 86_400_000;
/** Проверка порта монитором свежая столько: старше — «само» её не берёт. */
const PROBE_FRESH_MS = 30 * 60_000;
type By = 'manual' | 'auto' | 'scenario';
/** IPv6 — в одном написании, чтобы «2001:db8::1» и «2001:DB8:0::1» были одним адресом. */
export function normalizeIp(value: string): string {
  const v = value.trim();
  if (isIP(v) !== 6) return v;
  try {
    return new URL(`http://[${v}]`).hostname.slice(1, -1);
  } catch {
    return v;
  }
}
/** Итог Check-Host по запасному адресу словами; на адрес можно переключать, только если он отвечает отовсюду. */
export function reserveCheck(report: TcpReport): ReserveIpCheck {
  const summary = tcpReachSummary(report);
  const tail = summary ? ` · ${summary}` : '';
  const text =
    report.verdict === 'reachable'
      ? `Отвечает${tail}`
      : report.verdict === 'russia_unreachable'
        ? `Не отвечает из России — адрес, похоже, тоже заблокирован${tail}`
        : report.verdict === 'russia_partial'
          ? `Отвечает не из всех точек России${tail}`
          : report.verdict === 'port_unreachable'
            ? 'Не отвечает ниоткуда — порт закрыт или адрес не на этом сервере'
            : `Check-Host не дал ответа${report.error ? `: ${report.error}` : ''} — повторите проверку`;
  return { at: report.checkedAt, ok: report.verdict === 'reachable', verdict: report.verdict, text };
}
type Host = { uuid: string; remark: string; address: string };
type Dns = { id: string; name: string; type: string; content: string; provider: string };
const PROVIDER = { cloudflare: 'Cloudflare', regru: 'REG.RU' } as Record<string, string>;

/**
 * Запасные IP ноды (0.111.0, витрина reference-pack-2026-10, раздел 4 — A). Хранятся по ноде текущего подключения
 * Remnawave. Проверка — Check-Host на запасном адресе: живая нода никуда не переводится. Переключение — адрес ноды в
 * Remnawave, затем Host с этим IP и записи DNS со старым IP; не вышел первый шаг — остальное не трогается.
 */
@Injectable()
export class ReserveIpsService {
  private readonly log = new Logger(ReserveIpsService.name);
  /** Ноды, которые сейчас переключаются: второе переключение той же ноды ждать не будет — откажет. */
  private switching = new Set<string>();
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly remna: RemnawaveService,
    private readonly credentials: RemnawaveSettingsStore,
    private readonly permissions: RemnaPermissionsService,
    private readonly checkHost: CheckHostService,
    private readonly monitoring: MonitoringStore,
    private readonly dns: DnsService,
    private readonly events: NodeEventsStore,
    @Optional() private readonly incidents?: IncidentsService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}
  private key(domain: string, uuid: string) {
    return `node.reserve.${domain}:${uuid}`;
  }
  private async node(uuid: string): Promise<{ domain: string; node: RemnawaveNode }> {
    const status = await this.remna.status();
    const node = status.nodes.find((n) => n.uuid === uuid);
    if (!status.connected || !status.domain || !node) throw new NotFoundException('Нода не найдена.');
    return { domain: status.domain, node };
  }
  private async read(domain: string, uuid: string): Promise<NodeReserve> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, this.key(domain, uuid)) });
    if (!row) return { ...EMPTY };
    const parsed = nodeReserveSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : { ...EMPTY };
  }
  private async write(domain: string, uuid: string, value: NodeReserve) {
    const parsed = nodeReserveSchema.parse(value);
    await this.db
      .insert(appMeta)
      .values({ key: this.key(domain, uuid), value: JSON.stringify(parsed) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(parsed), updatedAt: new Date() },
      });
    return parsed;
  }
  async get(uuid: string): Promise<NodeReserve> {
    const { domain } = await this.node(uuid);
    return this.read(domain, uuid);
  }
  /** Check-Host на запасном адресе: те же порты, что у проверки ноды («Мониторинг нод» и порт ноды). */
  async probe(node: RemnawaveNode, ip: string): Promise<ReserveIpCheck> {
    try {
      const cfg = await this.monitoring.get();
      return reserveCheck(
        await this.checkHost.checkNode(ip, cfg.checkHostPort, node.port, { confirm: false }),
      );
    } catch (e) {
      return {
        at: new Date().toISOString(),
        ok: false,
        verdict: 'unknown',
        text: `Check-Host не ответил${e instanceof Error ? `: ${e.message}` : ''} — повторите проверку`,
      };
    }
  }
  async add(uuid: string, raw: string): Promise<NodeReserve> {
    const { domain, node } = await this.node(uuid);
    const ip = normalizeIp(raw);
    if (!isIP(ip)) throw new BadRequestException('Введите IP-адрес, например 203.0.113.10.');
    if (!publicIp(ip))
      throw new BadRequestException('Это внутренний адрес: Check-Host до него не достучится, клиенты тоже.');
    if (ip === normalizeIp(node.address)) throw new BadRequestException('Это рабочий адрес ноды.');
    const current = await this.read(domain, uuid);
    if (current.items.some((i) => i.ip === ip)) throw new BadRequestException('Этот адрес уже в списке.');
    if (current.items.length >= RESERVE_IPS_MAX)
      throw new BadRequestException(`Запасных адресов — не больше ${RESERVE_IPS_MAX}.`);
    const check = await this.probe(node, ip);
    // Пока шла проверка, список могли поменять — дописываем к свежему.
    const fresh = await this.read(domain, uuid);
    if (fresh.items.some((i) => i.ip === ip)) return fresh;
    return this.write(domain, uuid, {
      ...fresh,
      items: [...fresh.items, { ip, check, wasPrimaryUntil: null }],
    });
  }
  async recheck(uuid: string, raw: string): Promise<NodeReserve> {
    const { domain, node } = await this.node(uuid);
    const ip = normalizeIp(raw);
    if (!(await this.read(domain, uuid)).items.some((i) => i.ip === ip))
      throw new NotFoundException('Такого запасного адреса нет.');
    const check = await this.probe(node, ip);
    const fresh = await this.read(domain, uuid);
    return this.write(domain, uuid, {
      ...fresh,
      items: fresh.items.map((i) => (i.ip === ip ? { ...i, check } : i)),
    });
  }
  async remove(uuid: string, raw: string): Promise<NodeReserve> {
    const { domain } = await this.node(uuid);
    const ip = normalizeIp(raw);
    const current = await this.read(domain, uuid);
    return this.write(domain, uuid, { ...current, items: current.items.filter((i) => i.ip !== ip) });
  }
  /** Порядок — при переключении «само» и сценарием берётся первый рабочий. */
  async order(uuid: string, ips: string[]): Promise<NodeReserve> {
    const { domain } = await this.node(uuid);
    const current = await this.read(domain, uuid);
    const wanted = ips.map(normalizeIp);
    const same =
      wanted.length === current.items.length &&
      new Set(wanted).size === wanted.length &&
      wanted.every((ip) => current.items.some((i) => i.ip === ip));
    if (!same) throw new BadRequestException('Список адресов изменился. Обновите окно ноды.');
    const byIp = new Map(current.items.map((i) => [i.ip, i]));
    return this.write(domain, uuid, {
      ...current,
      items: wanted.map((ip) => byIp.get(ip)).filter((i): i is NodeReserve['items'][number] => !!i),
    });
  }
  async setAuto(uuid: string, auto: boolean): Promise<NodeReserve> {
    const { domain } = await this.node(uuid);
    return this.write(domain, uuid, { ...(await this.read(domain, uuid)), auto });
  }
  private async hosts(): Promise<Host[]> {
    const c = await this.credentials.credentials();
    if (!c) throw new BadRequestException('Подключите Remnawave.');
    const r = await getJson(`https://${c.domain}/api/hosts`, c.apiKey);
    const v = r.response;
    const list = Array.isArray(v)
      ? v
      : Array.isArray((v as { hosts?: unknown })?.hosts)
        ? (v as { hosts: unknown[] }).hosts
        : [];
    return list
      .map((h) => h as Record<string, unknown>)
      .filter((h) => typeof h.uuid === 'string' && typeof h.address === 'string')
      .map((h) => ({ uuid: String(h.uuid), remark: String(h.remark ?? h.uuid), address: String(h.address) }));
  }
  /** Записи DNS со старым IP — из подключённых DNS-интеграций; не ответили — пусто и почему. */
  private async dnsRecords(from: string): Promise<{ records: Dns[]; note: string | null }> {
    try {
      const data = await this.dns.overview(true);
      const records = data.records
        .filter((r) => ['A', 'AAAA'].includes(r.type) && normalizeIp(r.content) === from)
        .map((r) => ({ id: r.id, name: r.name, type: r.type, content: r.content, provider: r.provider }));
      const note = data.errors.length
        ? `Не все DNS-интеграции ответили (${data.errors.join('; ')}) — проверьте записи со старым IP вручную.`
        : null;
      return { records, note };
    } catch (e) {
      return {
        records: [],
        note: `DNS-интеграции не ответили${e instanceof Error ? `: ${e.message}` : ''} — записи со старым IP поменяйте вручную.`,
      };
    }
  }
  /** Что поменяется при переключении на `to`: шаги без итога; нельзя — `blocked` словами. */
  async plan(
    uuid: string,
    rawTo: string,
    { dns: withDns = true }: { dns?: boolean } = {},
  ): Promise<ReserveSwitchPlan & { hosts: Host[]; records: Dns[] }> {
    const { domain, node } = await this.node(uuid);
    const to = normalizeIp(rawTo),
      from = normalizeIp(node.address);
    const base = {
      from,
      to,
      steps: [] as ReserveSwitchStep[],
      hosts: [] as Host[],
      records: [] as Dns[],
      dnsNote: null,
    };
    if (!isIP(from))
      return {
        ...base,
        blocked: `Адрес ноды в Remnawave — домен «${node.address}», а не IP. Переключение меняет IP-адреса: поменяйте запись этого домена в DNS.`,
      };
    if (!(await this.read(domain, uuid)).items.some((i) => i.ip === to))
      return { ...base, blocked: 'Этого адреса нет в списке запасных.' };
    const [hosts, dns] = await Promise.all([
      this.hosts().then((list) => list.filter((h) => normalizeIp(h.address) === from)),
      withDns
        ? this.dnsRecords(from)
        : Promise.resolve({ records: [] as Dns[], note: 'DNS не трогается — так задано в сценарии.' }),
    ]);
    const steps: ReserveSwitchStep[] = [
      { kind: 'node', title: 'Адрес ноды в Remnawave', detail: `${from} → ${to}`, ok: null, error: null },
      ...hosts.map((h) => ({
        kind: 'host' as const,
        title: `Host «${h.remark}»`,
        detail: `${from} → ${to}`,
        ok: null,
        error: null,
      })),
      ...dns.records.map((r) => ({
        kind: 'dns' as const,
        title: `${r.name} · ${PROVIDER[r.provider] ?? r.provider}`,
        detail: `${r.type} ${from} → ${to}`,
        ok: null,
        error: null,
      })),
    ];
    return { from, to, steps, hosts, records: dns.records, blocked: null, dnsNote: dns.note };
  }
  /**
   * Переключение на запасной адрес. По шагам, каждый со своим итогом; не вышел адрес ноды в Remnawave — Host и DNS не
   * трогаются. Старый адрес уходит в список запасных с пометкой «Был рабочим до …».
   */
  async switchTo(
    uuid: string,
    rawTo: string,
    by: By,
    opts: { dns?: boolean } = {},
  ): Promise<{ plan: ReserveSwitchPlan; reserve: NodeReserve; nodeName: string }> {
    if (this.switching.has(uuid)) throw new BadRequestException('Нода уже переключается. Дождитесь итога.');
    this.switching.add(uuid);
    try {
      return await this.switchLocked(uuid, rawTo, by, opts);
    } finally {
      this.switching.delete(uuid);
    }
  }
  private async switchLocked(uuid: string, rawTo: string, by: By, opts: { dns?: boolean }) {
    const { domain, node } = await this.node(uuid);
    const full = await this.plan(uuid, rawTo, opts);
    if (full.blocked) throw new BadRequestException(full.blocked);
    const { hosts, records, ...plan } = full;
    const steps = plan.steps.map((s) => ({ ...s }));
    const mark = (i: number, ok: boolean, error: string | null = null) => {
      const step = steps[i];
      if (step) Object.assign(step, { ok, error });
    };
    const c = await this.credentials.credentials();
    if (!c || c.domain !== domain)
      throw new BadRequestException('Подключение Remnawave изменилось. Обновите окно.');
    // 1. Адрес ноды в Remnawave.
    try {
      await this.permissions.observe('nodes:update', c, () =>
        getJson(`https://${c.domain}/api/nodes`, c.apiKey, {
          method: 'PATCH',
          body: JSON.stringify({ uuid, address: plan.to }),
        }),
      );
      mark(0, true);
    } catch (e) {
      mark(
        0,
        false,
        e instanceof RemnawaveApiError && e.status === 403
          ? 'У ключа Remnawave нет права «Изменение нод» (nodes:update) — адрес не изменён.'
          : `Remnawave не изменила адрес${e instanceof Error ? `: ${e.message}` : ''}.`,
      );
      for (let i = 1; i < steps.length; i++)
        mark(i, false, 'Не выполнялось: адрес ноды в Remnawave не изменён.');
      await this.record(node, domain, plan.from, plan.to, by, steps, false);
      return { plan: { ...plan, steps }, reserve: await this.read(domain, uuid), nodeName: node.name };
    }
    await this.remna.syncQuiet().catch(() => undefined);
    // 2. Host с этим IP.
    let i = 1;
    for (const h of hosts) {
      try {
        await this.permissions.observe(HOSTS_UPDATE_SCOPE, c, () =>
          getJson(`https://${c.domain}/api/hosts`, c.apiKey, {
            method: 'PATCH',
            body: JSON.stringify({ uuid: h.uuid, address: plan.to }),
          }),
        );
        mark(i, true);
      } catch (e) {
        mark(
          i,
          false,
          e instanceof RemnawaveApiError && e.status === 403
            ? 'У ключа Remnawave нет права «Изменение Host» — Host не изменён.'
            : `Remnawave не изменила Host${e instanceof Error ? `: ${e.message}` : ''}.`,
        );
      }
      i++;
    }
    // 3. Записи DNS: адрес берётся у ноды — Remnawave уже должна показывать новый.
    const seen = (await this.remna.status()).nodes.find((n) => n.uuid === uuid);
    for (const r of records) {
      if (normalizeIp(seen?.address ?? '') !== plan.to) {
        mark(i++, false, 'Remnawave ещё не показывает новый адрес ноды — замените запись позже или вручную.');
        continue;
      }
      try {
        await this.dns.apply({ recordId: r.id, nodeUuid: uuid, expected: r.content });
        mark(i, true);
      } catch (e) {
        // Автозамена DNS панели могла успеть раньше: запись уже на новом адресе — это не ошибка.
        const already = await this.dns
          .overview(true)
          .then((d) =>
            d.records.some(
              (x) => x.name === r.name && x.type === r.type && normalizeIp(x.content) === plan.to,
            ),
          )
          .catch(() => false);
        mark(i, already, already ? null : e instanceof Error ? e.message : 'Запись не изменена.');
      }
      i++;
    }
    // Старый адрес — в запасные, новый из них уходит.
    const fresh = await this.read(domain, uuid);
    const now = new Date().toISOString();
    const reserve = await this.write(domain, uuid, {
      ...fresh,
      items: [
        ...fresh.items.filter((x) => x.ip !== plan.to && x.ip !== plan.from),
        { ip: plan.from, check: null, wasPrimaryUntil: now },
      ],
      lastSwitch: { at: now, from: plan.from, to: plan.to, by },
    });
    await this.record(node, domain, plan.from, plan.to, by, steps, true);
    return { plan: { ...plan, steps }, reserve, nodeName: node.name };
  }
  /**
   * Проверить запасные по порядку (Check-Host, свежо) и переключить на первый, который отвечает. Для «само» и шага
   * сценария. Не отвечает ни один — ничего не трогается, причина — в событии ноды.
   */
  async failover(
    uuid: string,
    by: Exclude<By, 'manual'>,
    opts: { dns?: boolean } = {},
  ): Promise<
    | { switched: true; plan: ReserveSwitchPlan; nodeName: string }
    | { switched: false; reason: string; tried: Array<{ ip: string; text: string }> }
  > {
    const { domain, node } = await this.node(uuid);
    const reserve = await this.read(domain, uuid);
    if (!reserve.items.length)
      return {
        switched: false,
        reason: 'у ноды нет запасных IP — добавьте их в окне ноды → «Подключение»',
        tried: [],
      };
    const tried: Array<{ ip: string; text: string }> = [];
    for (const item of reserve.items) {
      const check = await this.probe(node, item.ip);
      const fresh = await this.read(domain, uuid);
      await this.write(domain, uuid, {
        ...fresh,
        items: fresh.items.map((i) => (i.ip === item.ip ? { ...i, check } : i)),
      });
      tried.push({ ip: item.ip, text: check.text });
      if (!check.ok) continue;
      const result = await this.switchTo(uuid, item.ip, by, opts);
      const failed = result.plan.steps.filter((s) => s.ok === false);
      await this.audit
        ?.record({
          action: 'incident.node_reserve.switched',
          actor: SYSTEM_ACTOR,
          source: 'auto',
          ...(result.plan.steps[0]?.ok === false ? { result: 'failed' as const } : {}),
          target: { type: 'node', id: uuid, display: node.name },
          metadata: {
            from: result.plan.from,
            to: result.plan.to,
            by: reserveSwitchByLabels[by],
            changed: result.plan.steps.filter((s) => s.ok).map((s) => s.title),
            ...(failed.length ? { failing: failed.map((s) => `${s.title}: ${s.error}`) } : {}),
          },
        })
        .catch(() => undefined);
      if (result.plan.steps[0]?.ok === false)
        return {
          switched: false,
          reason: result.plan.steps[0].error ?? 'Remnawave не изменила адрес',
          tried,
        };
      return { switched: true, plan: result.plan, nodeName: result.nodeName };
    }
    const reason = `запасные не отвечают: ${tried.map((t) => `${t.ip} — ${t.text}`).join('; ')}`;
    await this.note(node, domain, 'Запасные IP не отвечают — нода не переключена', reason);
    return { switched: false, reason, tried };
  }
  private scope16(domain: string) {
    return createHash('sha256').update(domain).digest('hex').slice(0, 16);
  }
  /**
   * «Переключать само»: последняя проверка порта монитором — из России порт закрыт, из других стран открыт (по
   * рабочему адресу, не старше 30 минут). Не чаще раза в сутки на ноду, и после неудачной попытки — тоже через сутки.
   */
  @Interval(60_000) async autoTick() {
    if (process.env.NODE_ENV === 'test') return;
    await this.runAuto().catch((e) =>
      this.log.warn(e instanceof Error ? e.message : 'Автопереключение не выполнено'),
    );
  }
  async runAuto() {
    const status = await this.remna.status();
    if (!status.connected || !status.domain) return;
    const domain = status.domain;
    for (const node of status.nodes.filter((n) => !n.isDisabled)) {
      const reserve = await this.read(domain, node.uuid);
      if (!reserve.auto || !reserve.items.length || this.switching.has(node.uuid)) continue;
      const recent = (iso: string | null | undefined) =>
        !!iso && Date.now() - Date.parse(iso) < AUTO_EVERY_MS;
      if (recent(reserve.lastSwitch?.at) || recent(reserve.autoTriedAt)) continue;
      const row = await this.db.query.appMeta.findFirst({
        where: eq(appMeta.key, `monitor.tcp.${this.scope16(domain)}.${node.uuid}`),
      });
      const probe = row ? (JSON.parse(row.value) as { report?: TcpReport | null; address?: string }) : null;
      const report = probe?.report;
      if (
        report?.verdict !== 'russia_unreachable' ||
        probe?.address !== node.address ||
        Date.now() - Date.parse(report.checkedAt) > PROBE_FRESH_MS
      )
        continue;
      const fresh = await this.read(domain, node.uuid);
      await this.write(domain, node.uuid, { ...fresh, autoTriedAt: new Date().toISOString() });
      const result = await this.failover(node.uuid, 'auto');
      await this.notifications
        ?.push({
          severity: result.switched ? 'warn' : 'crit',
          title: result.switched
            ? `Нода переключена на запасной IP · ${node.name}`
            : `Запасные IP не отвечают · ${node.name}`,
          body: result.switched
            ? `Из России порт ноды не виден, из других стран виден. ${result.plan.from} → ${result.plan.to}${
                result.plan.steps.some((s) => s.ok === false)
                  ? `; не вышло: ${result.plan.steps
                      .filter((s) => s.ok === false)
                      .map((s) => s.title)
                      .join(', ')}`
                  : ''
              }.`
            : `Из России порт ноды не виден, а переключить не на что: ${result.reason}.`,
          link: { to: '/nodes', label: 'Открыть ноды' },
          telegram: {
            event: 'incident_warn',
            serverKey: `node:${node.uuid}`,
            server: { name: node.name, host: node.address },
          },
        })
        .catch(() => undefined);
    }
  }
  /** Строка в события ноды без переключения (запасные не отвечают). */
  private async note(node: RemnawaveNode, domain: string, title: string, summary: string) {
    try {
      await this.events.append(domain, {
        id: `reserve:${node.uuid}:${Date.now()}`,
        t: Date.now(),
        nodeUuid: node.uuid,
        nodeName: node.name,
        type: 'automation',
        title,
        summary,
        link: null,
      });
      const incident = await this.incidents?.forNode(node.uuid);
      if (incident) await this.incidents?.note(incident.id, `${title}: ${summary}`, 'failed');
    } catch (e) {
      this.log.warn(`След не записан: ${e instanceof Error ? e.message : e}`);
    }
  }
  /** След переключения: событие ноды на шкале «Метрик» и строка в открытом событии ноды. */
  private async record(
    node: RemnawaveNode,
    domain: string,
    from: string,
    to: string,
    by: By,
    steps: ReserveSwitchStep[],
    switched: boolean,
  ) {
    const failed = steps.filter((s) => s.ok === false);
    const dns = steps.filter((s) => s.kind === 'dns' && s.ok).length,
      hosts = steps.filter((s) => s.kind === 'host' && s.ok).length;
    const summary = switched
      ? `${from} → ${to}, ${reserveSwitchByLabels[by]} · DNS: ${dns} · Host: ${hosts}${failed.length ? ` · не вышло: ${failed.map((s) => s.title).join(', ')}` : ''}`
      : `${from} → ${to}, ${reserveSwitchByLabels[by]} · ${failed[0]?.error ?? 'не вышло'}`;
    try {
      await this.events.append(domain, {
        id: `reserve:${node.uuid}:${Date.now()}`,
        t: Date.now(),
        nodeUuid: node.uuid,
        nodeName: node.name,
        type: 'automation',
        title: switched ? 'Нода переключена на запасной IP' : 'Переключение на запасной IP не вышло',
        summary,
        link: null,
      });
      const incident = await this.incidents?.forNode(node.uuid);
      if (incident)
        await this.incidents?.note(
          incident.id,
          switched
            ? `Нода переключена на запасной IP: ${summary}`
            : `Переключение на запасной IP не вышло: ${summary}`,
          switched && !failed.length ? 'applied' : 'failed',
        );
    } catch (e) {
      this.log.warn(`След переключения не записан: ${e instanceof Error ? e.message : e}`);
    }
  }
}

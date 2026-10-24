import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { errorText } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { NodeEventsStore } from '../node-events/node-events.store.js';
import { NodeMaintenanceStore } from '../remnawave/node-maintenance.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { type IntegrationSession, IntegrationsService } from './integrations.service.js';
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function list(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.map(obj);
  const o = obj(v);
  for (const key of ['checks', 'pops', 'items', 'results', 'data'])
    if (Array.isArray(o[key])) return (o[key] as unknown[]).map(obj);
  return [];
}
/** Проверок на странице списка — больше DPI Checker не отдаёт. */
const PAGE = 100;
const createdMs = (c: Record<string, unknown>) => Date.parse(String(c.created_at ?? c.createdAt ?? '')) || 0;
const number = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
export type DpiSchedule = {
  enabled: boolean;
  minutes: number;
  nodes: string[];
  pops: number[];
  nextAt: string | null;
  lastError: string | null;
};
const emptySchedule = (): DpiSchedule => ({
  enabled: false,
  minutes: 60,
  nodes: [],
  pops: [],
  nextAt: null,
  lastError: null,
});
/** Идёт: в очереди (pending) или выполняется (active). */
const RUNNING = new Set(['pending', 'active', 'running']);
/** Почему точка не открыла ноду — по коду DPI Checker. */
const FAIL_REASON: Record<string, string> = {
  tls_handshake_failed: 'Сброс при установке TLS',
  connection_reset: 'Соединение сброшено',
  connection_refused: 'Порт закрыт',
  refused: 'Порт закрыт',
  timeout: 'Нет ответа',
  dns_failed: 'Адрес не нашёлся',
};
/**
 * Ответ одной точки. Reality отвечает сертификатом чужого сайта: сервис ставит accessible=false, хотя TLS
 * проходит, — это доступность, не блокировка. Но только если TLS и правда прошёл: «чисто» (verdict) при открытом
 * порте и 0 удачных TLS из 5 — это не доступность. Прокси самой точки не работал (proxy_dead, контрольный сайт
 * недоступен) — точка не в счёт.
 */
export function dpiPoint(r: Record<string, unknown>) {
  const certOther = r.error_code === 'tls_cert_other_name';
  const open443 = r.port_443_state === 'open';
  const tlsOk = number(r.samples_tls_ok);
  const flag =
    typeof r.accessible === 'boolean'
      ? r.accessible
      : typeof r.connected === 'boolean'
        ? r.connected
        : typeof r.reached === 'boolean'
          ? r.reached
          : null;
  const ok = flag === true || (flag === false && certOther && (tlsOk === null || tlsOk > 0));
  const dead = r.proxy_dead === true || obj(r.control_check).accessible === false || r.untestable === true;
  const state: 'ok' | 'fail' | 'unknown' = ok ? 'ok' : dead || flag === null ? 'unknown' : 'fail';
  const samples = number(r.samples_total);
  const throttled = number(r.samples_throttled) ?? 0;
  const code = String(r.error_code ?? r.status ?? '');
  const reason =
    state === 'ok'
      ? certOther
        ? 'Сертификат другого имени — для Reality это норма'
        : throttled > 0
          ? 'Открывается, но с замедлением'
          : null
      : state === 'unknown'
        ? dead
          ? 'Точка сама без связи — не в счёт'
          : 'Ответа ещё нет'
        : (FAIL_REASON[code] ??
          (r.port_443_state === 'silent' || /curl exit 28/.test(String(r.error ?? ''))
            ? 'Нет ответа'
            : open443 && samples && tlsOk === 0
              ? 'Порт открыт, TLS не проходит'
              : throttled > 0
                ? 'Замедление'
                : 'Не открывается'));
  return {
    location: String(r.pop_name ?? r.region ?? r.city ?? r.location ?? r.pop_id ?? 'Точка'),
    popId: number(r.pop_id),
    accessible: state === 'ok' ? true : state === 'fail' ? false : null,
    state,
    reason,
    // У VLESS задержка 0 — это неудача, а не мгновенный ответ.
    latency: number(r.ping_avg_ms) ?? (number(r.latency_ms) || null) ?? number(r.tcp_latency_ms),
    tls: samples ? `${tlsOk ?? 0} из ${samples}` : null,
    throttled: samples ? `${throttled} из ${samples}` : null,
    port80:
      typeof r.port_80_hijacked === 'boolean' ? (r.port_80_hijacked ? 'перехвачен' : 'не перехвачен') : null,
  };
}
/** «Нет денег», «неверный ключ» и подобное: повторять по расписанию бессмысленно — расписание останавливается. */
const FATAL = new Set([
  'insufficient_balance',
  'invalid_api_key',
  'missing_api_key',
  'account_banned',
  'api_not_unlocked',
  'ip_not_allowed',
]);
const providerCode = (e: unknown) => {
  const r = e instanceof HttpException ? obj(e.getResponse()) : {};
  const ext = obj(r.extensions);
  return typeof ext.providerCode === 'string' ? ext.providerCode : null;
};
@Injectable()
export class DpiService {
  private busy = false;
  private completed = new Map<string, Record<string, unknown>>();
  private cache: { identity: string; at: number; data: Awaited<ReturnType<DpiService['load']>> } | null =
    null;
  private balanceAt = 0;
  /** Где в списке DPI Checker начинается последняя неполная страница — если он идёт от старых к новым. */
  private checksTail = new Map<string, number>();
  private extras: {
    at: number;
    prices: { ipPop: number; ipResource: number; vpnPop: number; vpnResource: number } | null;
    probe: { fixed: number; perGb: number } | null;
    optimal: number;
  } | null = null;
  constructor(
    @Inject(DB) private db: Db,
    private integrations: IntegrationsService,
    private remna: RemnawaveService,
    @Optional() private timeline?: NodeEventsStore,
    @Optional() private maintenance?: NodeMaintenanceStore,
  ) {}
  private async read(key: string) {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    return row ? JSON.parse(row.value) : null;
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
  async schedule(): Promise<DpiSchedule> {
    return (await this.read(`dpi.schedule.${await this.integrations.identity('dpi')}`)) ?? emptySchedule();
  }
  async setSchedule(value: Omit<DpiSchedule, 'nextAt' | 'lastError'>) {
    value.nodes = [...new Set(value.nodes)];
    value.pops = [...new Set(value.pops)];
    const st = await this.remna.status();
    if (
      value.enabled &&
      (!st.connected || !value.nodes.length || value.nodes.some((id) => !st.nodes.some((n) => n.uuid === id)))
    )
      throw new BadRequestException('Выберите доступные ноды.');
    const next = {
      ...value,
      panel: st.domain,
      nextAt: value.enabled ? new Date(Date.now() + value.minutes * 60000).toISOString() : null,
      lastError: null,
    };
    await this.write(`dpi.schedule.${await this.integrations.identity('dpi')}`, next);
    return next;
  }
  normalize(c: Record<string, unknown>) {
    const points = list(c.results)
      .filter((r) => r.is_direct !== true)
      .map(dpiPoint);
    const status = String(c.status ?? 'unknown');
    const progress = obj(c.progress);
    return {
      id: String(c.id ?? c.check_id ?? ''),
      kind: String(c.check_type ?? c.kind ?? 'ip'),
      status,
      createdAt: String(c.created_at ?? c.createdAt ?? ''),
      completedAt: typeof c.completed_at === 'string' ? c.completed_at : null,
      cost: number(c.usd_cost ?? c.estimated_cost),
      // Отменить можно только не начатую проверку — и тогда деньги возвращают целиком.
      refunded: status === 'cancelled',
      total: points.length || number(c.pop_count) || 0,
      success: points.length ? points.filter((p) => p.state === 'ok').length : null,
      unknown: points.filter((p) => p.state === 'unknown').length,
      progress:
        RUNNING.has(status) && number(progress.total)
          ? {
              done: number(progress.done) ?? 0,
              total: number(progress.total) ?? 0,
              percent: number(progress.percent) ?? 0,
            }
          : null,
      source: typeof c.source === 'string' ? c.source : null,
      results: points,
    };
  }
  private request(session: IntegrationSession, path: string, method = 'GET', body?: unknown, key?: string) {
    return this.integrations.providerRequest('dpi', path, method, body, key, session);
  }
  /**
   * Последние 100 проверок, свежие первыми. Порядок списка DPI Checker не описывает: если он идёт от старых к новым,
   * свежие лежат в конце — дочитываем до конца (с запомненного места, не больше 20 страниц за раз), иначе после сотой
   * проверки новые переставали бы попадать в панель.
   */
  private async recentChecks(session: IntegrationSession) {
    const page = async (offset: number) =>
      list(await this.request(session, `/checks?kind=check&limit=${PAGE}&offset=${offset}`));
    const newest = (items: Record<string, unknown>[]) => items.sort((a, b) => createdMs(b) - createdMs(a));
    const first = await page(0);
    if (first.length < PAGE || createdMs(first[0] ?? {}) >= createdMs(first[PAGE - 1] ?? {}))
      return newest(first);
    let offset = this.checksTail.get(session.identity) ?? PAGE;
    let last = offset === PAGE ? first : await page(offset - PAGE);
    // Проверок стало меньше, чем помнили, — идём с начала.
    if (last.length < PAGE) [offset, last] = [PAGE, first];
    for (let n = 0; n < 20; n++) {
      const next = await page(offset);
      if (next.length < PAGE) {
        last = [...last, ...next];
        break;
      }
      [last, offset] = [next, offset + PAGE];
    }
    this.checksTail.set(session.identity, offset);
    return newest(last.slice(-PAGE));
  }
  private async load(session: IntegrationSession) {
    const [items, pops] = await Promise.all([
      this.recentChecks(session),
      this.request(session, '/pops?location=russia&healthy=true'),
    ]);
    const refs = (await this.read(`dpi.node-checks.${session.identity}`)) ?? {};
    // Готовые проверки без точек — подробности один раз (кэш); идущие — каждый раз: в них ход проверки.
    let running = 0;
    for (let i = 0; i < items.length; i += 5)
      await Promise.all(
        items.slice(i, i + 5).map(async (c, index) => {
          const id = String(c.id ?? c.check_id ?? '');
          if (!/^\d+$/.test(id)) return;
          const live = RUNNING.has(String(c.status));
          if (live ? ++running > 5 : c.status !== 'completed' || list(c.results).length) return;
          const cacheKey = `${session.identity}:${id}`;
          let full = live ? undefined : this.completed.get(cacheKey);
          if (!full) {
            try {
              const raw = await this.request(session, `/checks/${id}`);
              full = obj(raw.data ?? raw);
              if (full.status === 'completed') this.completed.set(cacheKey, full);
            } catch {
              return;
            }
          }
          items[i + index] = { ...c, ...full };
        }),
      );
    for (const c of items) {
      const normalized = this.normalize(c),
        ref = refs[normalized.id];
      if (ref) await this.recordEvent(normalized, ref, session.identity);
    }
    if (this.completed.size > 500) this.completed.clear();
    return {
      checks: items.map((c) => ({
        ...this.normalize(c),
        node: refs[String(c.id ?? c.check_id)] ?? null,
      })),
      pops: list(pops)
        .map((p) => ({
          id: Number(p.id),
          name: String(p.name ?? p.region ?? p.city ?? p.location ?? p.id),
          provider: String(p.operator ?? p.provider ?? p.isp ?? ''),
        }))
        .filter((p) => Number.isInteger(p.id)),
    };
  }
  /** Баланс из профиля — не чаще раза в минуту; запуск и отмена присылают его сами. */
  private async freshBalance(session: IntegrationSession) {
    if (Date.now() - this.balanceAt < 60_000) return;
    this.balanceAt = Date.now();
    try {
      const data = await this.request(session, '/profile');
      await this.saveBalance(obj(data.data ?? data).balance);
    } catch {}
  }
  private async saveBalance(raw: unknown) {
    const value = number(raw);
    if (value !== null && value >= 0) await this.integrations.setBalance('dpi', String(value));
  }
  /** Тарифы и размер «оптимального» набора точек — раз в 10 минут: меняются редко. */
  private async extrasFor(session: IntegrationSession) {
    if (this.extras && Date.now() - this.extras.at < 600_000) return this.extras;
    const [tariffs, optimal] = await Promise.all([
      this.request(session, '/tariffs').catch(() => null),
      this.request(session, '/pops/optimal?location=russia').catch(() => null),
    ]);
    this.extras = {
      at: Date.now(),
      prices: parsePrices(tariffs),
      probe: parseProbePrice(tariffs),
      optimal: Array.isArray(optimal?.pop_ids) ? optimal.pop_ids.length : 10,
    };
    return this.extras;
  }
  async overview() {
    const status = await this.integrations.status('dpi');
    if (!status.connected) return { checks: [], pops: [], schedule: emptySchedule() };
    const session = await this.integrations.session('dpi');
    let cache = this.cache;
    // Пока проверка идёт, список свежий каждые 5 секунд — иначе ход и итог появлялись с опозданием.
    const ttl = cache?.data.checks.some((c) => RUNNING.has(c.status)) ? 5000 : 15000;
    if (!cache || cache.identity !== session.identity || Date.now() - cache.at > ttl) {
      cache = { identity: session.identity, at: Date.now(), data: await this.load(session) };
      if ((await this.integrations.identity('dpi')) !== session.identity)
        throw new BadRequestException('Подключение изменилось. Обновите страницу.');
      this.cache = cache;
    }
    await this.freshBalance(session);
    const extras = await this.extrasFor(session);
    return {
      ...cache.data,
      schedule: (await this.read(`dpi.schedule.${session.identity}`)) ?? emptySchedule(),
      balance: (await this.integrations.status('dpi')).balance,
      prices: extras.prices,
      probePrice: extras.probe,
      optimal: extras.optimal,
    };
  }
  private async nodeOf(nodeUuid: string) {
    const status = await this.remna.status();
    const node = status.nodes.find((n) => n.uuid === nodeUuid);
    if (!status.connected || !node) throw new BadRequestException('Нода не найдена.');
    return node;
  }
  /** Реестр РКН: есть ли адрес ноды или её подсеть в реестре блокировок. Бесплатно и сразу. */
  async rkn(nodeUuid: string) {
    const session = await this.integrations.session('dpi');
    const node = await this.nodeOf(nodeUuid);
    const raw = await this.request(session, `/cheremsha?resource=${encodeURIComponent(node.address)}`);
    const r = list(raw.results)[0];
    if (!r) throw new BadRequestException('Реестр не ответил по этому адресу. Повторите позже.');
    // «157.240.1.35 ∈ 157.240.0.0/16» — подсеть после знака.
    const subnet =
      typeof r.rkn_subnet_hit === 'string' ? (r.rkn_subnet_hit.split(' ∈ ')[1] ?? r.rkn_subnet_hit) : null;
    return {
      address: String(r.resource ?? node.address),
      blocked: r.blocked === true,
      subnet,
      domain: r.domain_hit === true,
      network: [r.asn_org, r.country].filter((x) => typeof x === 'string' && x).join(' · ') || null,
      refreshedAt: typeof raw.last_refresh === 'string' ? raw.last_refresh : null,
    };
  }
  /** Сколько бесплатных поисков соседей осталось на сегодня. */
  async noisyLeft() {
    const session = await this.integrations.session('dpi');
    const quota = obj(obj(await this.request(session, '/quota')).noisy);
    return { left: number(quota.remaining), limit: number(quota.limit), unlimited: quota.unlimited === true };
  }
  /** «Шумные соседи»: кто ещё в подсети /24 ноды и мешает. Бесплатно, 10 раз в сутки. */
  async noisyStart(nodeUuid: string) {
    const session = await this.integrations.session('dpi');
    const node = await this.nodeOf(nodeUuid);
    const target = subnet24(node.address);
    if (!target) throw new BadRequestException('Соседей ищут по адресу IPv4 — у этой ноды другой адрес.');
    const raw = obj(await this.request(session, '/checks/noisy', 'POST', { target }));
    return { id: String(raw.scan_id ?? ''), status: String(raw.status ?? 'pending') };
  }
  async noisy(id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Неверный номер проверки.');
    const session = await this.integrations.session('dpi');
    const raw = obj(await this.request(session, `/checks/noisy/${id}`));
    const a = obj(raw.analysis);
    const hosts = (v: unknown) =>
      list(v).map((x) => ({
        ip: String(x.ip ?? ''),
        domain: String(x.domain ?? ''),
        note: String(x.pattern ?? ''),
      }));
    return {
      id,
      status: String(raw.status ?? 'pending'),
      cidr: typeof raw.cidr === 'string' ? raw.cidr : null,
      count: number(raw.result_count) ?? 0,
      bad: hosts(a.bad_ru),
      foreign: hosts(a.bad_foreign),
      vpn: hosts(a.vpn_like),
      groups: list(a.grouped).map((g) => ({ label: String(g.label ?? ''), count: number(g.count) ?? 0 })),
    };
  }
  /** Зонд подсети /24: заблокирована вся подсеть или только адрес ноды. Платно: фикс сразу, трафик по итогу. */
  async probeStart(nodeUuid: string, requestId: string) {
    const session = await this.integrations.session('dpi');
    const node = await this.nodeOf(nodeUuid);
    const raw = obj(
      await this.request(session, '/checks/probe', 'POST', { target: node.address }, requestId),
    );
    await this.saveBalance(raw.balance);
    return { id: String(raw.scan_id ?? ''), status: String(raw.status ?? 'pending') };
  }
  async probe(id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Неверный номер проверки.');
    const session = await this.integrations.session('dpi');
    const raw = obj(await this.request(session, `/checks/probe/${id}`));
    const assessment = obj(obj(raw.results).assessment);
    // Суммы и трафик приходят то строкой, то числом.
    const fixed = number(raw.fixed_cost) ?? 0,
      traffic = number(raw.traffic_cost) ?? 0;
    return {
      id,
      status: String(raw.status ?? 'pending'),
      cidr: typeof raw.cidr === 'string' ? raw.cidr : null,
      verdict: typeof raw.verdict === 'string' ? raw.verdict : null,
      blocked: number(raw.blocked_ips),
      tested: number(raw.tested_ips),
      cost: fixed + traffic,
      ips: list(assessment.per_ip).map((p) => ({
        ip: String(p.ip ?? ''),
        domain: String(p.domain ?? ''),
        open: number(p.pops_green) ?? 0,
        closed: number(p.pops_red) ?? 0,
        total: number(p.pops_total) ?? 0,
      })),
      error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    };
  }
  async detail(id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Неверный номер проверки.');
    const session = await this.integrations.session('dpi');
    const raw = await this.request(session, `/checks/${id}`);
    const result = this.normalize(obj(raw.data ?? raw));
    const refs = await this.read(`dpi.node-checks.${session.identity}`);
    if (refs?.[id]) await this.recordEvent(result, refs[id], session.identity);
    return { ...result, node: refs?.[id] ?? null };
  }
  /** Тело запуска и оценки: адрес ноды (IP) или ключ (VLESS), точки — выбранные или «оптимальные» сервиса. */
  private async payload(
    session: IntegrationSession,
    body: { nodeUuid: string; kind: 'ip' | 'vpn'; key?: string | undefined; popIds: number[] },
  ) {
    const status = await this.remna.status();
    const node = status.nodes.find((n) => n.uuid === body.nodeUuid);
    if (!status.connected || !node) throw new BadRequestException('Нода не найдена.');
    let pops = body.popIds;
    if (!pops.length) {
      const p = await this.request(session, '/pops/optimal?location=russia');
      pops = Array.isArray(p.pop_ids) ? p.pop_ids.map(Number) : list(p).map((x) => Number(x.id));
    }
    if (!pops.length) throw new BadRequestException('Нет доступных точек проверки.');
    if (body.kind === 'vpn' && !body.key?.startsWith('vless://'))
      throw new BadRequestException('Для VPN-проверки вставьте VLESS-ключ.');
    return {
      node,
      panel: status.domain,
      payload: {
        location: 'russia',
        pop_ids: pops,
        ...(body.kind === 'ip' ? { resources: [node.address] } : { keys: [body.key] }),
      },
    };
  }
  /** Сколько спишут и хватит ли баланса — бесплатно, до запуска. */
  async estimate(body: { nodeUuid: string; kind: 'ip' | 'vpn'; key?: string | undefined; popIds: number[] }) {
    const session = await this.integrations.session('dpi');
    const { payload } = await this.payload(session, body);
    const raw = obj(
      await this.request(session, '/checks/estimate', 'POST', { check_type: body.kind, ...payload }),
    );
    const cost = number(raw.estimated_cost);
    if (cost === null) throw new BadRequestException('DPI Checker не назвал цену. Повторите позже.');
    const balance = number(raw.balance);
    if (balance !== null) await this.saveBalance(balance);
    return {
      cost,
      balance,
      affordable: raw.affordable === true || (balance !== null && balance >= cost),
      minutes: number(raw.estimated_max_minutes),
      pops: number(raw.pops) ?? payload.pop_ids.length,
    };
  }
  async start(
    body: {
      nodeUuid: string;
      kind: 'ip' | 'vpn';
      key?: string | undefined;
      popIds: number[];
      requestId: string;
    },
    captured?: IntegrationSession,
  ) {
    const session = captured ?? (await this.integrations.session('dpi'));
    const identity = session.identity;
    const old = await this.read(`dpi.request.${identity}.${body.requestId}`);
    if (old) return old;
    const { node, panel, payload } = await this.payload(session, body);
    const raw = await this.request(
      session,
      body.kind === 'ip' ? '/checks/ip' : '/checks/vpn',
      'POST',
      payload,
      body.requestId,
    );
    const answer = obj(raw.data ?? raw);
    const result = this.normalize(answer);
    if (!result.id)
      throw new BadRequestException(
        'Сервис не вернул номер проверки. Не повторяйте запуск без проверки истории.',
      );
    // Деньги списываются при запуске — ответ сразу несёт остаток.
    await this.saveBalance(answer.balance);
    const refKey = `dpi.node-checks.${identity}`;
    const value = JSON.stringify({ [result.id]: { uuid: node.uuid, name: node.name, panel } });
    await this.db.execute(
      sql`INSERT INTO app_meta(key,value) VALUES(${refKey},${value}) ON CONFLICT(key) DO UPDATE SET value=(app_meta.value::jsonb || excluded.value::jsonb)::text`,
    );
    await this.write(`dpi.request.${identity}.${body.requestId}`, result);
    await this.recordEvent(result, { uuid: node.uuid, name: node.name, panel }, identity);
    this.cache = null;
    return result;
  }
  /** Отмена ещё не начатой проверки: сервис возвращает деньги целиком. */
  async cancel(id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Неверный номер проверки.');
    const session = await this.integrations.session('dpi');
    const raw = obj(await this.request(session, `/checks/${id}`, 'DELETE'));
    await this.saveBalance(raw.balance);
    this.cache = null;
    return { refunded: number(raw.refunded) ?? 0 };
  }
  @Interval(30000) async tick() {
    if (this.busy || process.env.NODE_ENV === 'test') return;
    this.busy = true;
    try {
      await this.runSchedule();
    } catch {
    } finally {
      this.busy = false;
    }
  }
  /**
   * Запуски по расписанию. Не вышло для одной ноды — остальные всё равно проверяются, а причина остаётся в
   * расписании. Останавливается оно только когда повторять бессмысленно: нет денег, неверный ключ.
   */
  async runSchedule() {
    const session = await this.integrations.session('dpi');
    const key = `dpi.schedule.${session.identity}`;
    const schedule = ((await this.read(key)) ?? emptySchedule()) as DpiSchedule & { panel?: string };
    if (!schedule.enabled || !schedule.nextAt || Date.parse(schedule.nextAt) > Date.now()) return;
    const status = await this.remna.status();
    if (status.domain !== schedule.panel) {
      await this.write(key, {
        ...schedule,
        enabled: false,
        lastError: 'Подключённая панель изменилась. Выберите ноды заново.',
      });
      return;
    }
    await this.write(key, {
      ...schedule,
      nextAt: new Date(Date.now() + schedule.minutes * 60000).toISOString(),
    });
    const failed: string[] = [];
    let fatal: string | null = null;
    // Платная проверка ноды на обслуживании ничего не скажет: нода может быть выключена. Пропускаем без ошибки.
    const maintained = new Set(
      (await this.maintenance?.active(schedule.panel ?? null).catch(() => null))?.keys() ?? [],
    );
    for (const uuid of schedule.nodes) {
      const current = await this.read(key);
      if (!current?.enabled || current.panel !== schedule.panel) return;
      if (!current.nodes.includes(uuid) || maintained.has(uuid)) continue;
      try {
        await this.start(
          { nodeUuid: uuid, kind: 'ip', popIds: schedule.pops, requestId: randomUUID() },
          session,
        );
      } catch (e) {
        const name = status.nodes.find((n) => n.uuid === uuid)?.name ?? 'нода';
        failed.push(`${name}: ${errorText(e)}`);
        if (FATAL.has(providerCode(e) ?? '')) {
          fatal = errorText(e);
          break;
        }
      }
    }
    const current = (await this.read(key)) ?? schedule;
    await this.write(key, {
      ...current,
      ...(fatal ? { enabled: false, nextAt: null } : {}),
      lastError: fatal
        ? `Расписание остановлено: ${fatal}`
        : failed.length
          ? `Последний запуск — не для всех нод. ${failed.join('; ')}`
          : null,
    });
  }
  private async recordEvent(
    result: ReturnType<DpiService['normalize']>,
    ref: { uuid: string; name: string; panel: string | null },
    identity: string,
  ) {
    if (!this.timeline || !ref.panel || !ref.uuid) return;
    const finished = ['completed', 'failed', 'cancelled'].includes(result.status);
    const stage = finished ? result.status : 'started';
    const created = Date.parse(result.createdAt);
    const known = result.success === null ? null : result.total - result.unknown;
    await this.timeline.append(ref.panel, {
      id: `dpi:${identity}:${result.id}:${stage}`,
      t: finished || !Number.isFinite(created) ? Date.now() : created,
      nodeUuid: ref.uuid,
      nodeName: ref.name,
      type: 'dpi_check',
      title: `DPI Checker · ${finished ? 'Получен результат' : 'Проверка запущена'}`,
      summary: `Режим ${result.kind === 'vpn' ? 'VLESS' : result.kind.toUpperCase()} · ${known === null ? 'Доступность ещё неизвестна' : `открывается в ${result.success} из ${known} точек`}${result.refunded ? ' · отменена, деньги вернули' : result.cost === null ? '' : ` · ${result.cost} USD`}`,
      link: '/integrations/dpi',
    });
  }
}
/**
 * Цены из /tariffs: {"locations":{"russia":{"ip":{"popPrice","resourcePrice"},"vpn":{…}}},"probe":{…},"noisy":{…}}.
 * Ответ без нужных чисел — null: цену назовёт оценка перед запуском.
 */
export function parsePrices(raw: unknown) {
  const russia = obj(obj(obj(raw).locations).russia);
  const pick = (mode: string) => {
    const m = obj(russia[mode]);
    const pop = number(m.popPrice ?? m.pop_price);
    const resource = number(m.resourcePrice ?? m.resource_price);
    return pop === null || resource === null ? null : { pop, resource };
  };
  const ip = pick('ip'),
    vpn = pick('vpn');
  return ip && vpn
    ? { ipPop: ip.pop, ipResource: ip.resource, vpnPop: vpn.pop, vpnResource: vpn.resource }
    : null;
}
/** Цена зонда подсети: фиксированная часть сразу и за гигабайт трафика по итогу. */
export function parseProbePrice(raw: unknown) {
  const probe = obj(obj(raw).probe);
  const fixed = number(probe.fixed_usd),
    perGb = number(probe.traffic_usd_per_gb);
  return fixed === null || perGb === null ? null : { fixed, perGb };
}
/** Подсеть /24 адреса IPv4: «198.51.100.0/24». IPv6 и домены — null. */
export const subnet24 = (address: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address.trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null;
};

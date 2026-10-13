import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { type BsProbeInput, type BsRun, bsAccountSchema, bsUnitSchema } from '@nodeservice/shared';
import { and, desc, eq, like, lt, sql } from 'drizzle-orm';
import { problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { publicIp } from '../incidents/check-host.service.js';
import { NodeEventsStore } from '../node-events/node-events.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { bsErrorText } from './bs-errors.js';
import { type IntegrationSession, IntegrationsService } from './integrations.service.js';

type Stored = {
  createdAt?: string;
  node?: { panel: string; uuid: string; name: string };
  identity: string;
  body: Record<string, unknown>;
  cost: number;
  expiresAt: string;
  run: BsRun;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/**
 * Ошибка BS Checker. uncertain — итог неизвестен (платный запрос ушёл, ответа нет или он ещё идёт): повторять
 * только тем же ключом идемпотентности. Иначе отказ окончательный и text — что сказать владельцу.
 */
export class BsError extends Error {
  constructor(
    public readonly code: string,
    public readonly uncertain: boolean,
    public readonly status = 0,
    public readonly details: unknown = null,
  ) {
    super(code);
  }
  get text() {
    return bsErrorText(this.code, this.details, this.status);
  }
}
@Injectable()
export class BsCheckerService {
  private active = new Map<string, Promise<BsRun>>();
  constructor(
    @Inject(DB) private db: Db,
    private integrations: IntegrationsService,
    @Optional() private remna?: RemnawaveService,
    @Optional() private timeline?: NodeEventsStore,
  ) {}
  private async read(id: string): Promise<Stored | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, `bschecker.run.${id}`) });
    return row ? JSON.parse(row.value) : null;
  }
  private async write(id: string, data: Stored) {
    await this.db
      .insert(appMeta)
      .values({ key: `bschecker.run.${id}`, value: JSON.stringify(data) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(data), updatedAt: new Date() },
      });
  }
  private async request(
    session: IntegrationSession,
    path: string,
    body?: unknown,
    key?: string,
    method?: string,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`https://bsbord.com/v1${path}`, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${session.credentials.apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(body ? 105000 : 15000),
      });
    } catch {
      throw new BsError('connection_lost', Boolean(key));
    }
    let data: Record<string, unknown>;
    try {
      const raw = await res.text();
      if (raw.length > 2000000) throw Error();
      data = obj(JSON.parse(raw));
    } catch {
      throw new BsError('invalid_response', Boolean(key));
    }
    if (!res.ok) {
      const error = obj(data.error);
      const code = typeof error.code === 'string' ? error.code : 'provider_error';
      // 503 — сервис не взялся (кредиты не списаны); 500 и непонятные 5xx на платном запросе — итог неизвестен:
      // списание могло случиться, повторять только тем же ключом.
      const uncertain =
        Boolean(key) && (code === 'request_in_progress' || (res.status >= 500 && res.status !== 503));
      throw new BsError(code, uncertain, res.status, error.details ?? null);
    }
    return data;
  }
  async workspace() {
    const session = await this.integrations.session('bschecker');
    const [aResult, uResult] = await Promise.allSettled([
      this.request(session, '/account'),
      this.request(session, '/operators?dpi=any'),
    ]);
    if (aResult.status === 'rejected')
      throw problem(502, {
        type: 'urn:nodeservice:bschecker:account',
        detail: 'BS Checker не вернул баланс. Проверьте доступность сервиса и API-ключ.',
      });
    const a = aResult.value;
    const parsed = bsAccountSchema.safeParse({
      balanceCredits: a.balance_credits,
      bonusCredits: a.bonus_credits,
      totalCredits: a.balance_total,
      tier: a.tier,
      tierExpiresAt: a.tier_expires_at ?? null,
    });
    if (!parsed.success)
      throw problem(502, {
        type: 'urn:nodeservice:bschecker:account',
        detail: 'Формат баланса BS Checker изменился. Проверка не запускалась.',
      });
    const u = uResult.status === 'fulfilled' ? uResult.value : {};
    const units = Array.isArray(u.units)
      ? u.units.map((x) => bsUnitSchema.safeParse(x)).flatMap((p) => (p.success ? [p.data] : []))
      : [];
    const incomplete =
      uResult.status === 'rejected' || !Array.isArray(u.units) || units.length !== u.units.length;
    return {
      account: parsed.data,
      units,
      unitsError: incomplete ? 'Часть точек не удалось загрузить. Обновите список перед проверкой.' : null,
    };
  }

  async rentalRequest(path: string, body?: unknown, key?: string, method?: string) {
    const session = await this.integrations.session('bschecker');
    try {
      return await this.request(session, path, body, key, method);
    } catch (e) {
      if (e instanceof BsError && e.uncertain) throw e;
      // Окончательный отказ — понятной причиной: «нет права», «точка занята», «адрес в блок-листе».
      if (e instanceof BsError) throw new BadRequestException(e.text);
      throw problem(502, {
        type: 'urn:nodeservice:bschecker:rentals',
        detail: 'BS Checker не выполнил действие с точкой. Проверьте её состояние и повторите.',
      });
    }
  }
  async preview(input: BsProbeInput) {
    const host = isIP(input.ip) ? input.ip : domainToASCII(input.ip).toLowerCase();
    const domain =
      host.length <= 253 &&
      host.split('.').length >= 2 &&
      host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
      /[a-z]/.test(host.split('.').at(-1) ?? '') &&
      !/\.(?:localhost|local|internal)$/.test(host);
    if (isIP(host) ? !publicIp(host) : !domain)
      throw new BadRequestException('Введите публичный IP или домен без протокола и пути.');
    let nodeRef: Stored['node'];
    if (input.nodeUuid) {
      const status = await this.remna?.status();
      const node = status?.nodes.find((n) => n.uuid === input.nodeUuid);
      if (!status?.domain || !node || node.address.toLowerCase() !== host.toLowerCase())
        throw new BadRequestException('Нода или её адрес изменились. Выберите ноду повторно.');
      nodeRef = { panel: status.domain, uuid: node.uuid, name: node.name };
    }
    const session = await this.integrations.session('bschecker');
    const catalog = await this.request(session, '/operators?dpi=any&probeable=true');
    // Точка в незнакомом виде пропускается, как в workspace(): если её выбрали — «единицы недоступны».
    const units = Array.isArray(catalog.units)
      ? catalog.units.flatMap((x) => {
          const p = bsUnitSchema.safeParse(x);
          return p.success ? [p.data] : [];
        })
      : [];
    const operators = [...new Set(input.operators)];
    if (operators.some((key) => !units.some((u) => u.op_key === key && u.probeable)))
      throw new BadRequestException('Выбранные единицы недоступны. Обновите список.');
    const target = `${host.includes(':') ? `[${host}]` : host}:${input.port}`;
    // Точки перечислены явно (op_key с режимом БС) — фильтр dpi «любые», иначе сервис отсеет точки без БС.
    const body = {
      target,
      operators,
      probes: { tcp: input.tcp, icmp: input.icmp, sni: Boolean(input.sniHost) },
      ...(input.sniHost ? { sni_hosts: [input.sniHost] } : {}),
      dpi: 'any',
    };
    let answer: Record<string, unknown>;
    try {
      answer = await this.request(session, '/probe/preview', body);
    } catch (e) {
      throw new BadRequestException(
        `${e instanceof BsError ? e.text : 'BS Checker не смог рассчитать стоимость.'} Проверка не запущена.`,
      );
    }
    const cost = answer.cost_credits;
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0)
      throw new BadRequestException('Сервис не вернул корректную стоимость.');
    await this.sweep();
    // Opaque preview binds exact target, units, price and credential identity; execute accepts only this id.
    const id = randomUUID(),
      expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    const run: BsRun = {
      id,
      status: 'ready',
      costCredits: null,
      refundedCredits: null,
      error: null,
      rows: [],
    };
    await this.write(id, {
      ...(nodeRef ? { node: nodeRef } : {}),
      createdAt: new Date().toISOString(),
      identity: session.identity,
      body,
      cost,
      expiresAt,
      run,
    });
    const level = obj(answer.level);
    return {
      id,
      costCredits: cost,
      fullCredits: typeof answer.full_credits === 'number' ? answer.full_credits : null,
      discountPct:
        typeof level.discount_pct === 'number' && level.discount_pct > 0 ? level.discount_pct : null,
      levelName: typeof level.name === 'string' && level.name ? level.name : null,
      units: operators,
      expiresAt,
    };
  }
  /** Расчёт цены идёт сам при каждом изменении формы: незапущенные расчёты старше часа убираем. Сбой — не помеха. */
  private async sweep() {
    try {
      await this.db
        .delete(appMeta)
        .where(
          and(
            like(appMeta.key, 'bschecker.run.%'),
            lt(appMeta.updatedAt, new Date(Date.now() - 3_600_000)),
            sql`${appMeta.value} LIKE '%"status":"ready"%'`,
          ),
        );
    } catch {}
  }
  async history() {
    const identity = await this.integrations.identity('bschecker');
    const records = await this.db.query.appMeta.findMany({
      where: like(appMeta.key, 'bschecker.run.%'),
      orderBy: desc(appMeta.updatedAt),
      limit: 200,
    });
    const runs = records
      .flatMap((row) => {
        try {
          const saved: Stored = JSON.parse(row.value);
          if (saved.identity !== identity || saved.run.status === 'ready') return [];
          return [
            {
              run: saved.run,
              target: String(saved.body.target ?? ''),
              createdAt: saved.createdAt ?? new Date(Date.parse(saved.expiresAt) - 600000).toISOString(),
              units: Array.isArray(saved.body.operators) ? saved.body.operators.length : 0,
              estimatedCredits: saved.cost,
              nodeName: saved.node?.name ?? null,
              operators: Array.isArray(saved.body.operators) ? saved.body.operators.map(String) : [],
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 100);
    return { runs };
  }
  async get(id: string) {
    const saved = await this.read(id);
    if (!saved) throw new BadRequestException('Проверка не найдена.');
    if ((await this.integrations.identity('bschecker')) !== saved.identity)
      throw new BadRequestException('Подключение изменилось.');
    return saved.run;
  }
  async execute(id: string): Promise<BsRun> {
    const pending = this.active.get(id);
    if (pending) return pending;
    const promise = this.run(id).finally(() => this.active.delete(id));
    this.active.set(id, promise);
    return promise;
  }
  private async run(id: string): Promise<BsRun> {
    const saved = await this.read(id);
    if (!saved) throw new BadRequestException('Сначала рассчитайте стоимость.');
    const session = await this.integrations.session('bschecker');
    if (session.identity !== saved.identity)
      throw new BadRequestException('API-ключ изменился. Рассчитайте стоимость заново.');
    if (['done', 'failed'].includes(saved.run.status)) return saved.run;
    if (saved.run.status === 'ready') {
      if (Date.parse(saved.expiresAt) < Date.now())
        throw new BadRequestException('Расчёт устарел. Рассчитайте стоимость заново.');
      const p = await this.request(session, '/probe/preview', saved.body);
      if (typeof p.cost_credits !== 'number' || p.cost_credits > saved.cost)
        throw new BadRequestException('Стоимость изменилась. Рассчитайте заново перед запуском.');
    }
    saved.run = { ...saved.run, status: 'running', error: null };
    await this.write(id, saved);
    try {
      // Same UUID and body on every manual retry: no second charge after 524/timeouts/409 in-progress.
      const answer = await this.request(session, '/probe', saved.body, id);
      const rows: BsRun['rows'] = [];
      for (const target of Object.values(obj(answer.by_target)))
        for (const [unit, value] of Object.entries(obj(obj(target).by_operator))) {
          const leg = obj(value),
            tcp = obj(leg.tcp),
            icmp = obj(leg.icmp);
          // ok ноги — «проба выполнена», а не «цель доступна»: доступность — по вложенным TCP и ICMP.
          const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
          rows.push({
            unit,
            operator: String(leg.operator ?? unit),
            region: String(leg.region ?? ''),
            dpi: String(leg.dpi ?? ''),
            tcp: typeof tcp.ok === 'boolean' ? tcp.ok : null,
            icmp: typeof icmp.ok === 'boolean' ? icmp.ok : null,
            tcpIsTls: leg.tcp_is_tls === true,
            latency: ms(tcp.latency_ms) ?? ms(icmp.rtt_avg_ms) ?? ms(icmp.latency_ms),
            dnsFail: leg.dns_fail === true,
            error:
              typeof tcp.error === 'string'
                ? tcp.error.slice(0, 160)
                : typeof leg.error === 'string'
                  ? leg.error.slice(0, 160)
                  : null,
          });
        }
      // 200 с outcome «no_dpi_on» — гонка: точки сменили режим белого списка перед самым стартом, списания нет.
      if (answer.outcome !== 'done')
        throw new BsError(answer.outcome === 'no_dpi_on' ? 'no_dpi_on' : 'request_denied', false);
      saved.run = {
        ...saved.run,
        status: 'done',
        rows,
        skippedCount: ['skipped', 'skipped_dpi_off', 'skipped_unavailable'].reduce(
          (sum, k) => sum + (Array.isArray(answer[k]) ? answer[k].length : 0),
          0,
        ),
        costCredits: typeof answer.cost_credits === 'number' ? answer.cost_credits : null,
        refundedCredits: typeof answer.refunded === 'number' ? answer.refunded : null,
      };
    } catch (e) {
      const err = e instanceof BsError ? e : new BsError('invalid_result', true);
      saved.run = {
        ...saved.run,
        status: err.uncertain ? 'uncertain' : 'failed',
        error: err.uncertain
          ? 'Результат пока неизвестен. Получите его повторно: будет использован тот же ключ, без новой проверки.'
          : `${err.text} Кредиты не списаны.`,
      };
    }
    await this.write(id, saved);
    await this.recordEvent(saved);
    return saved.run;
  }
  private async recordEvent(saved: Stored) {
    if (!this.timeline || !saved.node || saved.run.status === 'ready') return;
    const run = saved.run,
      known = run.rows.filter((r) => r.tcp !== null),
      accessible = known.filter((r) => r.tcp === true).length;
    const status = {
      ready: 'Готова',
      running: 'Запущена',
      done: 'Завершена',
      uncertain: 'Результат уточняется',
      failed: 'Не выполнена',
    }[run.status];
    await this.timeline.append(saved.node.panel, {
      id: `bs:${run.id}:${run.status}`,
      t: Date.now(),
      nodeUuid: saved.node.uuid,
      nodeName: saved.node.name,
      type: 'bs_check',
      title: `BS Checker · ${status}`,
      summary: `${saved.body.target} · TCP: ${known.length ? `${accessible}/${known.length} доступно` : 'нет данных'} · ${run.costCredits ?? saved.cost} Cred`,
      link: '/integrations/bschecker',
    });
  }
}

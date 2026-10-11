import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
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
const number = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
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
@Injectable()
export class DpiService {
  private busy = false;
  private completed = new Map<string, Record<string, unknown>>();
  private cache: { identity: string; at: number; data: Awaited<ReturnType<DpiService['load']>> } | null =
    null;
  constructor(
    @Inject(DB) private db: Db,
    private integrations: IntegrationsService,
    private remna: RemnawaveService,
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
    return (await this.read('dpi.schedule.' + (await this.integrations.identity('dpi')))) ?? emptySchedule();
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
    await this.write('dpi.schedule.' + (await this.integrations.identity('dpi')), next);
    return next;
  }
  normalize(c: Record<string, unknown>) {
    const samples = list(c.results).filter((r) => r.is_direct !== true);
    return {
      id: String(c.id ?? c.check_id ?? ''),
      kind: String(c.check_type ?? c.kind ?? 'IP'),
      status: String(c.status ?? 'unknown'),
      createdAt: String(c.created_at ?? c.createdAt ?? ''),
      cost: number(c.usd_cost ?? c.estimated_cost),
      total: samples.length,
      success: samples.length
        ? samples.filter((r) => r.accessible === true || r.connected === true).length
        : null,
      results: samples.map((r) => ({
        location: String(r.pop_name ?? r.region ?? r.city ?? r.location ?? r.pop_id ?? 'Точка'),
        accessible:
          typeof r.accessible === 'boolean'
            ? r.accessible
            : typeof r.connected === 'boolean'
              ? r.connected
              : null,
        latency: number(r.latency_ms ?? r.tcp_latency_ms ?? r.ping_avg_ms ?? r.latency),
      })),
    };
  }
  private async load(session: IntegrationSession) {
    const [checks, pops] = await Promise.all([
      this.integrations.providerRequest(
        'dpi',
        '/checks?kind=check&limit=100&offset=0',
        'GET',
        undefined,
        undefined,
        session,
      ),
      this.integrations.providerRequest(
        'dpi',
        '/pops?location=russia&healthy=true',
        'GET',
        undefined,
        undefined,
        session,
      ),
    ]);
    const refs = (await this.read('dpi.node-checks.' + session.identity)) ?? {};
    const items = list(checks);
    for (let i = 0; i < items.length; i += 5)
      await Promise.all(
        items.slice(i, i + 5).map(async (c, index) => {
          const id = String(c.id ?? c.check_id ?? '');
          if (!/^\d+$/.test(id) || c.status !== 'completed' || list(c.results).length) return;
          const cacheKey = session.identity + ':' + id;
          let full = this.completed.get(cacheKey);
          if (!full) {
            try {
              const raw = await this.integrations.providerRequest(
                'dpi',
                '/checks/' + id,
                'GET',
                undefined,
                undefined,
                session,
              );
              full = obj(raw.data ?? raw);
              if (full.status === 'completed') this.completed.set(cacheKey, full);
            } catch {
              return;
            }
          }
          items[i + index] = { ...c, ...full };
        }),
      );
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
  async overview() {
    const status = await this.integrations.status('dpi');
    if (!status.connected) return { checks: [], pops: [], schedule: emptySchedule() };
    const session = await this.integrations.session('dpi');
    let cache = this.cache;
    if (!cache || cache.identity !== session.identity || Date.now() - cache.at > 15000) {
      cache = { identity: session.identity, at: Date.now(), data: await this.load(session) };
      if ((await this.integrations.identity('dpi')) !== session.identity)
        throw new BadRequestException('Подключение изменилось. Обновите страницу.');
      this.cache = cache;
    }
    return {
      ...cache.data,
      schedule: (await this.read('dpi.schedule.' + session.identity)) ?? emptySchedule(),
    };
  }
  async detail(id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Неверный номер проверки.');
    const raw = await this.integrations.providerRequest('dpi', '/checks/' + id);
    return this.normalize(obj(raw.data ?? raw));
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
    const status = await this.remna.status();
    const node = status.nodes.find((n) => n.uuid === body.nodeUuid);
    if (!status.connected || !node) throw new BadRequestException('Нода не найдена.');
    const identity = session.identity;
    const old = await this.read('dpi.request.' + identity + '.' + body.requestId);
    if (old) return old;
    let pops = body.popIds;
    if (!pops.length) {
      const p = await this.integrations.providerRequest(
        'dpi',
        '/pops/optimal?location=russia',
        'GET',
        undefined,
        undefined,
        session,
      );
      pops = Array.isArray(p.pop_ids) ? p.pop_ids.map(Number) : list(p).map((x) => Number(x.id));
    }
    if (!pops.length) throw new BadRequestException('Нет доступных точек проверки.');
    if (body.kind === 'vpn' && !body.key?.startsWith('vless://'))
      throw new BadRequestException('Для VPN-проверки вставьте VLESS-ключ.');
    const payload = {
      location: 'russia',
      pop_ids: pops,
      ...(body.kind === 'ip' ? { resources: [node.address] } : { keys: [body.key] }),
    };
    const raw = await this.integrations.providerRequest(
      'dpi',
      body.kind === 'ip' ? '/checks/ip' : '/checks/vpn',
      'POST',
      payload,
      body.requestId,
      session,
    );
    const result = this.normalize(obj(raw.data ?? raw));
    if (!result.id)
      throw new BadRequestException(
        'Сервис не вернул номер проверки. Не повторяйте запуск без проверки истории.',
      );
    const refKey = 'dpi.node-checks.' + identity;
    const value = JSON.stringify({ [result.id]: { uuid: node.uuid, name: node.name, panel: status.domain } });
    await this.db.execute(
      sql`INSERT INTO app_meta(key,value) VALUES(${refKey},${value}) ON CONFLICT(key) DO UPDATE SET value=(app_meta.value::jsonb || excluded.value::jsonb)::text`,
    );
    await this.write('dpi.request.' + identity + '.' + body.requestId, result);
    this.cache = null;
    return result;
  }
  @Interval(30000) async tick() {
    if (this.busy || process.env.NODE_ENV === 'test') return;
    this.busy = true;
    try {
      const session = await this.integrations.session('dpi');
      const schedule = ((await this.read('dpi.schedule.' + session.identity)) ??
        emptySchedule()) as DpiSchedule & { panel?: string };
      if (!schedule.enabled || !schedule.nextAt || Date.parse(schedule.nextAt) > Date.now()) return;
      const status = await this.remna.status();
      if (status.domain !== schedule.panel) {
        await this.write('dpi.schedule.' + session.identity, {
          ...schedule,
          enabled: false,
          lastError: 'Подключённая панель изменилась. Выберите ноды заново.',
        });
        return;
      }
      const scheduledAt = schedule.nextAt;
      await this.write('dpi.schedule.' + session.identity, {
        ...schedule,
        nextAt: new Date(Date.now() + schedule.minutes * 60000).toISOString(),
      });
      for (const uuid of schedule.nodes) {
        const current = await this.read('dpi.schedule.' + session.identity);
        if (!current?.enabled || current.panel !== schedule.panel) break;
        if (!current.nodes.includes(uuid)) continue;
        try {
          await this.start(
            { nodeUuid: uuid, kind: 'ip', popIds: schedule.pops, requestId: randomUUID() },
            session,
          );
        } catch {
          await this.write('dpi.schedule.' + session.identity, {
            ...schedule,
            enabled: false,
            nextAt: null,
            lastError: `Проверка по расписанию ${scheduledAt} не завершена. Проверьте историю и подключение.`,
          });
          break;
        }
      }
    } catch {
    } finally {
      this.busy = false;
    }
  }
}

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  CAPACITY_RESOURCES,
  CAPACITY_WINDOW_DAYS,
  type Capacity,
  type CapacityResource,
  type CapacityServer,
  type ServerLink,
  VM_METRIC_NAMES,
} from '@nodeservice/shared';

import { errorText, problem } from '../../common/filters/problem-details.filter.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { type ServerLinkRow, serverLink } from '../../infra/db/schema/index.js';
import { AuditService } from '../audit/audit.service.js';
import { NODE_ONLINE_METRIC } from '../fleet-stats/fleet-stats.service.js';
import type { VmMatrixSeries } from '../metrics/vm-reader.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { NodeLinkService } from '../remnawave/node-link.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import {
  type CapacitySeries,
  computeCapacity,
  daysUntilFull,
  effectiveLink,
  LINK_PROBE_COMMAND,
  parseLinkProbe,
  parseSpeedTest,
  speedTestCommand,
  toneOf,
  weeklyGrowthPct,
} from './capacity.logic.js';

const STEP = 600;
const PROBE_TTL_MS = 24 * 3_600_000;
const CACHE_TTL_MS = 3_600_000;

const iso = (sec: number | null) => (sec == null ? null : new Date(sec * 1000).toISOString());

/** Ряды по серверам на общей сетке: server_id (или node_uuid) → время → значение. */
function grid(res: VmMatrixSeries[] | null, label: string): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const s of res ?? []) {
    const id = s.labels[label];
    if (!id) continue;
    const m = out.get(id) ?? new Map<number, number>();
    for (const [t, v] of s.points) if (Number.isFinite(v)) m.set(Math.round(t), v);
    out.set(id, m);
  }
  return out;
}

/**
 * Ёмкость парка: сколько ещё людей выдержит каждая нода и во что упрётся первой. Считается раз в час
 * (и по кнопке «Пересчитать»), ответ держится в памяти. Канал: сетевая карта по SSH раз в сутки, замер — по кнопке.
 */
@Injectable()
export class CapacityService {
  private readonly log = new Logger(CapacityService.name);
  private cache: { at: number; value: Capacity } | null = null;
  private computing: Promise<Capacity> | null = null;
  private readonly measuring = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vm: VmReaderService,
    private readonly remnawave: RemnawaveService,
    private readonly repo: ServersRepository,
    private readonly servers: ServersService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
    private readonly nodeLinks: NodeLinkService,
  ) {}

  async get(): Promise<Capacity> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    return this.recompute();
  }

  /** Пересчитать сейчас (одновременные вызовы ждут один расчёт). */
  recompute(): Promise<Capacity> {
    this.computing ??= this.compute()
      .then((value) => {
        this.cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.computing = null;
      });
    return this.computing;
  }

  /* ─────────── канал ─────────── */

  private async linkRows(): Promise<Map<string, ServerLinkRow>> {
    const rows = await this.db.select().from(serverLink);
    return new Map(rows.map((r) => [r.serverId, r]));
  }

  private async upsertLink(serverId: string, patch: Partial<Omit<ServerLinkRow, 'serverId'>>): Promise<void> {
    await this.db
      .insert(serverLink)
      .values({ serverId, ...patch })
      .onConflictDoUpdate({ target: serverLink.serverId, set: patch });
  }

  /** Сетевые карты, которые давно не смотрели: раз в сутки, по SSH, только чтение. */
  async probeStaleLinks(): Promise<void> {
    const [rows, links] = await Promise.all([this.repo.list(), this.linkRows()]);
    const stale = rows.filter((r) => {
      const at = links.get(r.id)?.probedAt?.getTime() ?? 0;
      return r.sshOk !== false && Date.now() - at > PROBE_TTL_MS;
    });
    for (const r of stale) {
      try {
        const { target } = await this.servers.sshTargetFor(r.id);
        const session = await this.ssh.connect(target);
        try {
          const res = await session.exec(LINK_PROBE_COMMAND);
          await this.upsertLink(r.id, { ...parseLinkProbe(res.stdout), probedAt: new Date() });
        } finally {
          session.end();
        }
      } catch (err) {
        // Недоступный сервер попробуем через сутки; главное — не мешать расчёту остальных.
        await this.upsertLink(r.id, { probedAt: new Date() });
        this.log.warn(`Канал ${r.name}: ${errorText(err)}`);
      }
    }
  }

  /** Замер скорости с сервера: ≈ 20 с, до ≈ 2 ГБ трафика. К свободной полосе прибавляем то, что уже шло. */
  async measure(serverId: string): Promise<ServerLink> {
    if (this.measuring.has(serverId))
      throw problem(HttpStatus.CONFLICT, { detail: 'Замер на этом сервере уже идёт — дождитесь окончания.' });
    const { target, name } = await this.servers.sshTargetFor(serverId);
    this.measuring.add(serverId);
    try {
      const busy = await this.currentMbit(serverId);
      const session = await this.ssh.connect(target);
      let out = '';
      try {
        const res = await session.execStream(speedTestCommand(), {
          timeoutMs: 90_000,
          onData: (c) => {
            out += c;
          },
        });
        if (res.code !== 0)
          throw problem(HttpStatus.BAD_GATEWAY, {
            detail: 'Замер не получился: команда на сервере завершилась с ошибкой.',
          });
      } finally {
        session.end();
      }
      const r = parseSpeedTest(out);
      if (r.error) throw problem(HttpStatus.BAD_GATEWAY, { detail: `Замер не получился: ${r.error}.` });
      const down = r.downMbit == null ? null : Math.round(r.downMbit + busy.rx);
      const up = r.upMbit == null ? null : Math.round(r.upMbit + busy.tx);
      await this.upsertLink(serverId, { measuredDownMbit: down, measuredUpMbit: up, measuredAt: new Date() });
      await this.audit.record({
        action: 'server.link.measured',
        target: { type: 'server', id: serverId, display: name },
        metadata: { down: `${down ?? '—'} Мбит/с`, up: `${up ?? '—'} Мбит/с` },
      });
      this.cache = null;
      return effectiveLink((await this.linkRows()).get(serverId) ?? null);
    } catch (err) {
      await this.audit.record({
        action: 'server.link.measured',
        result: 'failed',
        severity: 'warn',
        target: { type: 'server', id: serverId, display: name },
        metadata: { reason: errorText(err).slice(0, 300) },
      });
      throw err;
    } finally {
      this.measuring.delete(serverId);
    }
  }

  /** Сколько сервер отдаёт и принимает прямо сейчас, Мбит/с (из метрик агента). */
  private async currentMbit(serverId: string): Promise<{ rx: number; tx: number }> {
    const M = VM_METRIC_NAMES;
    const one = async (m: string) => {
      const r = await this.vm.query(`avg_over_time(${m}{server_id="${serverId}"}[2m])`);
      const v = r?.[0]?.points.at(-1)?.[1];
      return v != null && Number.isFinite(v) ? (v * 8) / 1e6 : 0;
    };
    const [rx, tx] = await Promise.all([one(M.netRxBps), one(M.netTxBps)]);
    return { rx, tx };
  }

  async setManual(serverId: string, mbit: number | null): Promise<ServerLink> {
    const row = await this.repo.findById(serverId);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Сервер не найден — возможно, уже удалён.' });
    const before = (await this.linkRows()).get(serverId)?.manualMbit ?? null;
    await this.upsertLink(serverId, { manualMbit: mbit });
    this.audit.extend({ changes: { 'Канал вручную, Мбит/с': { before, after: mbit } } });
    this.cache = null;
    return effectiveLink((await this.linkRows()).get(serverId) ?? null);
  }

  /* ─────────── расчёт ─────────── */

  private async compute(): Promise<Capacity> {
    const end = Math.floor(Date.now() / 1000 / STEP) * STEP;
    const start = end - CAPACITY_WINDOW_DAYS * 86_400;
    const [rows, links, rw] = await Promise.all([
      this.repo.list(),
      this.linkRows(),
      this.remnawave.status().catch(() => null),
    ]);
    const nodes = rw?.connected ? rw.nodes : [];
    const sel = rows.length ? `{server_id=~"${rows.map((r) => r.id).join('|')}"}` : '{server_id="none"}';
    const M = VM_METRIC_NAMES;
    const by = (q: string) => `avg by (server_id) (${q})`;
    const w = `[${STEP}s]`;
    const [online, cpu, mem, rx, tx, conn] = await Promise.all([
      this.vm.queryRange(`max by (node_uuid) (max_over_time(${NODE_ONLINE_METRIC}${w}))`, start, end, STEP),
      this.vm.queryRange(by(`avg_over_time(${M.cpuPct}${sel}${w})`), start, end, STEP),
      this.vm.queryRange(
        `100 * ${by(`avg_over_time(${M.memUsedMb}${sel}${w})`)} / ${by(`max_over_time(${M.memTotalMb}${sel}${w}) > 0`)}`,
        start,
        end,
        STEP,
      ),
      this.vm.queryRange(`${by(`avg_over_time(${M.netRxBps}${sel}${w})`)} * 8 / 1000000`, start, end, STEP),
      this.vm.queryRange(`${by(`avg_over_time(${M.netTxBps}${sel}${w})`)} * 8 / 1000000`, start, end, STEP),
      this.vm.queryRange(by(`avg_over_time(${M.conntrackCount}${sel}${w})`), start, end, STEP),
    ]);
    const vmOk = cpu !== null;
    const t: number[] = [];
    for (let x = start; x <= end; x += STEP) t.push(x);

    // Онлайн ноды → сервер: по общей связи «сервер ↔ нода» (адрес, IP, выбор в профиле); мосту — сумма
    // выходов, что за ним. У ноды с несколькими записями одной машины онлайн идёт основной, чтобы не удвоить.
    const onlineByNode = grid(online, 'node_uuid');
    const nodeLinks = await this.nodeLinks.resolve(
      rows.map((r) => this.servers.toDto(r)),
      nodes,
    );
    const serverOnline = new Map<string, Map<number, number>>();
    const add = (id: string, m: Map<number, number>) => {
      const cur = serverOnline.get(id) ?? new Map<number, number>();
      for (const [k, v] of m) cur.set(k, (cur.get(k) ?? 0) + v);
      serverOnline.set(id, cur);
    };
    const nodeServers = new Set<string>();
    for (const n of nodes) {
      const id = nodeLinks.serverIdsOf(n.uuid)[0];
      const m = onlineByNode.get(n.uuid);
      if (id) nodeServers.add(id);
      if (id && m) add(id, m);
    }
    const bridges = new Set<string>();
    for (const r of rows) {
      const up = r.upstream;
      if (up?.kind === 'bridge' && up.serverId && serverOnline.has(r.id)) {
        bridges.add(up.serverId);
        add(up.serverId, serverOnline.get(r.id) as Map<number, number>);
      }
    }

    const G = {
      cpu: grid(cpu, 'server_id'),
      mem: grid(mem, 'server_id'),
      rx: grid(rx, 'server_id'),
      tx: grid(tx, 'server_id'),
      conn: grid(conn, 'server_id'),
    };
    const col = (m: Map<number, number> | undefined) => t.map((x) => m?.get(x) ?? null);

    const servers: CapacityServer[] = [];
    let fleetOnline: Array<number | null> = t.map(() => null);
    for (const r of rows) {
      const link = effectiveLink(links.get(r.id) ?? null);
      const role: CapacityServer['role'] =
        bridges.has(r.id) && !nodeServers.has(r.id) ? 'bridge' : nodeServers.has(r.id) ? 'exit' : 'other';
      const series: CapacitySeries = {
        t,
        online: col(serverOnline.get(r.id)),
        cpu: col(G.cpu.get(r.id)),
        mem: col(G.mem.get(r.id)),
        rx: col(G.rx.get(r.id)),
        tx: col(G.tx.get(r.id)),
        conn: col(G.conn.get(r.id)),
      };
      if (role === 'exit')
        fleetOnline = fleetOnline.map((v, i) =>
          series.online[i] == null ? v : (v ?? 0) + (series.online[i] as number),
        );
      const hasMetrics = series.cpu.some((v) => v != null);
      if (role === 'other' || !hasMetrics) {
        servers.push({
          serverId: r.id,
          name: r.name,
          country: r.country ?? null,
          role,
          status: role === 'other' ? 'no_online' : 'no_metrics',
          onlinePeak: null,
          peakAt: null,
          left: null,
          bottleneck: null,
          tone: 'mute',
          cells: Object.fromEntries(
            CAPACITY_RESOURCES.map((k) => [k, { usedPct: null, limitPct: 0, left: null, detail: null }]),
          ) as CapacityServer['cells'],
          link,
          note:
            role === 'other'
              ? rw?.connected
                ? 'Не нода Remnawave: адрес сервера не совпал ни с одной нодой — онлайна нет, ёмкость не считается.'
                : 'Remnawave не подключена — без онлайна нод ёмкость не посчитать.'
              : 'Нет метрик агента за 14 дней — установите агента.',
        });
        continue;
      }
      const c = computeCapacity(series, link, STEP);
      servers.push({
        serverId: r.id,
        name: r.name,
        country: r.country ?? null,
        role,
        status: c.status,
        onlinePeak: c.onlinePeak,
        peakAt: iso(c.peakAt),
        left: c.status === 'ok' ? c.left : null,
        bottleneck: c.bottleneck,
        tone: c.status === 'ok' ? toneOf(c.left, c.onlinePeak) : c.status === 'weak' ? 'warn' : 'mute',
        cells: c.cells,
        link,
        note: role === 'bridge' && c.note ? `Мост: онлайн — у выходов за ним. ${c.note}` : c.note,
      });
    }

    // Итог по парку.
    let peakIdx = -1;
    fleetOnline.forEach((v, i) => {
      if (v != null && (peakIdx < 0 || v > (fleetOnline[peakIdx] as number))) peakIdx = i;
    });
    const counted = servers.filter((s) => s.status === 'ok' && s.role === 'exit' && s.left != null);
    const counts = new Map<CapacityResource, number>();
    for (const s of counted) if (s.bottleneck) counts.set(s.bottleneck, (counts.get(s.bottleneck) ?? 0) + 1);
    let bottleneck: CapacityResource | null = null;
    for (const [k, v] of counts) if (!bottleneck || v > (counts.get(bottleneck) ?? 0)) bottleneck = k;
    const growth = weeklyGrowthPct(t, fleetOnline, end);
    let soonest: Capacity['soonest'] = null;
    for (const s of counted) {
      const d = daysUntilFull(s.left as number, s.onlinePeak as number, growth);
      if (d != null && (!soonest || d < soonest.days))
        soonest = { days: d, serverId: s.serverId, name: s.name };
    }
    // Сначала те, где запас кончается, потом остальные по запасу; не посчитанные — в конце.
    const order = (s: CapacityServer) =>
      s.left == null ? Number.POSITIVE_INFINITY : s.left / Math.max(1, s.onlinePeak ?? 1);
    servers.sort((a, b) => order(a) - order(b));
    return {
      computedAt: new Date().toISOString(),
      vmOk,
      remnawave: Boolean(rw?.connected),
      onlinePeak: peakIdx >= 0 ? Math.round(fleetOnline[peakIdx] as number) : null,
      peakAt: peakIdx >= 0 ? iso(t[peakIdx] as number) : null,
      left: counted.length ? counted.reduce((a, s) => a + (s.left as number), 0) : null,
      bottleneck,
      bottleneckCount: bottleneck ? (counts.get(bottleneck) ?? 0) : 0,
      counted: counted.length,
      growthPctWeek: growth,
      soonest,
      servers,
    };
  }

  /** Для Джарвиса: коротко по каждой ноде. */
  async forAssistant(): Promise<unknown> {
    const c = await this.get();
    return {
      computedAt: c.computedAt,
      fleet: {
        onlinePeak: c.onlinePeak,
        left: c.left,
        bottleneck: c.bottleneck,
        growthPctWeek: c.growthPctWeek,
        soonest: c.soonest,
      },
      servers: c.servers.map((s) => ({
        name: s.name,
        role: s.role,
        status: s.status,
        onlinePeak: s.onlinePeak,
        left: s.left,
        bottleneck: s.bottleneck,
        usedPct: Object.fromEntries(CAPACITY_RESOURCES.map((k) => [k, s.cells[k].usedPct])),
        link: {
          upMbit: s.link.upMbit,
          downMbit: s.link.downMbit,
          source: s.link.source,
          nicVirtual: s.link.nicVirtual,
        },
        note: s.note,
      })),
      rules:
        'Ёмкость — по пикам за 14 дней: нагрузка = фон + на одного человека × онлайн; потолки: процессор 80 %, память 85 %, канал 90 %, соединения 80 %. left — сколько ещё человек до потолка по самому тесному ресурсу. Канал: вручную → замер → сетевая карта (виртуальной не верим) → неизвестен.',
    };
  }
}

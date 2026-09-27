import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  BLOCK_VERDICT_LABELS,
  NODE_ONLINE_DROP_MIN_BASELINE,
  NODE_ONLINE_DROP_PCT,
  type RemnawaveNode,
} from '@nodeservice/shared';

import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';
import { IncidentsRepository } from './incidents.repository.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

const TICK_MS = 60_000;
/** Не открывать новый инцидент по той же ноде чаще, чем раз во столько минут (в основном страховка для
 * нод без своего сервера в панели — у сопоставленных дубль и так не даст завести база данных). */
const COOLDOWN_MIN = 30;

interface Sample {
  online: number;
  checkedAt: string;
}

/**
 * J10: аномалия онлайна ноды Remnawave (решения владельца 27.09.2026). Раз в минуту сравнивает
 * свежий снимок Remnawave с предыдущим по каждой ноде; сами данные обновляются реже (см.
 * REMNAWAVE_SYNC_INTERVAL_MIN), поэтому по факту сравнение идёт между двумя последними РАЗНЫМИ
 * снимками — этого достаточно для порога «за 5 минут». Найдено резкое падение — проверка блокировки
 * с российских серверов парка (NodeBlockCheckService), инцидент заводится только по результату.
 */
@Injectable()
export class NodeAnomalyJob {
  private readonly log = new Logger(NodeAnomalyJob.name);
  private readonly lastSample = new Map<string, Sample>();
  private readonly cooldownUntil = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly servers: ServersService,
    private readonly incidents: IncidentsRepository,
    private readonly blockCheck: NodeBlockCheckService,
  ) {}

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const status = await this.remnawave.status();
      if (!status.connected || !status.checkedAt) return;
      for (const node of status.nodes) await this.checkNode(node, status.checkedAt);
    } catch (err) {
      this.log.warn(`Тик аномалии онлайна: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  private async checkNode(node: RemnawaveNode, checkedAt: string): Promise<void> {
    const prev = this.lastSample.get(node.uuid);
    const online = node.usersOnline ?? 0;
    // Тот же снимок Remnawave (данные ещё не обновились) — сравнивать пока не с чем, ждём следующего.
    if (prev && prev.checkedAt === checkedAt) return;
    this.lastSample.set(node.uuid, { online, checkedAt });
    if (!prev || prev.online < NODE_ONLINE_DROP_MIN_BASELINE) return;
    const dropPct = ((prev.online - online) / prev.online) * 100;
    if (dropPct < NODE_ONLINE_DROP_PCT) return;
    const until = this.cooldownUntil.get(node.uuid) ?? 0;
    if (Date.now() < until) return;
    this.cooldownUntil.set(node.uuid, Date.now() + COOLDOWN_MIN * 60_000);
    await this.investigate(node, prev.online, online).catch((err) =>
      this.log.warn(`Проверка блокировки ноды «${node.name}»: ${err instanceof Error ? err.message : err}`),
    );
  }

  private async investigate(node: RemnawaveNode, before: number, after: number): Promise<void> {
    const allServers = await this.servers.list();
    const matched = allServers.find((s) => s.host === node.address) ?? null;
    const inbound = await this.remnawave.nodeInbound(node.uuid);
    const result = await this.blockCheck.check(
      node.name,
      node.address,
      inbound?.port ?? null,
      inbound?.sni ?? null,
      matched?.id ?? null,
      allServers,
    );
    const dropLine = `Онлайн ноды «${node.name}» упал с ${before} до ${after} (это ${Math.round(((before - after) / before) * 100)} %) за короткое время.`;
    let detail: string;
    if (result.probes.length === 0) {
      detail = inbound?.sni
        ? `${dropLine} Проверить не удалось: нет ни одного российского сервера парка с рабочим SSH для встречной проверки.`
        : `${dropLine} Проверить не удалось: не получилось определить имя маскировки (SNI) этой ноды в Remnawave.`;
    } else {
      const fromList = result.probes.map((p) => p.from).join(', ');
      const perProbe = result.probes.map((p) => `${p.from} — ${p.detail}`).join('; ');
      detail = `${dropLine} Проверено с серверов парка: ${fromList}. Вывод: ${BLOCK_VERDICT_LABELS[result.verdict]}. Подробности по каждому серверу: ${perProbe}.`;
    }
    const title = `${BLOCK_VERDICT_LABELS[result.verdict]} · ${node.name}`;
    await this.incidents.open({
      serverId: matched?.id ?? null,
      serverName: matched?.name ?? node.name,
      kind: 'node_blocked',
      severity: 'crit',
      title,
      detail,
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
  }
}

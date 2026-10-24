import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  maintenanceActive,
  NODE_MAINTENANCE_EXTEND_MINUTES,
  type NodeMaintenance,
  type NodeMaintenanceHostPreview,
  type NodeMaintenanceHosts,
  type NodeMaintenanceStart,
} from '@nodeservice/shared';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { NodeMaintenanceStore } from '../remnawave/node-maintenance.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ScenariosJob } from '../scenarios/scenarios.job.js';

export type MaintenanceEnd = { ended: NodeMaintenance; restored: string[]; failed: string[] };

const message = (e: unknown) => (e instanceof Error ? e.message : 'Remnawave не ответила');
/** Срок словами — для «Журнала»: «1 час», «до выключения». */
const termLabel = (minutes: NodeMaintenanceStart['minutes']) =>
  minutes === null ? 'до выключения' : minutes === 30 ? '30 мин' : minutes === 60 ? '1 час' : '3 часа';

/**
 * Обслуживание ноды (0.106.0): включить на срок или до выключения, продлить, закончить. Пока идёт — наблюдение,
 * сценарии, DNS, напоминания и проверки ноду пропускают (они читают NodeMaintenanceStore сами). Здесь — то, что
 * происходит в момент включения и окончания: закрыть открытые события, скрыть и вернуть Host, записать в «Журнал».
 */
@Injectable()
export class NodeMaintenanceService {
  private readonly log = new Logger(NodeMaintenanceService.name);
  private busy = false;
  constructor(
    private readonly store: NodeMaintenanceStore,
    private readonly remna: RemnawaveService,
    private readonly scenarios: ScenariosJob,
    private readonly incidents: IncidentsService,
    private readonly audit: AuditService,
  ) {}

  private async node(uuid: string) {
    const status = await this.remna.status();
    const node = status.nodes.find((n) => n.uuid === uuid);
    if (!status.domain || !node) throw new NotFoundException('Нода не найдена в Remnawave.');
    return { domain: status.domain, node };
  }

  /** Какие Host скроются, если включить обслуживание с «Скрыть Host». */
  async hostsPreview(uuid: string): Promise<NodeMaintenanceHostPreview> {
    await this.node(uuid);
    return this.scenarios.maintenancePreview(uuid);
  }

  /**
   * Включить. Если обслуживание уже идёт — меняются срок и причина; Host, уже скрытые этим обслуживанием, второй
   * раз не скрываются. Запись сохраняется до скрытия Host: наблюдение и сценарии замолкают сразу.
   */
  async start(uuid: string, input: NodeMaintenanceStart): Promise<NodeMaintenance> {
    const { domain, node } = await this.node(uuid);
    const now = Date.now();
    const running = await this.store.get(domain, uuid);
    const current = running && maintenanceActive(running, now) ? running : null;
    let m = await this.store.put(domain, {
      nodeUuid: uuid,
      nodeName: node.name,
      startedAt: current?.startedAt ?? new Date(now).toISOString(),
      until: input.minutes === null ? null : new Date(now + input.minutes * 60_000).toISOString(),
      reason: input.reason,
      hideHosts: input.hideHosts || Boolean(current?.hideHosts),
      hosts: current?.hosts ?? null,
    });
    const closed = await this.incidents.closeForMaintenance(uuid).catch((e) => {
      this.log.warn(`Обслуживание «${node.name}»: события не закрыты — ${message(e)}`);
      return 0;
    });
    if (input.hideHosts && !current?.hideHosts) {
      let hosts: NodeMaintenanceHosts;
      try {
        hosts = await this.scenarios.hideForMaintenance(node);
      } catch (e) {
        hosts = { hidden: [], shared: 0, error: `Host не отключены: ${message(e)}` };
      }
      m = await this.store.put(domain, { ...m, hosts });
    }
    this.audit.extend({
      target: { type: 'node', id: uuid, display: node.name },
      metadata: {
        term: termLabel(input.minutes),
        until: m.until,
        reason: m.reason || null,
        hideHosts: m.hideHosts,
        hiddenHosts: m.hosts?.hidden ?? [],
        hostsError: m.hosts?.error ?? null,
        closedEvents: closed,
      },
    });
    return m;
  }

  /** «+1 час»: от срока, а если он уже прошёл — от сейчас. Без срока — так и остаётся без срока. */
  async extend(uuid: string): Promise<NodeMaintenance> {
    const { domain, node } = await this.node(uuid);
    const running = await this.store.get(domain, uuid);
    if (!running || !maintenanceActive(running))
      throw new NotFoundException('Обслуживание этой ноды не идёт.');
    const until =
      running.until === null
        ? null
        : new Date(
            Math.max(Date.parse(running.until), Date.now()) + NODE_MAINTENANCE_EXTEND_MINUTES * 60_000,
          ).toISOString();
    const m = await this.store.put(domain, { ...running, until });
    this.audit.extend({
      target: { type: 'node', id: uuid, display: node.name },
      metadata: { from: running.until, until },
    });
    return m;
  }

  /** Закончить кнопкой. */
  async end(uuid: string): Promise<MaintenanceEnd> {
    const status = await this.remna.status();
    const result = await this.finish(status.domain, uuid);
    if (!result) throw new NotFoundException('Обслуживание этой ноды не идёт.');
    this.audit.extend({
      target: { type: 'node', id: uuid, display: result.ended.nodeName },
      metadata: { restoredHosts: result.restored, hostsFailed: result.failed },
    });
    return result;
  }

  /**
   * Убрать запись (наблюдение начинается заново) и вернуть Host, которые скрыло обслуживание. Возврат не ждёт, пока
   * нода поднимется: владелец сам сказал, что работы закончены, а если нода лежит — придёт обычная тревога.
   */
  private async finish(domain: string | null, uuid: string): Promise<MaintenanceEnd | null> {
    if (!domain) return null;
    const ended = await this.store.remove(domain, uuid);
    if (!ended) return null;
    let restored: string[] = [],
      failed: string[] = [];
    if (ended.hideHosts)
      try {
        ({ restored, failed } = await this.scenarios.restoreAfterMaintenance(uuid));
      } catch (e) {
        failed = [`Host не возвращены: ${message(e)}. Верните их в Remnawave сами`];
      }
    return { ended, restored, failed };
  }

  // Срок проверяется раз в 15 секунд: окончание видно в панели почти сразу.
  @Interval(15_000)
  async tick() {
    if (process.env.NODE_ENV !== 'test') await this.expire();
  }

  /** Срок вышел — закончить от имени панели; нода пропала из Remnawave — просто убрать запись. */
  async expire(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const status = await this.remna.status();
      if (!status.domain || status.error) return;
      for (const [uuid, m] of await this.store.all(status.domain)) {
        const gone = !status.nodes.some((n) => n.uuid === uuid);
        if (!gone && maintenanceActive(m, now)) continue;
        if (gone) {
          await this.store.remove(status.domain, uuid);
          continue;
        }
        const result = await this.finish(status.domain, uuid);
        if (!result) continue;
        await this.audit.record({
          action: 'incident.node_maintenance.expired',
          actor: SYSTEM_ACTOR,
          source: 'auto',
          target: { type: 'node', id: uuid, display: m.nodeName },
          metadata: {
            until: m.until,
            reason: m.reason || null,
            restoredHosts: result.restored,
            hostsFailed: result.failed,
          },
        });
      }
    } catch (e) {
      this.log.warn(`Окончание обслуживания: ${message(e)}`);
    } finally {
      this.busy = false;
    }
  }
}

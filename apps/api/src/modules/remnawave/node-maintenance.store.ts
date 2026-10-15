import { Inject, Injectable, Logger } from '@nestjs/common';
import { maintenanceActive, type NodeMaintenance, nodeMaintenanceSchema } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const prefix = 'nodes.maintenance.';

/**
 * Обслуживание нод (0.106.0): одна запись на подключение Remnawave — нода → срок, причина, скрытые Host. Читают
 * её все, кто реагирует на сбой ноды: наблюдение, сценарии, DNS, напоминания, метрики. Повреждённая запись одной
 * ноды не ломает остальные.
 */
@Injectable()
export class NodeMaintenanceStore {
  private readonly log = new Logger(NodeMaintenanceStore.name);
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Все записи подключения, включая истёкшие (их убирает задача окончания). */
  async all(domain: string | null): Promise<Map<string, NodeMaintenance>> {
    const out = new Map<string, NodeMaintenance>();
    if (!domain) return out;
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, prefix + domain) });
    if (!row) return out;
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      this.log.warn('Записи обслуживания нод повреждены: считаем, что обслуживания нет.');
      return out;
    }
    for (const value of Object.values(raw && typeof raw === 'object' ? raw : {})) {
      const parsed = nodeMaintenanceSchema.safeParse(value);
      if (parsed.success) out.set(parsed.data.nodeUuid, parsed.data);
    }
    return out;
  }

  /** Идущие сейчас: срок ещё не вышел или его нет. */
  async active(domain: string | null, now = Date.now()): Promise<Map<string, NodeMaintenance>> {
    const all = await this.all(domain);
    for (const [uuid, m] of all) if (!maintenanceActive(m, now)) all.delete(uuid);
    return all;
  }

  async get(domain: string | null, uuid: string): Promise<NodeMaintenance | null> {
    return (await this.all(domain)).get(uuid) ?? null;
  }

  async put(domain: string, value: NodeMaintenance): Promise<NodeMaintenance> {
    const parsed = nodeMaintenanceSchema.parse(value);
    const all = await this.all(domain);
    all.set(parsed.nodeUuid, parsed);
    await this.save(domain, all);
    return parsed;
  }

  async remove(domain: string, uuid: string): Promise<NodeMaintenance | null> {
    const all = await this.all(domain);
    const old = all.get(uuid) ?? null;
    if (!old) return null;
    all.delete(uuid);
    await this.save(domain, all);
    return old;
  }

  private async save(domain: string, all: Map<string, NodeMaintenance>) {
    const value = JSON.stringify(Object.fromEntries(all));
    await this.db
      .insert(appMeta)
      .values({ key: prefix + domain, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
  }
}

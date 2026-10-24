import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type NodePreferences, nodePreferencesSchema } from '@nodeservice/shared';
import { eq, like } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

const prefix = 'settings.node-view.';
@Injectable()
export class NodePreferencesStore {
  private readonly log = new Logger(NodePreferencesStore.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly remnawave: RemnawaveSettingsStore,
  ) {}
  private async key(uuid: string) {
    const domain = await this.remnawave.domain();
    const snapshot = await this.remnawave.snapshot();
    if (!domain || !snapshot?.nodes.some((node) => node.uuid === uuid))
      throw new NotFoundException('Нода не найдена.');
    return `${prefix}${domain}:${uuid}`;
  }
  async get(uuid: string): Promise<NodePreferences> {
    const key = await this.key(uuid);
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    return nodePreferencesSchema.parse(row ? JSON.parse(row.value) : {});
  }
  /** Monitoring already owns a validated source snapshot; do not require a second snapshot lookup. */
  async forMonitoring(domain: string | null, uuid: string): Promise<NodePreferences> {
    if (!domain) return nodePreferencesSchema.parse({});
    const row = await this.db.query.appMeta.findFirst({
      where: eq(appMeta.key, `${prefix}${domain}:${uuid}`),
    });
    try {
      return nodePreferencesSchema.parse(row ? JSON.parse(row.value) : {});
    } catch {
      this.log.warn('Повреждённые пороги ноды: используются общие настройки мониторинга.');
      return nodePreferencesSchema.parse({});
    }
  }
  /** Настройки всех нод текущего подключения одним запросом: нода → разобранная запись (повреждённые пропущены). */
  private async all(domain: string | null): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (!domain) return out;
    const head = `${prefix}${domain}:`;
    // В LIKE знаки % и _ — подстановочные: в адресе панели их экранируем, чтобы не задеть чужие ключи.
    const pattern = `${head.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db
      .select({ key: appMeta.key, value: appMeta.value })
      .from(appMeta)
      .where(like(appMeta.key, pattern));
    for (const row of rows) {
      try {
        out.set(row.key.slice(head.length), JSON.parse(row.value) ?? {});
      } catch {
        // Повреждённая запись настроек ноды не должна прятать остальные.
      }
    }
    return out;
  }
  /** Ноды с отметкой «Сервер белого списка» для текущего подключения — одним запросом, для списка нод и Ассистента. */
  async whitelisted(domain: string | null): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [uuid, value] of await this.all(domain)) if (value.whitelist === true) out.add(uuid);
    return out;
  }
  /** Ноды с заданным «Лимитом канала» — для «Следить за каналом» в «Мониторинге нод». */
  async channelLimits(domain: string | null): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [uuid, value] of await this.all(domain))
      if (typeof value.channelMbps === 'number' && value.channelMbps > 0) out.add(uuid);
    return out;
  }
  async set(uuid: string, value: NodePreferences) {
    const key = await this.key(uuid);
    const parsed = nodePreferencesSchema.parse(value);
    await this.db
      .insert(appMeta)
      .values({ key, value: JSON.stringify(parsed) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(parsed), updatedAt: new Date() },
      });
    return parsed;
  }
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type NodePreferences, nodePreferencesSchema } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

const prefix = 'settings.node-view.';
@Injectable()
export class NodePreferencesStore {
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

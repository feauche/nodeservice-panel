import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type NodeLayout, nodeLayoutSchema } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
@Injectable()
export class NodeLayoutStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly remna: RemnawaveSettingsStore,
  ) {}
  private async key() {
    const domain = await this.remna.domain();
    if (!domain) throw new BadRequestException('Подключите Remnawave.');
    return `settings.node-layout.${domain}`;
  }
  async get(): Promise<NodeLayout> {
    const key = await this.key();
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    return nodeLayoutSchema.parse(row ? JSON.parse(row.value) : {});
  }
  async set(value: NodeLayout) {
    const key = await this.key();
    const parsed = nodeLayoutSchema.parse(value);
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

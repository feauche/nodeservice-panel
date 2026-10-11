import { createHash } from 'node:crypto';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { IconFetchService } from '../providers/icon-fetch.service.js';
import { SettingsService } from './settings.service.js';

type Cached = { type: string | null; data: string | null; at: number };
@Controller('settings/custom-sites')
export class SiteIconsController {
  private pending = new Map<string, Promise<Cached>>();
  constructor(
    private readonly settings: SettingsService,
    private readonly icons: IconFetchService,
    @Inject(DB) private readonly db: Db,
  ) {}
  private async load(url: string): Promise<Cached> {
    const key = `assets.site-icon.${createHash('sha256').update(url).digest('hex')}`;
    const cached = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    if (cached) {
      const c = JSON.parse(cached.value) as Cached;
      if (Date.now() - c.at < 86400000) return c;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = (async () => {
      const result = await this.icons.fetch(url);
      const value = {
        type: result.icon?.type ?? null,
        data: result.icon?.data.toString('base64') ?? null,
        at: Date.now(),
      };
      await this.db
        .insert(appMeta)
        .values({ key, value: JSON.stringify(value) })
        .onConflictDoUpdate({
          target: appMeta.key,
          set: { value: JSON.stringify(value), updatedAt: new Date() },
        });
      return value;
    })();
    this.pending.set(key, job);
    try {
      return await job;
    } finally {
      this.pending.delete(key);
    }
  }
  @Get(':id/icon') async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('v') version: string | undefined,
    @Res() res: Response,
  ) {
    const site = (await this.settings.getCustomSites()).items.find((s) => s.id === id);
    if (!site || (version !== undefined && version !== site.url)) {
      res.setHeader('cache-control', 'no-store');
      res.status(404).end();
      return;
    }
    const icon = await this.load(site.url);
    if (!icon.data || !icon.type) {
      res.status(404).end();
      return;
    }
    res.setHeader('content-type', icon.type);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('cache-control', 'private, max-age=86400');
    res.send(Buffer.from(icon.data, 'base64'));
  }
}

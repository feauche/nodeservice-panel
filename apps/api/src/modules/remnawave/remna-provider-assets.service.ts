import { Inject, Injectable } from '@nestjs/common';
import { type Provider, providerSiteHost, type RemnaProvider } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { IconFetchService } from '../providers/icon-fetch.service.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

type Asset = {
  source: string;
  note: string | null;
  iconUrl: string | null;
  type: string | null;
  data: string | null;
  sourceUrl: string | null;
  version: number;
  checked: boolean;
  createdAt: string;
  updatedAt: string;
};
@Injectable()
export class RemnaProviderAssetsService {
  private jobs = new Map<string, Promise<void>>();
  private locks = new Map<string, Promise<unknown>>();
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RemnawaveSettingsStore,
    private readonly icons: IconFetchService,
  ) {}
  private async key(uuid: string, domain?: string) {
    return `assets.remna-provider.${domain ?? (await this.store.domain())}:${uuid}`;
  }
  private async read(key: string): Promise<Asset | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    return row ? (JSON.parse(row.value) as Asset) : null;
  }
  private async mutate(key: string, fn: (value: Asset | null) => Asset) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const value = fn(await this.read(key));
        await this.db
          .insert(appMeta)
          .values({ key, value: JSON.stringify(value) })
          .onConflictDoUpdate({
            target: appMeta.key,
            set: { value: JSON.stringify(value), updatedAt: new Date() },
          });
        return value;
      });
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  private fresh(p: RemnaProvider): Asset {
    const now = new Date().toISOString();
    return {
      source: `${p.loginUrl}|${p.faviconLink}`,
      note: null,
      iconUrl: null,
      type: null,
      data: null,
      sourceUrl: null,
      version: 0,
      checked: false,
      createdAt: now,
      updatedAt: now,
    };
  }
  async ensure(p: RemnaProvider, start = true, domain?: string) {
    const key = await this.key(p.uuid, domain),
      source = `${p.loginUrl}|${p.faviconLink}`;
    let asset = await this.read(key);
    if (!asset || asset.source !== source)
      asset = await this.mutate(key, (old) => ({
        ...(old ?? this.fresh(p)),
        source,
        checked: false,
        data: null,
        type: null,
        sourceUrl: null,
        version: (old?.version ?? 0) + 1,
      }));
    if (start && !asset.checked) void this.search(p, key, asset).catch(() => undefined);
    return asset;
  }
  private async search(p: RemnaProvider, key: string, asset: Asset) {
    const jobKey = `${key}:${asset.source}:${asset.iconUrl}`;
    if (this.jobs.has(jobKey)) return this.jobs.get(jobKey);
    const job = (async () => {
      if (this.active >= 4) await new Promise<void>((resolve) => this.queue.push(resolve));
      this.active++;
      try {
        const source = asset.iconUrl || p.faviconLink || p.loginUrl;
        let found: Awaited<ReturnType<IconFetchService['fetch']>> = { icon: null, reason: null };
        if (source)
          found =
            asset.iconUrl || /\.(svg|ico|png|webp)(?:[?#]|$)/i.test(source)
              ? await this.icons.fetchDirect(source)
              : await this.icons.fetch(source);
        await this.mutate(key, (current) => {
          const latest = current ?? asset;
          if (latest.source !== asset.source || latest.iconUrl !== asset.iconUrl) return latest;
          return {
            ...latest,
            checked: true,
            data: found.icon?.data.toString('base64') ?? null,
            type: found.icon?.type ?? null,
            sourceUrl: found.icon?.sourceUrl ?? null,
            version: latest.version + 1,
            updatedAt: new Date().toISOString(),
          };
        });
      } catch {
        await this.mutate(key, (current) => {
          const latest = current ?? asset;
          return latest.source === asset.source && latest.iconUrl === asset.iconUrl
            ? { ...latest, checked: true }
            : latest;
        });
      } finally {
        this.active--;
        this.queue.shift()?.();
      }
    })();
    this.jobs.set(jobKey, job);
    try {
      await job;
    } finally {
      this.jobs.delete(jobKey);
    }
  }
  async dto(p: RemnaProvider, domain?: string): Promise<Provider> {
    return this.format(p, await this.ensure(p, true, domain));
  }
  private format(p: RemnaProvider, a: Asset): Provider {
    return {
      id: p.uuid,
      name: p.name,
      siteUrl: p.loginUrl ?? '',
      siteHost: providerSiteHost(p.loginUrl ?? ''),
      hasIcon: Boolean(a.data),
      iconUrl: a.iconUrl,
      iconSourceUrl: a.sourceUrl,
      iconPending: !a.checked,
      iconVersion: a.version,
      note: a.note,
      serversCount: p.nodes.length,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
  async update(p: RemnaProvider, patch: { note?: string | null; iconUrl?: string | null }, domain?: string) {
    const key = await this.key(p.uuid, domain);
    await this.ensure(p, false, domain);
    await this.mutate(key, (old) => ({
      ...(old ?? this.fresh(p)),
      ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
      ...(patch.iconUrl !== undefined
        ? {
            iconUrl: patch.iconUrl,
            checked: false,
            data: null,
            type: null,
            sourceUrl: null,
            version: (old?.version ?? 0) + 1,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    }));
    return this.dto(p, domain);
  }
  async refresh(p: RemnaProvider, domain?: string) {
    const a = await this.ensure(p, false, domain);
    const key = await this.key(p.uuid, domain);
    await this.search(p, key, a);
    return this.format(p, (await this.read(key)) ?? a);
  }
  async icon(uuid: string, domain?: string) {
    const a = await this.read(await this.key(uuid, domain));
    return a?.data && a.type
      ? { type: a.type, data: Buffer.from(a.data, 'base64'), version: a.version }
      : null;
  }
}

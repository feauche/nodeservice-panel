import { Inject, Injectable } from '@nestjs/common';
import type {
  RemnawaveCert,
  RemnawaveNode,
  RemnawaveStats,
  RemnawaveVpnProbeStatus,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'settings.remnawave';

interface Snapshot {
  /** Последнее успешное чтение. Старые сохранённые снимки уже используют это поле. */
  checkedAt: string;
  lastAttemptAt?: string;
  failureSince?: string | null;
  outageNotified?: boolean;
  error: string | null;
  stats: RemnawaveStats | null;
  nodes: RemnawaveNode[];
  cert: RemnawaveCert | null;
}

interface Stored {
  domain: string;
  apiKeyEnc: string;
  snapshot: Snapshot | null;
  vpnProbeUrlEnc?: string;
  vpnProbeRoutes?: number;
  vpnProbeRouteDetails?: RemnawaveVpnProbeStatus['routeDetails'];
}

/** Домен и токен Remnawave хранятся шифрованными (как ключ Джарвиса), в app_meta. */
@Injectable()
export class RemnawaveSettingsStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  private async load(): Promise<Stored | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return null;
    try {
      const p = JSON.parse(row.value) as Partial<Stored>;
      if (!p.domain || !p.apiKeyEnc) return null;
      return {
        domain: p.domain,
        apiKeyEnc: p.apiKeyEnc,
        snapshot: p.snapshot ?? null,
        ...(p.vpnProbeUrlEnc ? { vpnProbeUrlEnc: p.vpnProbeUrlEnc } : {}),
        ...(typeof p.vpnProbeRoutes === 'number' ? { vpnProbeRoutes: p.vpnProbeRoutes } : {}),
        ...(Array.isArray(p.vpnProbeRouteDetails) ? { vpnProbeRouteDetails: p.vpnProbeRouteDetails } : {}),
      };
    } catch {
      return null;
    }
  }

  private async save(value: Stored | null): Promise<void> {
    if (!value) {
      await this.db.delete(appMeta).where(eq(appMeta.key, KEY));
      return;
    }
    const serialized = JSON.stringify(value);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
  }

  /** Домен и расшифрованный токен для запроса; null — не подключено. */
  async credentials(): Promise<{ domain: string; apiKey: string } | null> {
    const s = await this.load();
    if (!s) return null;
    try {
      return { domain: s.domain, apiKey: this.crypto.decrypt(s.apiKeyEnc) };
    } catch {
      return null;
    }
  }

  async domain(): Promise<string | null> {
    return (await this.load())?.domain ?? null;
  }

  async snapshot(): Promise<Snapshot | null> {
    return (await this.load())?.snapshot ?? null;
  }

  async connect(domain: string, apiKey: string, snapshot: Snapshot): Promise<void> {
    const before = await this.load();
    await this.save({
      domain,
      apiKeyEnc: this.crypto.encrypt(apiKey),
      snapshot,
      ...(before?.vpnProbeUrlEnc ? { vpnProbeUrlEnc: before.vpnProbeUrlEnc } : {}),
      ...(typeof before?.vpnProbeRoutes === 'number' ? { vpnProbeRoutes: before.vpnProbeRoutes } : {}),
      ...(before?.vpnProbeRouteDetails ? { vpnProbeRouteDetails: before.vpnProbeRouteDetails } : {}),
    });
  }

  async updateSnapshot(snapshot: Snapshot): Promise<void> {
    const s = await this.load();
    if (!s) return;
    await this.save({ ...s, snapshot });
  }

  async disconnect(): Promise<void> {
    await this.save(null);
  }

  async vpnProbe(): Promise<{
    url: string;
    routes: number;
    routeDetails: RemnawaveVpnProbeStatus['routeDetails'];
  } | null> {
    const s = await this.load();
    if (!s?.vpnProbeUrlEnc) return null;
    try {
      return {
        url: this.crypto.decrypt(s.vpnProbeUrlEnc),
        routes: s.vpnProbeRoutes ?? 0,
        routeDetails: s.vpnProbeRouteDetails ?? [],
      };
    } catch {
      return null;
    }
  }

  async setVpnProbe(url: string, routeDetails: RemnawaveVpnProbeStatus['routeDetails']): Promise<void> {
    const s = await this.load();
    if (!s) throw new Error('Remnawave не подключена.');
    await this.save({
      ...s,
      vpnProbeUrlEnc: this.crypto.encrypt(url),
      vpnProbeRoutes: routeDetails.length,
      vpnProbeRouteDetails: routeDetails,
    });
  }

  async updateVpnProbeDetails(routeDetails: RemnawaveVpnProbeStatus['routeDetails']): Promise<void> {
    const s = await this.load();
    if (!s?.vpnProbeUrlEnc) return;
    await this.save({ ...s, vpnProbeRoutes: routeDetails.length, vpnProbeRouteDetails: routeDetails });
  }

  async clearVpnProbe(): Promise<void> {
    const s = await this.load();
    if (!s) return;
    const { vpnProbeUrlEnc: _url, vpnProbeRoutes: _routes, vpnProbeRouteDetails: _routeDetails, ...rest } = s;
    await this.save(rest);
  }
}

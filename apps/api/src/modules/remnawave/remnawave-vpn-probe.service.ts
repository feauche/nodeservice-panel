import { HttpStatus, Injectable } from '@nestjs/common';
import type { RemnawaveVpnProbeStatus } from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { AuditService } from '../audit/audit.service.js';
import { resolvesToPublic } from '../providers/icon-fetch.service.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

const MAX_SUBSCRIPTION_BYTES = 1024 * 1024;
const CACHE_MS = 5 * 60_000;

interface Route {
  link: string;
  address: string;
  name: string;
}

function decodeBase64(raw: string): string | null {
  const compact = raw.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact) || compact.length < 16) return null;
  try {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return decoded.includes('vless://') ? decoded : null;
  } catch {
    return null;
  }
}

export function parseRealityRoutes(raw: string): Route[] {
  const text = raw.includes('vless://') ? raw : (decodeBase64(raw) ?? raw);
  const links = text.match(/vless:\/\/[^\s"'<>]+/gi) ?? [];
  const routes: Route[] = [];
  for (const link of links.slice(0, 500)) {
    try {
      const url = new URL(link);
      if (url.protocol !== 'vless:' || url.searchParams.get('security') !== 'reality') continue;
      const address = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (!address || !url.port || !url.username || !url.searchParams.get('pbk')) continue;
      let name = '';
      try {
        name = decodeURIComponent(url.hash.slice(1)).trim();
      } catch {
        name = url.hash.slice(1).trim();
      }
      routes.push({ link, address, name });
    } catch {
      // One broken link must not hide the valid routes in the same subscription.
    }
  }
  return routes;
}

async function bodyLimited(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_SUBSCRIPTION_BYTES) throw new Error('подписка больше 1 МБ');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SUBSCRIPTION_BYTES) {
      await reader.cancel();
      throw new Error('подписка больше 1 МБ');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

@Injectable()
export class RemnawaveVpnProbeService {
  private cache: { url: string; routes: Route[]; until: number } | null = null;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<RemnawaveVpnProbeStatus> {
    const saved = await this.store.vpnProbe();
    return { configured: Boolean(saved), routes: saved?.routes ?? null };
  }

  private async fetchRoutes(url: string): Promise<Route[]> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('нужна обычная HTTPS-ссылка без логина в адресе');
    if (!(await resolvesToPublic(parsed.hostname)))
      throw new Error('адрес подписки ведёт во внутреннюю сеть или не разрешается через DNS');
    const response = await fetch(parsed, {
      headers: { accept: 'text/plain, application/octet-stream', 'user-agent': 'NodeService/0.59' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`сервер подписки ответил HTTP ${response.status}`);
    const routes = parseRealityRoutes(await bodyLimited(response));
    if (routes.length === 0) throw new Error('в подписке не найдено ни одного VLESS/REALITY-маршрута');
    return routes;
  }

  async configure(url: string): Promise<RemnawaveVpnProbeStatus> {
    try {
      const routes = await this.fetchRoutes(url);
      await this.store.setVpnProbe(url, routes.length);
      this.cache = { url, routes, until: Date.now() + CACHE_MS };
      await this.audit.record({
        action: 'remnawave.vpn_probe.updated',
        target: { type: 'settings', id: 'remnawave-vpn-probe', display: 'Настоящая проверка VPN' },
        metadata: { routes: routes.length },
      });
      return { configured: true, routes: routes.length };
    } catch (error) {
      throw problem(HttpStatus.BAD_REQUEST, {
        type: 'urn:nodeservice:problem:vpn-probe-subscription',
        detail: `Сервисная подписка не сохранена: ${error instanceof Error ? error.message : String(error)}.`,
      });
    }
  }

  async clear(): Promise<void> {
    this.cache = null;
    await this.store.clearVpnProbe();
    await this.audit.record({
      action: 'remnawave.vpn_probe.removed',
      target: { type: 'settings', id: 'remnawave-vpn-probe', display: 'Настоящая проверка VPN' },
    });
  }

  private async routes(): Promise<Route[] | null> {
    const saved = await this.store.vpnProbe();
    if (!saved) return null;
    if (this.cache && this.cache.url === saved.url && this.cache.until > Date.now()) return this.cache.routes;
    const routes = await this.fetchRoutes(saved.url);
    this.cache = { url: saved.url, routes, until: Date.now() + CACHE_MS };
    return routes;
  }

  async routeFor(nodeName: string, address: string): Promise<string | null> {
    const routes = await this.routes();
    if (!routes) return null;
    const host = address.toLowerCase().replace(/^\[|\]$/g, '');
    const byAddress = routes.filter((route) => route.address === host);
    if (byAddress.length === 1) return byAddress[0]?.link ?? null;
    const name = nodeName.trim().toLocaleLowerCase('ru');
    const exact = routes.find((route) => route.name.toLocaleLowerCase('ru') === name);
    if (exact) return exact.link;
    const namedAddress = byAddress.find((route) => route.name.toLocaleLowerCase('ru').includes(name));
    return namedAddress?.link ?? null;
  }
}

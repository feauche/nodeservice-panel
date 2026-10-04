import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  port: number;
  name: string;
  protocol: 'vless-reality' | 'hysteria2';
  resolvedAddresses: string[];
}

type RouteDetail = RemnawaveVpnProbeStatus['routeDetails'][number];

const SUPPORTED_LINK = /(?:vless|hysteria2|hy2):\/\//i;

function decodeBase64(raw: string): string | null {
  const compact = raw.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact) || compact.length < 16) return null;
  try {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return SUPPORTED_LINK.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function parseRealityRoutes(raw: string): Route[] {
  const text = SUPPORTED_LINK.test(raw) ? raw : (decodeBase64(raw) ?? raw);
  const links = text.match(/(?:vless|hysteria2|hy2):\/\/[^\s"'<>]+/gi) ?? [];
  const routes: Route[] = [];
  for (const link of links.slice(0, 500)) {
    try {
      const url = new URL(link);
      const vless = url.protocol === 'vless:';
      const hysteria2 = url.protocol === 'hysteria2:' || url.protocol === 'hy2:';
      if (!vless && !hysteria2) continue;
      if (vless && url.searchParams.get('security') !== 'reality') continue;
      const address = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (!address || !url.port || !url.username) continue;
      if (vless && !url.searchParams.get('pbk')) continue;
      let name = '';
      try {
        name = decodeURIComponent(url.hash.slice(1)).trim();
      } catch {
        name = url.hash.slice(1).trim();
      }
      routes.push({
        link,
        address,
        port: Number(url.port),
        name,
        protocol: hysteria2 ? 'hysteria2' : 'vless-reality',
        resolvedAddresses: isIP(address) ? [address] : [],
      });
    } catch {
      // One broken link must not hide the valid routes in the same subscription.
    }
  }
  return routes;
}

function detail(route: Route): RouteDetail {
  return {
    name: route.name || `${route.address}:${route.port}`,
    address: route.address,
    port: route.port,
    protocol: route.protocol,
  };
}

/** Имя ноды и подпись маршрута часто отличаются флагом или припиской «VLESS TCP REALITY». */
export function normalizeRouteName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/\b(?:vless|reality|xtls|vision|tcp|grpc|xhttp|hysteria2|hysteria|hy2|vpn|tls)\b/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function resolved(address: string): Promise<string[]> {
  if (isIP(address)) return [address];
  try {
    return [...new Set((await lookup(address, { all: true })).map((item) => item.address.toLowerCase()))];
  } catch {
    return [];
  }
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
    if (!saved) return { configured: false, routes: null, routeDetails: [] };
    let routeDetails = saved.routeDetails;
    // До версии со списком в базе лежало только число. После обновления заполняем список сами,
    // чтобы владельцу не пришлось снова вставлять секретную ссылку.
    if (routeDetails.length !== saved.routes) {
      try {
        const current = await this.routes();
        if (current) {
          routeDetails = current.map(detail);
          await this.store.updateVpnProbeDetails(routeDetails);
        }
      } catch {
        // Сбой подписки не должен ломать весь статус Remnawave: оставляем известное число.
      }
    }
    return { configured: true, routes: saved.routes, routeDetails };
  }

  private async fetchRoutes(url: string): Promise<Route[]> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('нужна обычная HTTPS-ссылка без логина в адресе');
    if (!(await resolvesToPublic(parsed.hostname)))
      throw new Error('адрес подписки ведёт во внутреннюю сеть или не разрешается через DNS');
    const response = await fetch(parsed, {
      headers: { accept: 'text/plain, application/octet-stream', 'user-agent': 'NodeService/0.60.1' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`сервер подписки ответил HTTP ${response.status}`);
    const routes = parseRealityRoutes(await bodyLimited(response));
    if (routes.length === 0)
      throw new Error('в подписке не найдено ни одного маршрута VLESS/REALITY или Hysteria2');
    await Promise.all(
      routes.map(async (route) => {
        route.resolvedAddresses = await resolved(route.address);
      }),
    );
    return routes;
  }

  async configure(url: string): Promise<RemnawaveVpnProbeStatus> {
    try {
      const routes = await this.fetchRoutes(url);
      const routeDetails = routes.map(detail);
      await this.store.setVpnProbe(url, routeDetails);
      this.cache = { url, routes, until: Date.now() + CACHE_MS };
      await this.audit.record({
        action: 'remnawave.vpn_probe.updated',
        target: { type: 'settings', id: 'remnawave-vpn-probe', display: 'Настоящая проверка VPN' },
        metadata: { routes: routes.length },
      });
      return { configured: true, routes: routes.length, routeDetails };
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

  async routeFor(
    nodeName: string,
    address: string,
    preferredProtocol?: Route['protocol'],
    preferredPort?: number | null,
  ): Promise<string | null> {
    const routes = await this.routes();
    if (!routes) return null;
    const host = address.toLowerCase().replace(/^\[|\]$/g, '');
    const candidates = preferredProtocol
      ? routes.filter((route) => route.protocol === preferredProtocol)
      : routes;
    const pool = candidates.length > 0 ? candidates : routes;
    const targetAddresses = new Set([host, ...(await resolved(host))]);
    const byAddress = pool.filter(
      (route) =>
        targetAddresses.has(route.address) ||
        route.resolvedAddresses.some((item) => targetAddresses.has(item)),
    );
    const byEndpoint = preferredPort ? byAddress.filter((route) => route.port === preferredPort) : byAddress;
    if (byEndpoint.length === 1) return byEndpoint[0]?.link ?? null;
    if (byAddress.length === 1) return byAddress[0]?.link ?? null;

    const name = normalizeRouteName(nodeName);
    const named = pool.filter((route) => {
      const routeName = normalizeRouteName(route.name);
      if (!name || !routeName) return false;
      const paddedName = ` ${name} `;
      const paddedRouteName = ` ${routeName} `;
      return (
        routeName === name || paddedRouteName.includes(paddedName) || paddedName.includes(paddedRouteName)
      );
    });
    const namedEndpoint = preferredPort ? named.filter((route) => route.port === preferredPort) : named;
    if (namedEndpoint.length === 1) return namedEndpoint[0]?.link ?? null;
    if (named.length === 1) return named[0]?.link ?? null;
    return null;
  }
}

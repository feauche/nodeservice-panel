import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';

import { normalizeAddress } from '../../common/net/address.js';

/** Во что разрешается домен. Отдельной зависимостью — чтобы тесты не ходили в настоящий DNS. */
export const HOST_RESOLVER = Symbol('HOST_RESOLVER');
export interface HostResolver {
  /** IP-адреса домена; пусто — не разрешился. */
  resolve(host: string): Promise<string[]>;
}

const LOOKUP_TIMEOUT_MS = 2_000;

@Injectable()
export class DnsHostResolver implements HostResolver {
  async resolve(host: string): Promise<string[]> {
    // В тестах наружу не ходим: те, кому нужен DNS, подставляют свой ответ.
    if (process.env.NODE_ENV === 'test') return [];
    let timer: NodeJS.Timeout | undefined;
    try {
      const found = await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('таймаут')), LOOKUP_TIMEOUT_MS);
        }),
      ]);
      return found.map((a) => normalizeAddress(a.address));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Сколько помнить ответ DNS: удачный и неудачный. Неудачный — недолго: домен мог ещё не обновиться. */
const FRESH_MS = 10 * 60_000;
const FAILED_MS = 60_000;
const CACHE_MAX = 500;

/** Адреса хостов и нод для карты Remnawave: DNS с кешем и защитой от краткого сбоя. */
@Injectable()
export class HostAddressesService {
  private readonly cache = new Map<string, { at: number; ips: string[] }>();

  constructor(@Inject(HOST_RESOLVER) private readonly resolver: HostResolver) {}

  private async ipsOf(host: string): Promise<string[]> {
    const hit = this.cache.get(host);
    if (hit && Date.now() - hit.at < (hit.ips.length > 0 ? FRESH_MS : FAILED_MS)) return hit.ips;
    const ips = await this.resolver.resolve(host).catch(() => []);
    // DNS не ответил, а раньше отвечал — держимся за прежний ответ: карта не должна рваться от сбоя DNS.
    const kept = ips.length === 0 && hit && hit.ips.length > 0 ? hit.ips : ips;
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(host, { at: Date.now(), ips: kept });
    return kept;
  }

  /** IP-литералы в DNS не отправляются. */
  async resolveAddresses(addresses: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
    const resolved = new Map<string, readonly string[]>();
    await Promise.all(
      unique.map(async (address) => {
        resolved.set(address, isIP(address) ? [address] : await this.ipsOf(address));
      }),
    );
    return resolved;
  }
}

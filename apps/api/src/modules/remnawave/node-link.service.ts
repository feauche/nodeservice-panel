import { lookup } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { RemnawaveNode, Server } from '@nodeservice/shared';

import { normalizeAddress } from '../servers/addresses.js';
import { hostsToResolve, type LinkServer, NodeLinks } from './node-link.logic.js';

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

/**
 * Связь «сервер панели ↔ нода Remnawave» для всех мест сразу: падение онлайна, перепроверка, вход через мост,
 * разбор Джарвиса, «Ёмкость», карточки серверов и страница Remnawave. Правила — в linkNodes.
 */
@Injectable()
export class NodeLinkService {
  private readonly cache = new Map<string, { at: number; ips: string[] }>();

  constructor(@Inject(HOST_RESOLVER) private readonly resolver: HostResolver) {}

  private async ipsOf(host: string): Promise<string[]> {
    const hit = this.cache.get(host);
    if (hit && Date.now() - hit.at < (hit.ips.length > 0 ? FRESH_MS : FAILED_MS)) return hit.ips;
    const ips = await this.resolver.resolve(host).catch(() => []);
    // DNS не ответил, а раньше отвечал — держимся за прежний ответ: связь не должна рваться от сбоя DNS.
    const kept = ips.length === 0 && hit && hit.ips.length > 0 ? hit.ips : ips;
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(host, { at: Date.now(), ips: kept });
    return kept;
  }

  /** Связи по переданным спискам: у вызывающего они обычно уже есть, читать их второй раз незачем. */
  async resolve<N extends Pick<RemnawaveNode, 'uuid' | 'name' | 'address'>>(
    servers: LinkServer[],
    nodes: N[],
  ): Promise<NodeLinks<N>> {
    const hosts = hostsToResolve(servers, nodes);
    const resolved = new Map<string, string[]>();
    await Promise.all(
      hosts.map(async (h) => {
        resolved.set(h, await this.ipsOf(h));
      }),
    );
    return new NodeLinks(servers, nodes, resolved);
  }

  /** Ноды для отдачи наружу: у каждой — её серверы и способ, которым нашлась связь. */
  async annotate(servers: Server[], nodes: RemnawaveNode[]): Promise<RemnawaveNode[]> {
    const links = await this.resolve(servers, nodes);
    return nodes.map((n) => {
      const serverIds = links.serverIdsOf(n.uuid);
      return { ...n, serverIds, linkedBy: serverIds[0] ? links.byOf(serverIds[0]) : null };
    });
  }
}

import { Injectable } from '@nestjs/common';
import type { BlockCheckResult } from '@nodeservice/shared';

import { NodeBlockCheckService } from '../incidents/node-block-check.service.js';
import { NodeLinkService } from '../remnawave/node-link.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';

/** Проверка пользовательского порта ноды или SSH-порта обычного сервера из России и других стран. */
@Injectable()
export class RussiaAccessCheckService {
  constructor(
    private readonly servers: ServersService,
    private readonly remnawave: RemnawaveService,
    private readonly links: NodeLinkService,
    private readonly blockCheck: NodeBlockCheckService,
  ) {}

  async run(serverId: string): Promise<BlockCheckResult> {
    const allServers = await this.servers.list();
    const server = allServers.find((item) => item.id === serverId);
    if (!server) throw new Error('Сервер больше не найден в NodeService.');

    // Явное «ноды нет» не должно даже зависеть от доступности Remnawave: проверяем сам сервер.
    if (server.nodeLink === 'none')
      return this.blockCheck.checkServer(server.name, server.host, server.port, serverId, allServers);

    // Для ноды берём текущий адрес, а не последний удачный снимок минутной синхронизации.
    const status = await this.remnawave.refresh();
    const links = await this.links.resolve(allServers, status.nodes);
    const node = links.nodeOf(serverId);
    // Auto может честно не найти ноду: это всё равно обычный сервер, и его доступность проверить можно.
    if (!node)
      return this.blockCheck.checkServer(server.name, server.host, server.port, serverId, allServers);

    const inbound = await this.remnawave.nodeInbound(node.uuid);
    return this.blockCheck.check(
      node.name,
      node.address,
      inbound?.port ?? null,
      inbound?.sni ?? null,
      [...new Set([serverId, ...links.machineIds(node)])],
      allServers,
      Boolean(inbound?.failed),
      { protocol: inbound?.protocol ?? null, network: inbound?.network ?? null },
    );
  }
}

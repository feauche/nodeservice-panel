import { Injectable } from '@nestjs/common';
import type { BlockCheckResult } from '@nodeservice/shared';

import { NodeBlockCheckService } from '../incidents/node-block-check.service.js';
import { NodeLinkService } from '../remnawave/node-link.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';

/** Ручная проверка пользовательского порта связанной ноды из России и контрольных зарубежных точек. */
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

    // Ручная проверка должна брать текущий адрес ноды, а не последний удачный снимок минутной синхронизации.
    const status = await this.remnawave.refresh();
    const links = await this.links.resolve(allServers, status.nodes);
    const node = links.nodeOf(serverId);
    if (!node)
      throw new Error(
        'У сервера не найдена связанная нода Remnawave. Выберите ноду во вкладке «Профиль» или проверьте её адрес.',
      );

    const inbound = await this.remnawave.nodeInbound(node.uuid);
    return this.blockCheck.check(
      node.name,
      node.address,
      inbound?.port ?? null,
      inbound?.sni ?? null,
      [...new Set([serverId, ...links.machineIds(node)])],
      allServers,
      Boolean(inbound?.failed),
    );
  }
}

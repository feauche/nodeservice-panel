import { isExitOnly, type Server, splitUpstreamAddress } from '@nodeservice/shared';

import type { RemnawaveService } from '../remnawave/remnawave.service.js';

/** Куда стучаться, чтобы проверить вход сервера-выхода. */
export interface UpstreamTarget {
  label: string;
  host: string;
  port: number;
  owner: string | null;
  /** Свой мост — его сервер в NodeService (с него самого не проверяем). */
  serverId: string | null;
}

/**
 * Вход сервера-выхода из профиля. Вход арендодателя — адрес как есть (порт по умолчанию 443). Свой мост —
 * адрес сервера-моста и порт его ноды из Remnawave; ноды нет — проверить нечем, null.
 */
export async function resolveUpstreamTarget(
  server: Server | null,
  allServers: Server[],
  remnawave: Pick<RemnawaveService, 'status' | 'nodeInbound'>,
): Promise<UpstreamTarget | null> {
  const up = server?.profile.upstream;
  if (!server || !up || !isExitOnly(server.profile.roles)) return null;
  if (up.kind === 'rent') {
    if (!up.address) return null;
    const { host, port } = splitUpstreamAddress(up.address);
    return { label: 'Вход арендодателя', host, port, owner: up.owner, serverId: null };
  }
  const bridge = allServers.find((s) => s.id === up.serverId);
  if (!bridge) return null;
  const status = await remnawave.status().catch(() => null);
  const node = status?.nodes.find((n) => n.address === bridge.host);
  const inbound = node ? await remnawave.nodeInbound(node.uuid) : null;
  if (!inbound?.port) return null;
  return {
    label: `Мост «${bridge.name}»`,
    host: bridge.host,
    port: inbound.port,
    owner: null,
    serverId: bridge.id,
  };
}

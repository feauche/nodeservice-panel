import {
  type BlockCheckResult,
  type BlockUncheckedReason,
  isExitOnly,
  type Server,
  splitUpstreamAddress,
} from '@nodeservice/shared';

import type { NodeLinkService } from '../remnawave/node-link.service.js';
import type { RemnawaveService } from '../remnawave/remnawave.service.js';

/** Куда стучаться, чтобы проверить вход сервера-выхода. */
export interface UpstreamTarget {
  label: string;
  host: string;
  port: number;
  owner: string | null;
  /** Свой мост — его сервер в NodeService (с него самого не проверяем). */
  serverId: string | null;
  /** Вход арендован: при неоплате выключают его, а не выход. */
  rented: boolean;
}

/**
 * Что панель знает о входе сервера-выхода:
 * - none — входа в профиле нет (или сервер не чистый выход): проверять нечего;
 * - target — куда стучаться;
 * - unknown — вход указан, но стучаться некуда: у моста нет ноды в Remnawave, мост удалён, Remnawave не
 *   ответила. Это не «входа нет»: возможная причина сбоя осталась непроверенной, и дело должно так и сказать.
 */
export type UpstreamResolution =
  | { kind: 'none' }
  | { kind: 'target'; target: UpstreamTarget }
  | {
      kind: 'unknown';
      label: string;
      owner: string | null;
      rented: boolean;
      reason: Extract<BlockUncheckedReason, 'no_port' | 'remnawave' | 'gone' | 'bad_address'>;
    };

/**
 * Вход сервера-выхода из профиля. Вход арендодателя — адрес как есть (порт по умолчанию 443). Свой мост —
 * адрес сервера-моста и порт его ноды из Remnawave.
 */
export async function resolveUpstream(
  server: Server | null,
  allServers: Server[],
  remnawave: Pick<RemnawaveService, 'status' | 'nodeInbound'>,
  links: Pick<NodeLinkService, 'resolve'>,
): Promise<UpstreamResolution> {
  const up = server?.profile.upstream;
  if (!server || !up || !isExitOnly(server.profile.roles)) return { kind: 'none' };
  if (up.kind === 'rent') {
    if (!up.address)
      return {
        kind: 'unknown',
        label: 'Вход арендодателя',
        owner: up.owner,
        rented: true,
        reason: 'bad_address',
      };
    const { host, port } = splitUpstreamAddress(up.address);
    return {
      kind: 'target',
      target: { label: 'Вход арендодателя', host, port, owner: up.owner, serverId: null, rented: true },
    };
  }
  const bridge = allServers.find((s) => s.id === up.serverId);
  if (!bridge) return { kind: 'unknown', label: 'Мост', owner: null, rented: false, reason: 'gone' };
  const label = `Мост «${bridge.name}»`;
  const unknown = (reason: 'no_port' | 'remnawave'): UpstreamResolution => ({
    kind: 'unknown',
    label,
    owner: null,
    rented: false,
    reason,
  });
  const status = await remnawave.status().catch(() => null);
  if (!status?.connected) return unknown('remnawave');
  // Нода моста — по общей связи «сервер ↔ нода» (адрес, IP или выбор в профиле), а не по совпадению строк.
  const node = (await links.resolve(allServers, status.nodes)).nodeOf(bridge.id);
  if (!node) return unknown('no_port');
  const inbound = await remnawave.nodeInbound(node.uuid);
  if (!inbound?.port) return unknown(inbound?.failed ? 'remnawave' : 'no_port');
  return {
    kind: 'target',
    target: { label, host: bridge.host, port: inbound.port, owner: null, serverId: bridge.id, rented: false },
  };
}

/** Только цель проверки; null — входа нет или стучаться некуда (почему — скажет resolveUpstream). */
export async function resolveUpstreamTarget(
  server: Server | null,
  allServers: Server[],
  remnawave: Pick<RemnawaveService, 'status' | 'nodeInbound'>,
  links: Pick<NodeLinkService, 'resolve'>,
): Promise<UpstreamTarget | null> {
  const up = await resolveUpstream(server, allServers, remnawave, links);
  return up.kind === 'target' ? up.target : null;
}

/** Вход, который проверить нечем, — записью для результата проверки: без проб, с настоящей причиной. */
export function unknownEntry(
  up: Extract<UpstreamResolution, { kind: 'unknown' }>,
): NonNullable<BlockCheckResult['entry']> {
  return {
    label: up.label,
    address: '',
    owner: up.owner,
    rented: up.rented,
    probes: [],
    verdict: 'unreachable',
    unchecked: up.reason,
  };
}

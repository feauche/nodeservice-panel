import { isIP } from 'node:net';
import {
  NODE_LINK_AUTO,
  NODE_LINK_NONE,
  type NodeLinkBy,
  type RemnawaveNode,
  type Server,
} from '@nodeservice/shared';

import { normalizeAddress } from '../servers/addresses.js';

/** Что нужно знать о сервере, чтобы связать его с нодой. */
export type LinkServer = Pick<Server, 'id' | 'name' | 'host' | 'nodeLink' | 'facts'>;
type LinkNode = Pick<RemnawaveNode, 'uuid' | 'name' | 'address'>;

/** Во что разрешились домены: адрес в сравнимом виде → его IP. У IP-адресов записей нет. */
export type ResolvedHosts = ReadonlyMap<string, readonly string[]>;

export interface NodeLinkRow {
  serverId: string;
  nodeUuid: string;
  by: NodeLinkBy;
}

/** Все IP, под которыми известен этот адрес: сам адрес, если он IP, или то, во что разрешился домен. */
function ipsOf(address: string, resolved: ResolvedHosts): string[] {
  const a = normalizeAddress(address);
  return isIP(a) ? [a] : [...(resolved.get(a) ?? [])];
}

/** Все IP машины сервера: адрес подключения и внешние адреса на его интерфейсах. */
function serverIps(server: LinkServer, resolved: ResolvedHosts): Set<string> {
  return new Set([...ipsOf(server.host, resolved), ...(server.facts.addresses ?? []).map(normalizeAddress)]);
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Как нода подходит серверу: тот же адрес, тот же IP или никак. */
function matchOf(server: LinkServer, node: LinkNode, resolved: ResolvedHosts): 'address' | 'ip' | null {
  if (normalizeAddress(server.host) === normalizeAddress(node.address)) return 'address';
  const ips = serverIps(server, resolved);
  return ipsOf(node.address, resolved).some((ip) => ips.has(ip)) ? 'ip' : null;
}

/**
 * Кто с кем связан (решение владельца 30.09.2026). Раньше сервер и нода считались одной машиной, только
 * если адреса совпадали буква в букву: домен против IP, другой регистр или второй адрес сервера рвали связь —
 * падение онлайна разбиралось вслепую («сервер не добавлен»), без оплаты, без входа, с проверкой с себя самой.
 * Порядок: сначала ручной выбор из профиля сервера; затем у остальных — совпадение адреса, затем совпадение IP
 * (домен сверяется по IP, куда он указывает; у сервера учитываются и адреса на его интерфейсах). У сервера не
 * больше одной ноды; одна нода может достаться нескольким записям одной машины. Нода, выбранная вручную,
 * автоматически никому больше не достаётся. Из нескольких подходящих нод берётся та, чьё название совпало.
 */
export function linkNodes(servers: LinkServer[], nodes: LinkNode[], resolved: ResolvedHosts): NodeLinkRow[] {
  const rows: NodeLinkRow[] = [];
  const manual = new Set<string>();
  for (const s of servers) {
    if (s.nodeLink === NODE_LINK_AUTO || s.nodeLink === NODE_LINK_NONE) continue;
    // Выбранной ноды больше нет в Remnawave — связи нет: молча подставлять другую было бы неправдой.
    if (!nodes.some((n) => n.uuid === s.nodeLink)) continue;
    rows.push({ serverId: s.id, nodeUuid: s.nodeLink, by: 'manual' });
    manual.add(s.nodeLink);
  }
  for (const s of servers) {
    if (s.nodeLink !== NODE_LINK_AUTO) continue;
    let best: { node: LinkNode; by: 'address' | 'ip'; named: boolean } | null = null;
    for (const node of nodes) {
      if (manual.has(node.uuid)) continue;
      const by = matchOf(s, node, resolved);
      if (!by) continue;
      const named = sameName(node.name, s.name);
      const better =
        !best || (by === 'address' && best.by === 'ip') || (by === best.by && named && !best.named);
      if (better) best = { node, by, named };
    }
    if (best) rows.push({ serverId: s.id, nodeUuid: best.node.uuid, by: best.by });
  }
  return rows;
}

/** Готовые связи с удобными вопросами к ним. */
export class NodeLinks<N extends LinkNode = RemnawaveNode> {
  private readonly rows: NodeLinkRow[];

  constructor(
    private readonly servers: LinkServer[],
    private readonly nodes: N[],
    private readonly resolved: ResolvedHosts,
  ) {
    this.rows = linkNodes(servers, nodes, resolved);
  }

  /** Нода сервера; undefined — ноды нет или она не найдена. */
  nodeOf(serverId: string): N | undefined {
    const row = this.rows.find((r) => r.serverId === serverId);
    return row ? this.nodes.find((n) => n.uuid === row.nodeUuid) : undefined;
  }

  /** Как нашлась нода сервера; null — не нашлась. */
  byOf(serverId: string): NodeLinkBy | null {
    return this.rows.find((r) => r.serverId === serverId)?.by ?? null;
  }

  /** Серверы ноды в порядке списка серверов: первый — основной. */
  serverIdsOf(nodeUuid: string): string[] {
    return this.rows.filter((r) => r.nodeUuid === nodeUuid).map((r) => r.serverId);
  }

  /**
   * Все записи панели, которые стоят на той же машине, что нода: связанные с ней и те, чей адрес или IP
   * совпал с её адресом (даже если в профиле у них «Нет ноды»). С них ноду проверять нельзя: подключение
   * сервера к самому себе не видят ни файрвол хостера, ни блокировщик — такая проверка всегда «порт открыт».
   */
  machineIds(node: LinkNode): string[] {
    const ids = new Set(this.serverIdsOf(node.uuid));
    for (const s of this.servers) if (matchOf(s, node, this.resolved)) ids.add(s.id);
    return [...ids];
  }

  /**
   * Сервер с тем же названием, что у ноды без сервера: подсказка «похоже, это он — свяжите в профиле».
   * Только подсказка: по одному названию панель связь не ставит. У сервера уже есть нода — не подсказываем.
   */
  namesakeOf(node: LinkNode): LinkServer | undefined {
    if (this.serverIdsOf(node.uuid).length > 0) return undefined;
    return this.servers.find(
      (s) => sameName(s.name, node.name) && s.nodeLink !== NODE_LINK_NONE && !this.nodeOf(s.id),
    );
  }
}

/** Адреса, которые надо разрешить в IP, чтобы сверить ноды с серверами: только домены, без повторов. */
export function hostsToResolve(servers: LinkServer[], nodes: LinkNode[]): string[] {
  const out = new Set<string>();
  for (const a of [...servers.map((s) => s.host), ...nodes.map((n) => n.address)]) {
    const n = normalizeAddress(a);
    if (n && !isIP(n)) out.add(n);
  }
  return [...out];
}

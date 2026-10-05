import { isIP } from 'node:net';
import type {
  RemnawaveTopology,
  RemnawaveTopologyHost,
  RemnawaveTopologyIssue,
  RemnawaveTopologyNode,
  RemnawaveTopologyPath,
  RemnawaveTopologyRoute,
} from '@nodeservice/shared';

import { normalizeAddress } from '../servers/addresses.js';
import type { RemnawaveTopologySource } from './remnawave-client.js';

type Row = Record<string, unknown>;

const row = (value: unknown): Row => (value && typeof value === 'object' ? (value as Row) : {});
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value.filter((item) => item && typeof item === 'object') as Row[]) : [];
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 40) : [];
const entityIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          const entity = row(item);
          return text(entity.uuid) || text(entity.nodeUuid) || text(entity.id);
        })
        .filter(Boolean)
        .slice(0, 200)
    : [];
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const clean = (value: string, fallback: string): string => (value || fallback).slice(0, 180);

/** Хост Remnawave может содержать несколько адресов через запятую; порт не участвует в DNS-сверке. */
export function topologyAddressTokens(value: unknown): string[] {
  return text(value)
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const bracketed = trimmed.match(/^\[(.+)\](?::\d+)?$/);
      if (bracketed?.[1]) return normalizeAddress(bracketed[1]);
      if (isIP(trimmed) === 6) return normalizeAddress(trimmed);
      return normalizeAddress(trimmed.replace(/:\d+$/, ''));
    })
    .filter(Boolean);
}

export function topologyAddresses(source: RemnawaveTopologySource): string[] {
  return [
    ...source.hosts.flatMap((host) => topologyAddressTokens(host.address)),
    ...source.nodes.flatMap((node) => topologyAddressTokens(node.address)),
    ...source.profiles.flatMap((profile) =>
      rows(configOf(profile).outbounds).flatMap((outbound) =>
        topologyAddressTokens(outboundAddress(outbound)),
      ),
    ),
  ];
}

function addressIps(value: unknown, resolved: ReadonlyMap<string, readonly string[]>): string[] {
  return topologyAddressTokens(value).flatMap((address) =>
    isIP(address) ? [address] : [...(resolved.get(address) ?? [])],
  );
}

function configOf(profile: Row): Row {
  if (profile.config && typeof profile.config === 'object') return profile.config as Row;
  if (typeof profile.config === 'string') {
    try {
      const parsed = JSON.parse(profile.config) as unknown;
      return row(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

function protocolOf(inbound: Row): {
  protocol: string | null;
  network: string | null;
  security: string | null;
} {
  const raw = row(inbound.rawInbound);
  const stream = row(raw.streamSettings);
  return {
    protocol: text(inbound.type) || text(inbound.protocol) || text(raw.protocol) || null,
    network: text(inbound.network) || text(stream.network) || null,
    security: text(inbound.security) || text(stream.security) || null,
  };
}

function matchBrief(rule: Row): string[] {
  const out: string[] = [];
  const domains = texts(rule.domain);
  const ips = texts(rule.ip);
  const protocols = texts(rule.protocol);
  const networks = text(rule.network);
  const port = text(rule.port) || (typeof rule.port === 'number' ? String(rule.port) : '');
  if (domains.length)
    out.push(
      `Домены: ${domains.slice(0, 3).join(', ')}${domains.length > 3 ? ` +${domains.length - 3}` : ''}`,
    );
  if (ips.length)
    out.push(`Сети: ${ips.slice(0, 3).join(', ')}${ips.length > 3 ? ` +${ips.length - 3}` : ''}`);
  if (port) out.push(`Порт: ${port.slice(0, 80)}`);
  if (networks) out.push(`Транспорт: ${networks.slice(0, 80)}`);
  if (protocols.length) out.push(`Протокол: ${protocols.slice(0, 3).join(', ')}`);
  return out.length ? out.slice(0, 5) : ['Любой трафик'];
}

function outboundAddress(outbound: Row): string | null {
  const settings = row(outbound.settings);
  const firstServer = rows(settings.servers)[0];
  const firstVnext = rows(settings.vnext)[0];
  return text(settings.address) || text(firstServer?.address) || text(firstVnext?.address) || null;
}

type TargetAnalysis = Pick<
  RemnawaveTopologyRoute,
  | 'targetKind'
  | 'targetLabel'
  | 'targetNodeUuids'
  | 'status'
  | 'confidence'
  | 'note'
  | 'outboundProtocol'
  | 'outboundAddress'
  | 'dialerProxy'
  | 'explanation'
>;

function servicePurpose(protocol: string, address: string | null): string {
  if (protocol === 'socks')
    return address && /^(127\.|localhost|::1)/i.test(address)
      ? 'Локальный SOCKS-прокси на этом сервере.'
      : 'Внешний SOCKS-прокси.';
  if (protocol === 'http') return 'HTTP-прокси для исходящего трафика.';
  if (protocol === 'vless' || protocol === 'vmess' || protocol === 'trojan')
    return 'Туннель на другой VPN-сервер.';
  if (protocol === 'wireguard') return 'Выход через туннель WireGuard.';
  return protocol ? `Служебный выход Xray с протоколом ${protocol}.` : 'Назначение выхода не указано.';
}

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.$/, '')
    .replace(/[^a-zа-яё0-9]+/gi, '');
}

function targetOf(
  outboundTag: string,
  outbounds: Row[],
  nodes: RemnawaveTopologyNode[],
  resolvedAddresses: ReadonlyMap<string, readonly string[]> = new Map(),
  visited = new Set<string>(),
  selectedOutbound?: Row,
): TargetAnalysis {
  const outbound = selectedOutbound ?? outbounds.find((item) => text(item.tag) === outboundTag);
  if (!outbound)
    return {
      targetKind: 'unknown',
      targetLabel: outboundTag || 'Выход не указан',
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'unknown',
      note: 'В профиле не найден выход с таким тегом.',
      outboundProtocol: null,
      outboundAddress: null,
      dialerProxy: null,
      explanation: 'Правило ссылается на выход, которого нет в списке outbounds этого профиля.',
    };
  const tag = text(outbound.tag) || outboundTag;
  const protocol = text(outbound.protocol).toLowerCase();
  const address = outboundAddress(outbound);
  const dialerProxy = text(row(row(outbound.streamSettings).sockopt).dialerProxy) || null;
  const metadata = {
    outboundProtocol: protocol || null,
    outboundAddress: address,
    dialerProxy,
  };
  if (visited.has(tag))
    return {
      targetKind: 'unknown',
      targetLabel: tag,
      targetNodeUuids: [],
      status: 'error',
      confidence: 'confirmed',
      note: 'В цепочке outbound обнаружена циклическая ссылка dialerProxy.',
      ...metadata,
      explanation: 'Выход отправляет трафик сам в себя по цепочке dialerProxy. Такая цепочка не завершится.',
    };
  const nextVisited = new Set(visited).add(tag);
  if (dialerProxy) {
    const nested = targetOf(dialerProxy, outbounds, nodes, resolvedAddresses, nextVisited);
    return {
      ...nested,
      targetLabel: `${tag} → ${nested.targetLabel}`,
      ...metadata,
      note: nested.note
        ? `Цепочка dialerProxy: ${tag} → ${dialerProxy}. ${nested.note}`
        : `Цепочка dialerProxy: ${tag} → ${dialerProxy}.`,
      explanation: `Сначала Xray выбирает выход «${tag}», затем через dialerProxy передаёт соединение в «${dialerProxy}». ${nested.explanation}`,
    };
  }
  if (protocol === 'freedom' || protocol === 'direct')
    return {
      targetKind: 'internet',
      targetLabel: 'Интернет напрямую',
      targetNodeUuids: [],
      status: 'ok',
      confidence: 'confirmed',
      note: null,
      ...metadata,
      explanation: 'Xray выпускает подходящий трафик в интернет напрямую с этой ноды.',
    };
  if (protocol === 'blackhole' || /block|reject|запрет/i.test(tag))
    return {
      targetKind: 'blocked',
      targetLabel: 'Заблокировано правилом',
      targetNodeUuids: [],
      status: 'ok',
      confidence: 'confirmed',
      note: null,
      ...metadata,
      explanation: 'Xray намеренно отклоняет подходящий трафик правилом blackhole.',
    };
  const outboundIps = new Set(addressIps(address, resolvedAddresses));
  const exact = address
    ? nodes.filter(
        (node) =>
          node.address.toLowerCase() === address.toLowerCase() ||
          addressIps(node.address, resolvedAddresses).some((ip) => outboundIps.has(ip)),
      )
    : [];
  const byName = exact.length
    ? []
    : nodes.filter((node) => norm(tag).includes(norm(node.name)) && norm(node.name).length >= 4);
  const matches = exact.length ? exact : byName;
  if (matches.length) {
    const broken = matches.every((node) => node.status === 'error');
    return {
      targetKind: 'node',
      targetLabel: matches.map((node) => node.name).join(', '),
      targetNodeUuids: matches.map((node) => node.id),
      status: broken ? 'error' : 'ok',
      confidence: exact.length ? 'confirmed' : 'inferred',
      note: exact.length ? null : 'Выход сопоставлен с нодой по имени тега.',
      ...metadata,
      explanation: exact.length
        ? `Xray передаёт трафик на адрес ${address}; он совпал с этой нодой Remnawave.`
        : 'Xray передаёт трафик в другой VPN-выход; нода сопоставлена по названию тега.',
    };
  }
  if (/psiphon/i.test(tag))
    return {
      targetKind: 'service',
      targetLabel: 'Psiphon',
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'inferred',
      note: 'Маршрут распознан по локальному SOCKS-выходу; состояние службы проверяется на сервере.',
      ...metadata,
      explanation:
        'Xray передаёт подходящий трафик в локальный SOCKS-порт Psiphon. Это описание настройки; работу процесса нужно подтверждать проверкой сервера.',
    };
  if (protocol === 'socks' && address && /^(127\.|localhost|::1)/i.test(address))
    return {
      targetKind: 'service',
      targetLabel: text(outbound.tag) || 'Локальный SOCKS-прокси',
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'confirmed',
      note: 'Конфигурация подтверждает локальный SOCKS-выход, но не называет процесс, который слушает порт.',
      ...metadata,
      explanation:
        'Xray передаёт подходящий трафик в SOCKS-прокси на этом же сервере. Назвать его Psiphon можно только тогда, когда это явно указано в теге.',
    };
  return {
    targetKind: 'service',
    targetLabel: tag || protocol || 'Сервисный выход',
    targetNodeUuids: [],
    status: 'unknown',
    confidence: 'unknown',
    ...metadata,
    note: address
      ? `Выход ведёт на ${address}, но связать его с нодой NodeService однозначно не удалось.`
      : 'Профиль задаёт сервисный выход, но его назначение нельзя подтвердить без предположений.',
    explanation: `${servicePurpose(protocol, address)} NodeService показывает тег и адрес из Xray, но не называет конкретную ноду без точного совпадения.`,
  };
}

function targetForRule(
  outboundTag: string,
  balancerTag: string,
  outbounds: Row[],
  balancers: Row[],
  nodes: RemnawaveTopologyNode[],
  resolvedAddresses: ReadonlyMap<string, readonly string[]>,
): TargetAnalysis {
  if (!balancerTag) return targetOf(outboundTag, outbounds, nodes, resolvedAddresses);
  const balancer = balancers.find((item) => text(item.tag) === balancerTag);
  if (!balancer)
    return {
      targetKind: 'unknown',
      targetLabel: balancerTag,
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'unknown',
      note: 'Правило ссылается на балансировщик, которого нет в профиле.',
      outboundProtocol: 'balancer',
      outboundAddress: null,
      dialerProxy: null,
      explanation: 'Правило указывает балансировщик, которого нет в routing.balancers этого профиля.',
    };
  const selectors = texts(balancer.selector);
  const selected = outbounds.filter((item) => {
    const tag = text(item.tag);
    return selectors.some((selector) => tag === selector || tag.startsWith(selector));
  });
  const targets = selected.map((item) => targetOf(text(item.tag), outbounds, nodes, resolvedAddresses));
  const nodeIds = [...new Set(targets.flatMap((target) => target.targetNodeUuids))];
  const labels = [...new Set(targets.map((target) => target.targetLabel))];
  return {
    targetKind: nodeIds.length ? 'node' : 'service',
    targetLabel: labels.length ? labels.join(', ') : `Балансировщик ${balancerTag}`,
    targetNodeUuids: nodeIds,
    status: targets.some((target) => target.status === 'ok')
      ? 'ok'
      : targets.some((target) => target.status === 'error')
        ? 'error'
        : 'unknown',
    confidence: selected.length ? 'confirmed' : 'unknown',
    outboundProtocol: 'balancer',
    outboundAddress: null,
    dialerProxy: null,
    note: selected.length
      ? `Балансировщик «${balancerTag}» выбирает из ${selected.length} выходов.`
      : `У балансировщика «${balancerTag}» не найдено выходов по selector.`,
    explanation: selected.length
      ? `Xray выбирает один из ${selected.length} выходов балансировщика «${balancerTag}» по его стратегии.`
      : `Балансировщик «${balancerTag}» не нашёл ни одного outbound по selector.`,
  };
}

export function buildRemnawaveTopology(
  source: RemnawaveTopologySource,
  linkedServerIds: ReadonlyMap<string, readonly string[]> = new Map(),
  resolvedAddresses: ReadonlyMap<string, readonly string[]> = new Map(),
  generatedAt = new Date().toISOString(),
): RemnawaveTopology {
  const metrics = new Map(
    source.metrics.map((item) => [
      text(item.nodeUuid),
      Math.max(0, Math.round(number(item.usersOnline) ?? 0)),
    ]),
  );
  const nodes: RemnawaveTopologyNode[] = source.nodes.map((raw, index) => {
    const id = text(raw.uuid) || `node-${index}`;
    const profile = row(raw.configProfile);
    const disabled = Boolean(raw.isDisabled);
    const connected = Boolean(raw.isConnected);
    return {
      id,
      name: clean(text(raw.name), `Нода ${index + 1}`),
      address: clean(text(raw.address), 'адрес не указан'),
      countryCode: text(raw.countryCode) || null,
      connected,
      disabled,
      usersOnline: metrics.has(id) ? (metrics.get(id) ?? 0) : disabled ? null : 0,
      profileUuid: text(profile.activeConfigProfileUuid) || null,
      inboundUuids: rows(profile.activeInbounds)
        .map((item) => text(item.uuid))
        .filter(Boolean),
      serverIds: [...(linkedServerIds.get(id) ?? [])],
      status: disabled ? 'unknown' : connected ? 'ok' : 'error',
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeIdsByIp = new Map<string, string[]>();
  for (const [index, raw] of source.nodes.entries())
    for (const ip of addressIps(raw.address, resolvedAddresses)) {
      const ids = nodeIdsByIp.get(ip) ?? [];
      ids.push(nodes[index]?.id ?? '');
      nodeIdsByIp.set(ip, ids.filter(Boolean));
    }

  const hosts: RemnawaveTopologyHost[] = source.hosts.map((raw, index) => {
    const inbound = row(raw.inbound);
    const inboundUuid = text(inbound.configProfileInboundUuid) || text(inbound.uuid) || null;
    const profileUuid = text(inbound.configProfileUuid) || text(inbound.profileUuid) || null;
    const matchingInbound = source.profiles
      .flatMap((profile) => rows(profile.inbounds).map((item) => ({ profile, item })))
      .find(({ item }) => text(item.uuid) === inboundUuid)?.item;
    const proto = protocolOf(matchingInbound ?? inbound);
    // activeInbounds говорит, какие ноды умеют обслуживать профиль. Конкретный же путь
    // клиента определяет DNS/IP хоста. Иначе один общий профиль рисовал ложный веер
    // от каждого хоста ко всем нодам профиля.
    const servingNodeUuids = inboundUuid
      ? nodes.filter((node) => node.inboundUuids.includes(inboundUuid)).map((node) => node.id)
      : [];
    const explicitNodeUuids = entityIds(raw.nodes);
    const dnsNodeUuids = [
      ...new Set(addressIps(raw.address, resolvedAddresses).flatMap((ip) => nodeIdsByIp.get(ip) ?? [])),
    ];
    const nodeUuids = dnsNodeUuids.length
      ? dnsNodeUuids
      : explicitNodeUuids.length
        ? explicitNodeUuids
        : servingNodeUuids.length === 1
          ? servingNodeUuids
          : [];
    const linked = nodeUuids.map((id) => nodeById.get(id)).filter(Boolean) as RemnawaveTopologyNode[];
    const disabled = Boolean(raw.isDisabled);
    const status: RemnawaveTopologyHost['status'] = disabled
      ? 'unknown'
      : inboundUuid && nodeUuids.length === 0
        ? 'warning'
        : nodeUuids.length === 0
          ? 'unknown'
          : linked.length === 0 || linked.every((node) => node.status === 'error')
            ? 'error'
            : 'ok';
    return {
      id: text(raw.uuid) || `host-${index}`,
      name: clean(text(raw.remark) || text(raw.name), `Хост ${index + 1}`),
      address: clean(text(raw.address), 'адрес не указан'),
      port: Math.max(1, Math.min(65_535, Math.round(number(raw.port) ?? 443))),
      disabled,
      profileUuid,
      inboundUuid,
      inboundTag: text(matchingInbound?.tag) || text(inbound.tag) || null,
      ...proto,
      nodeUuids,
      status,
    };
  });

  const routes: RemnawaveTopologyRoute[] = [];
  for (const [profileIndex, profile] of source.profiles.entries()) {
    const profileUuid = text(profile.uuid) || `profile-${profileIndex}`;
    const profileName = clean(text(profile.name), `Профиль ${profileIndex + 1}`);
    const config = configOf(profile);
    const outbounds = rows(config.outbounds);
    const routing = row(config.routing);
    const rules = rows(routing.rules);
    const balancers = rows(routing.balancers);
    const profileHosts = hosts.filter((host) => host.profileUuid === profileUuid);
    for (const [index, rule] of rules.entries()) {
      const inboundTags = texts(rule.inboundTag);
      const directOutboundTag = text(rule.outboundTag);
      const balancerTag = text(rule.balancerTag);
      const outboundTag = directOutboundTag || balancerTag;
      const hostIds = profileHosts
        .filter(
          (host) => inboundTags.length === 0 || (host.inboundTag && inboundTags.includes(host.inboundTag)),
        )
        .map((host) => host.id);
      const target = targetForRule(
        directOutboundTag,
        balancerTag,
        outbounds,
        balancers,
        nodes,
        resolvedAddresses,
      );
      const match = matchBrief(rule);
      routes.push({
        id: `${profileUuid}:rule:${index}`,
        profileUuid,
        profileName,
        order: index,
        isDefault: false,
        match,
        inboundTags,
        hostIds,
        outboundTag: outboundTag || 'не указан',
        ...target,
        explanation: `Правило ${index + 1} обрабатывает: ${match.join('; ')}. ${target.explanation}`,
      });
    }
    const defaultOutbound = outbounds[0];
    if (defaultOutbound) {
      const protocol = text(defaultOutbound.protocol).toLowerCase();
      const outboundTag = text(defaultOutbound.tag) || `(без тега) · ${protocol || 'протокол не указан'}`;
      const target = targetOf(outboundTag, outbounds, nodes, resolvedAddresses, new Set(), defaultOutbound);
      routes.push({
        id: `${profileUuid}:default`,
        profileUuid,
        profileName,
        order: rules.length,
        isDefault: true,
        match: ['Остальной трафик'],
        inboundTags: [],
        hostIds: profileHosts.map((host) => host.id),
        outboundTag,
        ...target,
        explanation: `Это маршрут по умолчанию: если ни одно правило routing выше не подошло, Xray использует первый outbound в списке. ${target.explanation}`,
      });
    }
  }

  const profiles = source.profiles.map((profile, profileIndex) => {
    const id = text(profile.uuid) || `profile-${profileIndex}`;
    const name = clean(text(profile.name), `Профиль ${profileIndex + 1}`);
    const config = configOf(profile);
    const rawInbounds = rows(config.inbounds).length ? rows(config.inbounds) : rows(profile.inbounds);
    const rawOutbounds = rows(config.outbounds);
    const rules = rows(row(config.routing).rules);
    const profileRoutes = routes.filter((route) => route.profileUuid === id);
    const profileHosts = hosts.filter((host) => host.profileUuid === id);
    const profileNodes = nodes.filter((node) => node.profileUuid === id);
    const outbounds = rawOutbounds.map((outbound, index) => {
      const tag = text(outbound.tag) || null;
      const protocol = text(outbound.protocol).toLowerCase() || null;
      const address = outboundAddress(outbound);
      const dialerProxy = text(row(row(outbound.streamSettings).sockopt).dialerProxy) || null;
      const displayTag = tag || `(без тега) · ${protocol || `выход ${index + 1}`}`;
      const target = targetOf(displayTag, rawOutbounds, nodes, resolvedAddresses, new Set(), outbound);
      const usedByRules = tag ? rules.filter((rule) => text(rule.outboundTag) === tag).length : 0;
      return {
        tag,
        protocol,
        address,
        dialerProxy,
        usedByRules,
        purpose: target.targetLabel,
        note: target.explanation,
      };
    });
    const status: RemnawaveTopologyHost['status'] =
      rawOutbounds.length === 0 ||
      profileRoutes.some((route) => route.targetKind === 'unknown' && route.status === 'error')
        ? 'error'
        : profileRoutes.some((route) => route.targetKind === 'unknown')
          ? 'warning'
          : 'ok';
    return {
      id,
      name,
      status,
      hostIds: profileHosts.map((host) => host.id),
      nodeUuids: profileNodes.map((node) => node.id),
      inbounds: rawInbounds.map((inbound, index) => {
        const protocol = protocolOf(inbound);
        const rawPort = number(inbound.port);
        return {
          tag: text(inbound.tag) || `Инбаунд ${index + 1}`,
          protocol: protocol.protocol,
          port: rawPort !== null && rawPort >= 1 && rawPort <= 65_535 ? Math.round(rawPort) : null,
          network: protocol.network,
          security: protocol.security,
        };
      }),
      outbounds,
      routingRules: rules.length,
      summary: `${rawInbounds.length} инбаундов · ${rawOutbounds.length} выходов · ${rules.length} правил routing`,
    };
  });

  const issues: RemnawaveTopologyIssue[] = [];
  for (const node of nodes) {
    if (node.disabled) continue;
    if (!node.connected)
      issues.push({
        id: `node-down:${node.id}`,
        severity: 'error',
        kind: 'node_down',
        title: `Нода «${node.name}» не на связи`,
        detail: 'Remnawave помечает ноду отключённой. Маршруты через неё могут не работать.',
        hostIds: hosts.filter((host) => host.nodeUuids.includes(node.id)).map((host) => host.id),
        nodeUuids: [node.id],
        routeIds: routes.filter((route) => route.targetNodeUuids.includes(node.id)).map((route) => route.id),
      });
  }
  for (const host of hosts) {
    if (host.disabled) continue;
    const servingNodes = host.inboundUuid
      ? nodes.filter((node) => node.inboundUuids.includes(host.inboundUuid as string))
      : [];
    if (host.inboundUuid && servingNodes.length === 0)
      issues.push({
        id: `host-no-node:${host.id}`,
        severity: 'warning',
        kind: 'host_no_nodes',
        title: `Инбаунд хоста «${host.name}» не запущен на нодах`,
        detail:
          'Ни одна нода Remnawave не указала этот инбаунд среди activeInbounds. Проверьте, что профиль и инбаунд запущены хотя бы на одной ноде.',
        hostIds: [host.id],
        nodeUuids: [],
        routeIds: [],
      });
    else if (host.inboundUuid && host.nodeUuids.length === 0)
      issues.push({
        id: `host-node-unknown:${host.id}`,
        severity: 'warning',
        kind: 'host_node_unknown',
        title: `Не определена нода хоста «${host.name}»`,
        detail:
          'Инбаунд активен на нескольких нодах, но DNS/IP хоста не совпал с адресом ноды. Карта не рисует ложную связь со всеми нодами общего профиля.',
        hostIds: [host.id],
        nodeUuids: servingNodes.map((node) => node.id),
        routeIds: routes.filter((route) => route.hostIds.includes(host.id)).map((route) => route.id),
      });
    else if (host.status === 'error')
      issues.push({
        id: `host-broken:${host.id}`,
        severity: 'error',
        kind: 'host_nodes_down',
        title: `У хоста «${host.name}» нет ноды на связи`,
        detail: 'Все ноды, которые обслуживают инбаунд этого хоста, сейчас не на связи.',
        hostIds: [host.id],
        nodeUuids: host.nodeUuids,
        routeIds: routes.filter((route) => route.hostIds.includes(host.id)).map((route) => route.id),
      });
  }
  for (const route of routes) {
    if (route.targetKind !== 'unknown') continue;
    issues.push({
      id: `route-invalid:${route.id}`,
      severity: route.status === 'error' ? 'error' : 'warning',
      kind: 'route_invalid',
      title: `Не удалось подтвердить выход «${route.outboundTag}»`,
      detail: route.note ?? route.explanation,
      hostIds: route.hostIds,
      nodeUuids: route.targetNodeUuids,
      routeIds: [route.id],
    });
  }

  const paths: RemnawaveTopologyPath[] = [];
  const rank = { ok: 0, unknown: 1, warning: 2, error: 3 } as const;
  const pathStatus = (...values: Array<RemnawaveTopologyPath['status'] | undefined>) =>
    values
      .filter(Boolean)
      .reduce<RemnawaveTopologyPath['status']>(
        (worst, value) => (value && rank[value] > rank[worst] ? value : worst),
        'ok',
      );
  for (const host of hosts) {
    const hostRoutes = routes.filter((route) => route.hostIds.includes(host.id));
    const entries = host.nodeUuids.length ? host.nodeUuids : [null];
    const applicable = hostRoutes.length ? hostRoutes : [null];
    for (const entryNodeUuid of entries) {
      const entry = entryNodeUuid ? nodeById.get(entryNodeUuid) : undefined;
      for (const route of applicable) {
        const exits = route?.targetNodeUuids.length ? route.targetNodeUuids : [null];
        for (const exitNodeUuid of exits) {
          const exit = exitNodeUuid ? nodeById.get(exitNodeUuid) : undefined;
          const destination = route?.targetKind === 'node' ? 'internet' : (route?.targetKind ?? 'unknown');
          const status = pathStatus(host.status, entry?.status, route?.status, exit?.status);
          const pathId = [
            host.id,
            entryNodeUuid ?? 'entry?',
            route?.id ?? 'route?',
            exitNodeUuid ?? destination,
          ].join(':');
          const segment = (
            kind: RemnawaveTopologyPath['segments'][number]['kind'],
            fromId: string,
            toId: string,
            segmentStatus: RemnawaveTopologyPath['status'],
          ) => ({ id: `${pathId}:${kind}`, kind, fromId, toId, status: segmentStatus, runtime: null });
          paths.push({
            id: pathId,
            hostId: host.id,
            inboundTag: host.inboundTag,
            entryNodeUuid,
            routeId: route?.id ?? null,
            outboundTag: route?.outboundTag ?? null,
            exitNodeUuid,
            destination,
            status,
            confidence:
              host.nodeUuids.length && route && (route.targetKind !== 'node' || exitNodeUuid)
                ? route.confidence
                : 'unknown',
            segments: [
              segment('client_host', 'client', host.id, host.status),
              segment(
                'host_inbound',
                host.id,
                host.inboundTag ?? 'inbound?',
                host.inboundTag ? host.status : 'unknown',
              ),
              segment(
                'inbound_entry',
                host.inboundTag ?? 'inbound?',
                entryNodeUuid ?? 'entry?',
                entry?.status ?? 'unknown',
              ),
              segment(
                'entry_outbound',
                entryNodeUuid ?? 'entry?',
                route?.outboundTag ?? 'outbound?',
                route?.status ?? 'unknown',
              ),
              segment(
                'outbound_exit',
                route?.outboundTag ?? 'outbound?',
                exitNodeUuid ?? destination,
                exit?.status ?? route?.status ?? 'unknown',
              ),
              segment(
                'exit_internet',
                exitNodeUuid ?? destination,
                'internet',
                destination === 'blocked' ? 'warning' : status,
              ),
            ],
          });
        }
      }
    }
  }

  return {
    generatedAt,
    hosts,
    nodes,
    routes,
    paths,
    readiness: [],
    profiles,
    issues,
    summary: {
      hosts: hosts.length,
      nodes: nodes.length,
      routes: routes.length,
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
    },
    note: 'Карта построена по хостам, активным инбаундам, нодам и routing/outbounds Remnawave. Пунктир показывает настройку маршрута, а не измеренный пакетный трафик. Неоднозначные связи помечаются отдельно.',
  };
}

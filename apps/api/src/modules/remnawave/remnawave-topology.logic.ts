import type {
  RemnawaveTopology,
  RemnawaveTopologyHost,
  RemnawaveTopologyIssue,
  RemnawaveTopologyNode,
  RemnawaveTopologyRoute,
} from '@nodeservice/shared';

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
  visited = new Set<string>(),
): Pick<
  RemnawaveTopologyRoute,
  'targetKind' | 'targetLabel' | 'targetNodeUuids' | 'status' | 'confidence' | 'note'
> {
  const outbound = outbounds.find((item) => text(item.tag) === outboundTag);
  if (!outbound)
    return {
      targetKind: 'unknown',
      targetLabel: outboundTag || 'Выход не указан',
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'unknown',
      note: 'В профиле не найден выход с таким тегом.',
    };
  const tag = text(outbound.tag) || outboundTag;
  if (visited.has(tag))
    return {
      targetKind: 'unknown',
      targetLabel: tag,
      targetNodeUuids: [],
      status: 'error',
      confidence: 'confirmed',
      note: 'В цепочке outbound обнаружена циклическая ссылка dialerProxy.',
    };
  const nextVisited = new Set(visited).add(tag);
  const dialerProxy = text(row(row(outbound.streamSettings).sockopt).dialerProxy);
  if (dialerProxy) {
    const nested = targetOf(dialerProxy, outbounds, nodes, nextVisited);
    return {
      ...nested,
      targetLabel: `${tag} → ${nested.targetLabel}`,
      note: nested.note
        ? `Цепочка dialerProxy: ${tag} → ${dialerProxy}. ${nested.note}`
        : `Цепочка dialerProxy: ${tag} → ${dialerProxy}.`,
    };
  }
  const protocol = text(outbound.protocol).toLowerCase();
  if (protocol === 'freedom' || protocol === 'direct')
    return {
      targetKind: 'internet',
      targetLabel: 'Интернет напрямую',
      targetNodeUuids: [],
      status: 'ok',
      confidence: 'confirmed',
      note: null,
    };
  if (protocol === 'blackhole' || /block|reject|запрет/i.test(tag))
    return {
      targetKind: 'blocked',
      targetLabel: 'Заблокировано правилом',
      targetNodeUuids: [],
      status: 'ok',
      confidence: 'confirmed',
      note: null,
    };
  const address = outboundAddress(outbound);
  const exact = address ? nodes.filter((node) => node.address.toLowerCase() === address.toLowerCase()) : [];
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
    };
  }
  if (/psiphon/i.test(tag) || (protocol === 'socks' && address && /^(127\.|localhost|::1)/i.test(address)))
    return {
      targetKind: 'service',
      targetLabel: 'Psiphon',
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'inferred',
      note: 'Маршрут распознан по локальному SOCKS-выходу; состояние службы проверяется на сервере.',
    };
  return {
    targetKind: 'service',
    targetLabel: tag || protocol || 'Сервисный выход',
    targetNodeUuids: [],
    status: 'unknown',
    confidence: 'unknown',
    note: address
      ? `Выход ведёт на ${address}, но связать его с нодой NodeService однозначно не удалось.`
      : 'Профиль задаёт сервисный выход, но его назначение нельзя подтвердить без предположений.',
  };
}

function targetForRule(
  outboundTag: string,
  balancerTag: string,
  outbounds: Row[],
  balancers: Row[],
  nodes: RemnawaveTopologyNode[],
): Pick<
  RemnawaveTopologyRoute,
  'targetKind' | 'targetLabel' | 'targetNodeUuids' | 'status' | 'confidence' | 'note'
> {
  if (!balancerTag) return targetOf(outboundTag, outbounds, nodes);
  const balancer = balancers.find((item) => text(item.tag) === balancerTag);
  if (!balancer)
    return {
      targetKind: 'unknown',
      targetLabel: balancerTag,
      targetNodeUuids: [],
      status: 'unknown',
      confidence: 'unknown',
      note: 'Правило ссылается на балансировщик, которого нет в профиле.',
    };
  const selectors = texts(balancer.selector);
  const selected = outbounds.filter((item) => {
    const tag = text(item.tag);
    return selectors.some((selector) => tag === selector || tag.startsWith(selector));
  });
  const targets = selected.map((item) => targetOf(text(item.tag), outbounds, nodes));
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
    note: selected.length
      ? `Балансировщик «${balancerTag}» выбирает из ${selected.length} выходов.`
      : `У балансировщика «${balancerTag}» не найдено выходов по selector.`,
  };
}

export function buildRemnawaveTopology(
  source: RemnawaveTopologySource,
  linkedServerIds: ReadonlyMap<string, readonly string[]> = new Map(),
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

  const hosts: RemnawaveTopologyHost[] = source.hosts.map((raw, index) => {
    const inbound = row(raw.inbound);
    const inboundUuid = text(inbound.configProfileInboundUuid) || text(inbound.uuid) || null;
    const profileUuid = text(inbound.configProfileUuid) || text(inbound.profileUuid) || null;
    const matchingInbound = source.profiles
      .flatMap((profile) => rows(profile.inbounds).map((item) => ({ profile, item })))
      .find(({ item }) => text(item.uuid) === inboundUuid)?.item;
    const proto = protocolOf(matchingInbound ?? inbound);
    // Remnawave serves a host through its inbound. The host response can also contain
    // `nodes` in newer releases, but that list is not present in every API version and
    // is not the runtime source of truth. Match the host inbound against the active
    // inbounds reported by each node, as Remnawave itself does when starting profiles.
    const servingNodeUuids = inboundUuid
      ? nodes.filter((node) => node.inboundUuids.includes(inboundUuid)).map((node) => node.id)
      : [];
    const nodeUuids = inboundUuid ? servingNodeUuids : entityIds(raw.nodes);
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
      const target = targetForRule(directOutboundTag, balancerTag, outbounds, balancers, nodes);
      routes.push({
        id: `${profileUuid}:rule:${index}`,
        profileUuid,
        profileName,
        order: index,
        isDefault: false,
        match: matchBrief(rule),
        inboundTags,
        hostIds,
        outboundTag: outboundTag || 'не указан',
        ...target,
      });
    }
    const defaultOutbound = outbounds[0];
    if (defaultOutbound) {
      const outboundTag = text(defaultOutbound.tag) || text(defaultOutbound.protocol) || 'первый выход';
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
        ...targetOf(outboundTag, outbounds, nodes),
      });
    }
  }

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
    if (host.inboundUuid && host.nodeUuids.length === 0)
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

  return {
    generatedAt,
    hosts,
    nodes,
    routes,
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

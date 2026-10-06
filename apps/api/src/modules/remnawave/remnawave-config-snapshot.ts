import { createHash } from 'node:crypto';
import type { RemnawaveConfigSnapshot, RemnawaveTopology } from '@nodeservice/shared';

type Snapshot = {
  hosts: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
};
type Change = RemnawaveConfigSnapshot['changes'][number];

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  );
};

const sorted = <T extends { id: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));

/** Проекция не содержит runtime, онлайн, пользователей и исходные конфиги с секретами. */
export function safeTopologySnapshot(topology: RemnawaveTopology): Snapshot {
  return stable({
    hosts: sorted(topology.hosts).map(
      ({
        id,
        name,
        address,
        port,
        disabled,
        profileUuid,
        inboundUuid,
        inboundTag,
        protocol,
        network,
        security,
        nodeUuids,
      }) => ({
        id,
        name,
        address,
        port,
        disabled,
        profileUuid,
        inboundUuid,
        inboundTag,
        protocol,
        network,
        security,
        nodeUuids: [...nodeUuids].sort(),
      }),
    ),
    nodes: sorted(topology.nodes).map(
      ({ id, name, address, disabled, profileUuid, inboundUuids, serverIds }) => ({
        id,
        name,
        address,
        disabled,
        profileUuid,
        inboundUuids: [...inboundUuids].sort(),
        serverIds: [...serverIds].sort(),
      }),
    ),
    routes: sorted(topology.routes).map(
      ({
        id,
        profileUuid,
        profileName,
        order,
        isDefault,
        match,
        inboundTags,
        hostIds,
        outboundTag,
        outboundProtocol,
        outboundAddress,
        dialerProxy,
        targetKind,
        targetLabel,
        targetNodeUuids,
      }) => ({
        id,
        profileUuid,
        profileName,
        order,
        isDefault,
        match,
        inboundTags: [...inboundTags].sort(),
        hostIds: [...hostIds].sort(),
        outboundTag,
        outboundProtocol,
        outboundAddress,
        dialerProxy,
        targetKind,
        targetLabel,
        targetNodeUuids: [...targetNodeUuids].sort(),
      }),
    ),
    profiles: sorted(topology.profiles).map(
      ({ id, name, hostIds, nodeUuids, inbounds, outbounds, routingRules }) => ({
        id,
        name,
        hostIds: [...hostIds].sort(),
        nodeUuids: [...nodeUuids].sort(),
        inbounds,
        outbounds,
        routingRules,
      }),
    ),
  }) as Snapshot;
}

export function topologySnapshotHash(snapshot: Snapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

const entityLabel = (kind: Change['kind'], entity: Record<string, unknown>): string => {
  const name = typeof entity.name === 'string' ? entity.name : null;
  const profile = typeof entity.profileName === 'string' ? entity.profileName : null;
  const outbound = typeof entity.outboundTag === 'string' ? entity.outboundTag : null;
  return (
    name ?? (kind === 'route' ? `${profile ?? 'Профиль'} → ${outbound ?? 'outbound'}` : String(entity.id))
  );
};

const display = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  const json = JSON.stringify(value);
  return json.length > 220 ? `${json.slice(0, 217)}…` : json;
};

const FIELD_NAMES: Record<string, string> = {
  address: 'Адрес',
  port: 'Порт',
  disabled: 'Включено',
  profileUuid: 'Профиль',
  inboundUuid: 'Inbound',
  inboundTag: 'Тег inbound',
  protocol: 'Протокол',
  network: 'Транспорт',
  security: 'Защита',
  nodeUuids: 'Ноды',
  inboundUuids: 'Активные inbound',
  serverIds: 'Серверы NodeService',
  match: 'Условие routing',
  inboundTags: 'Входы правила',
  hostIds: 'Хосты',
  outboundTag: 'Outbound',
  outboundProtocol: 'Протокол выхода',
  outboundAddress: 'Адрес выхода',
  dialerProxy: 'Следующий outbound',
  targetKind: 'Тип назначения',
  targetLabel: 'Назначение',
  targetNodeUuids: 'Выходные ноды',
  inbounds: 'Inbounds',
  outbounds: 'Outbounds',
  routingRules: 'Правила routing',
};

/** Понятное изменение между двумя безопасными версиями; максимум 100 строк на один снимок. */
export function diffTopologySnapshots(previous: Snapshot | null, current: Snapshot): Change[] {
  if (!previous) return [];
  const changes: Change[] = [];
  const compare = (
    kind: Change['kind'],
    beforeRows: Array<Record<string, unknown>>,
    afterRows: Array<Record<string, unknown>>,
  ) => {
    const before = new Map(beforeRows.map((item) => [String(item.id), item]));
    const after = new Map(afterRows.map((item) => [String(item.id), item]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const oldItem = before.get(id);
      const newItem = after.get(id);
      const entity = newItem ?? oldItem;
      if (!entity) continue;
      const label = entityLabel(kind, entity);
      if (!oldItem || !newItem) {
        changes.push({
          kind,
          entityId: id,
          label,
          field: oldItem ? 'Удалено' : 'Добавлено',
          before: oldItem ? label : null,
          after: newItem ? label : null,
        });
        continue;
      }
      for (const field of new Set([...Object.keys(oldItem), ...Object.keys(newItem)])) {
        if (field === 'id' || field === 'name' || field === 'profileName') continue;
        const oldValue = oldItem[field];
        const newValue = newItem[field];
        if (JSON.stringify(stable(oldValue)) === JSON.stringify(stable(newValue))) continue;
        changes.push({
          kind,
          entityId: id,
          label,
          field: FIELD_NAMES[field] ?? field,
          before: display(oldValue),
          after: display(newValue),
        });
        if (changes.length >= 100) return;
      }
      if (changes.length >= 100) return;
    }
  };
  compare('host', previous.hosts, current.hosts);
  compare('node', previous.nodes, current.nodes);
  compare('route', previous.routes, current.routes);
  compare('profile', previous.profiles, current.profiles);
  return changes.slice(0, 100);
}

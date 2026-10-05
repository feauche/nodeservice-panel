import type { RemnawaveTopology, RemnawaveTopologyHost, RemnawaveTopologyRoute } from '@nodeservice/shared';
import {
  ArrowLeftIcon,
  CircleDotIcon,
  CloudIcon,
  NetworkIcon,
  RouteIcon,
  ServerIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Status = RemnawaveTopologyHost['status'];
type Selection = { kind: 'host' | 'node' | 'target'; id: string } | null;
type Point = { x: number; y: number };

const STATUS = {
  ok: { dot: 'bg-ok', border: 'border-ok/35', text: 'text-ok' },
  warning: { dot: 'bg-warn', border: 'border-warn/40', text: 'text-warn' },
  error: { dot: 'bg-crit', border: 'border-crit/45', text: 'text-crit' },
  unknown: { dot: 'bg-text-3', border: 'border-border', text: 'text-text-3' },
} satisfies Record<Status, { dot: string; border: string; text: string }>;

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
const yFor = (index: number, count: number, height: number): number =>
  count <= 1 ? height / 2 : 72 + (index * (height - 144)) / (count - 1);

function Edge({ from, to, status = 'ok' }: { from: Point; to: Point; status?: Status }) {
  const middle = (from.x + to.x) / 2;
  const path = `M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`;
  return (
    <g>
      <path d={path} fill="none" stroke="var(--border)" strokeWidth="1.5" strokeDasharray="6 7" />
      {status === 'error' && (
        <foreignObject x={middle - 10} y={(from.y + to.y) / 2 - 10} width="20" height="20">
          <XIcon className="size-5 text-crit drop-shadow-[0_0_8px_color-mix(in_srgb,var(--crit)_45%,transparent)]" />
        </foreignObject>
      )}
      {status === 'warning' && (
        <foreignObject x={middle - 9} y={(from.y + to.y) / 2 - 9} width="18" height="18">
          <TriangleAlertIcon className="size-[18px] fill-warn-soft text-warn" />
        </foreignObject>
      )}
    </g>
  );
}

function GraphCard({
  x,
  y,
  width,
  title,
  subtitle,
  status,
  icon: Icon,
  selected,
  onClick,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  subtitle: string;
  status: Status;
  icon: typeof ServerIcon;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'absolute flex h-16 items-center gap-2.5 rounded-xl border bg-surface px-3 text-left shadow-sm transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        STATUS[status].border,
        selected && 'ring-2 ring-brand/45',
      )}
      style={{ left: x, top: y - 32, width }}
    >
      <span
        className={cn(
          'grid size-8 flex-none place-items-center rounded-lg bg-surface-3',
          STATUS[status].text,
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className={cn('size-1.5 flex-none rounded-full', STATUS[status].dot)} aria-hidden="true" />
          <span className="truncate text-[12.5px] font-semibold text-foreground">{title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-text-3">{subtitle}</span>
      </span>
    </button>
  );
}

interface TargetGroup {
  id: string;
  label: string;
  kind: RemnawaveTopologyRoute['targetKind'];
  status: Status;
  routes: RemnawaveTopologyRoute[];
}

function groupTargets(routes: readonly RemnawaveTopologyRoute[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  for (const route of routes) {
    const key = `${route.targetKind}:${route.targetLabel}`;
    const found = groups.get(key);
    if (found) {
      found.routes.push(route);
      if (route.status === 'error') found.status = 'error';
      else if (route.status === 'warning' && found.status !== 'error') found.status = 'warning';
    } else {
      groups.set(key, {
        id: safeId(key),
        label: route.targetLabel,
        kind: route.targetKind,
        status: route.status,
        routes: [route],
      });
    }
  }
  return [...groups.values()];
}

function FocusedFlow({
  topology,
  selected,
  onBack,
}: {
  topology: RemnawaveTopology;
  selected: NonNullable<Selection>;
  onBack: () => void;
}) {
  const targetGroups = groupTargets(topology.routes);
  const chosenHost = selected.kind === 'host' ? topology.hosts.find((item) => item.id === selected.id) : null;
  const chosenNode = selected.kind === 'node' ? topology.nodes.find((item) => item.id === selected.id) : null;
  const chosenTarget =
    selected.kind === 'target' ? targetGroups.find((item) => item.id === selected.id) : null;
  const routes = topology.routes.filter((route) => {
    if (chosenHost) return route.hostIds.includes(chosenHost.id);
    if (chosenNode)
      return (
        route.targetNodeUuids.includes(chosenNode.id) ||
        route.hostIds.some((id) =>
          topology.hosts.find((host) => host.id === id)?.nodeUuids.includes(chosenNode.id),
        )
      );
    return chosenTarget?.routes.some((item) => item.id === route.id) ?? false;
  });
  const hosts = topology.hosts.filter((host) =>
    chosenHost ? host.id === chosenHost.id : routes.some((route) => route.hostIds.includes(host.id)),
  );
  const nodes = topology.nodes.filter((node) =>
    chosenNode
      ? node.id === chosenNode.id
      : hosts.some((host) => host.nodeUuids.includes(node.id)) ||
        routes.some((route) => route.targetNodeUuids.includes(node.id)),
  );
  const target = chosenTarget ?? groupTargets(routes)[0] ?? null;
  const bad: Status = [...hosts, ...nodes, ...(target ? [target] : [])].some(
    (item) => item.status === 'error',
  )
    ? 'error'
    : [...hosts, ...nodes, ...(target ? [target] : [])].some((item) => item.status === 'warning')
      ? 'warning'
      : 'ok';
  return (
    <div>
      <Button type="button" variant="ghost" onClick={onBack} className="mb-3 h-8 gap-1.5 px-2 text-[12px]">
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        Вся топология
      </Button>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface-2/35">
        <div className="relative h-[286px] min-w-[980px]">
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            <Edge from={{ x: 135, y: 143 }} to={{ x: 310, y: 143 }} status={hosts[0]?.status ?? 'unknown'} />
            <Edge from={{ x: 490, y: 143 }} to={{ x: 620, y: 143 }} status={nodes[0]?.status ?? 'unknown'} />
            <Edge from={{ x: 800, y: 143 }} to={{ x: 895, y: 143 }} status={target?.status ?? 'unknown'} />
          </svg>
          <GraphCard
            x={25}
            y={143}
            width={110}
            title="Клиент"
            subtitle="VPN-подключение"
            status="ok"
            icon={UsersIcon}
            selected={false}
            onClick={() => {}}
          />
          <GraphCard
            x={310}
            y={143}
            width={180}
            title={hosts[0]?.name ?? 'Хост не определён'}
            subtitle={hosts[0] ? `${hosts[0].address}:${hosts[0].port}` : 'нет подтверждённой связи'}
            status={hosts[0]?.status ?? 'unknown'}
            icon={NetworkIcon}
            selected={selected.kind === 'host'}
            onClick={() => {}}
          />
          <GraphCard
            x={620}
            y={143}
            width={180}
            title={nodes[0]?.name ?? 'Нода не определена'}
            subtitle={nodes[0]?.address ?? 'нет подтверждённой связи'}
            status={nodes[0]?.status ?? 'unknown'}
            icon={ServerIcon}
            selected={selected.kind === 'node'}
            onClick={() => {}}
          />
          <GraphCard
            x={895}
            y={143}
            width={170}
            title={target?.label ?? 'Выход не определён'}
            subtitle={routes[0]?.match.join(' · ') ?? 'нет правила'}
            status={target?.status ?? 'unknown'}
            icon={target?.kind === 'internet' ? CloudIcon : RouteIcon}
            selected={selected.kind === 'target'}
            onClick={() => {}}
          />
          {bad !== 'ok' && (
            <div
              className={cn(
                'absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 text-[11.5px]',
                STATUS[bad].text,
              )}
            >
              {bad === 'error' ? <XIcon className="size-4" /> : <TriangleAlertIcon className="size-4" />}
              Путь требует внимания — причина указана в разделе «Проблемы».
            </div>
          )}
        </div>
      </div>
      {routes.length > 0 && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {routes.slice(0, 6).map((route) => (
            <div key={route.id} className="rounded-xl border border-border bg-surface-2 px-3.5 py-3">
              <div className="flex items-center justify-between gap-2 text-[12px] font-semibold">
                <span className="truncate">{route.targetLabel}</span>
                <span className="flex-none text-[10.5px] text-text-3">
                  {route.confidence === 'confirmed' ? 'подтверждено' : 'по конфигурации'}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-4 text-text-3">{route.match.join(' · ')}</p>
              {route.note && <p className="mt-1 text-[11px] leading-4 text-warn">{route.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RemnawaveTopologyMap({ topology }: { topology: RemnawaveTopology }) {
  const [selected, setSelected] = useState<Selection>(null);
  const targets = useMemo(() => groupTargets(topology.routes), [topology.routes]);
  if (topology.hosts.length === 0 && topology.nodes.length === 0 && topology.routes.length === 0)
    return (
      <div className="rounded-xl border border-border bg-surface-2/35 px-4 py-12 text-center">
        <NetworkIcon className="mx-auto size-5 text-text-3" aria-hidden="true" />
        <h2 className="mt-2 font-heading text-[14px] font-bold">Карту пока не из чего собрать</h2>
        <p className="mx-auto mt-1 max-w-[520px] text-[12px] leading-5 text-text-3">
          Remnawave не вернула хосты, ноды и правила маршрутизации. После их настройки карта появится здесь
          автоматически.
        </p>
      </div>
    );
  if (selected)
    return <FocusedFlow topology={topology} selected={selected} onBack={() => setSelected(null)} />;

  const height = Math.max(
    470,
    Math.max(topology.hosts.length, topology.nodes.length, targets.length) * 88 + 110,
  );
  const hostPoints = new Map(
    topology.hosts.map((item, index) => [item.id, { x: 200, y: yFor(index, topology.hosts.length, height) }]),
  );
  const nodePoints = new Map(
    topology.nodes.map((item, index) => [item.id, { x: 410, y: yFor(index, topology.nodes.length, height) }]),
  );
  const targetPoints = new Map(
    targets.map((item, index) => [item.id, { x: 620, y: yFor(index, targets.length, height) }]),
  );
  const client = { x: 120, y: height / 2 };
  const internet = { x: 850, y: height / 2 };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-[15px] font-bold">Как идёт трафик</h2>
          <p className="mt-1 max-w-[760px] text-[12px] leading-5 text-text-3">{topology.note}</p>
        </div>
        <div className="flex gap-3 text-[11px] text-text-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-ok" />
            Работает
          </span>
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlertIcon className="size-3.5 text-warn" />
            Внимание
          </span>
          <span className="inline-flex items-center gap-1.5">
            <XIcon className="size-3.5 text-crit" />
            Разрыв
          </span>
        </div>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-border bg-surface-2/30">
        <div className="relative min-w-[1020px]" style={{ height }}>
          <div className="absolute inset-x-0 top-0 grid grid-cols-[150px_210px_210px_230px_210px] px-[5px] pt-4 text-center text-[10px] font-semibold tracking-[0.08em] text-text-3 uppercase">
            <span>Клиенты</span>
            <span>Хосты</span>
            <span>Ноды</span>
            <span>Маршруты</span>
            <span>Назначение</span>
          </div>
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            {topology.hosts.map((host) => {
              const point = hostPoints.get(host.id) as Point;
              return (
                <Edge
                  key={`client:${host.id}`}
                  from={client}
                  to={{ x: point.x, y: point.y }}
                  status={host.status}
                />
              );
            })}
            {topology.hosts.flatMap((host) =>
              host.nodeUuids.map((nodeId) => {
                const from = hostPoints.get(host.id);
                const to = nodePoints.get(nodeId);
                if (!from || !to) return null;
                return (
                  <Edge
                    key={`${host.id}:${nodeId}`}
                    from={{ x: from.x + 170, y: from.y }}
                    to={to}
                    status={nodeStatus(topology, nodeId)}
                  />
                );
              }),
            )}
            {targets.flatMap((target) => {
              const to = targetPoints.get(target.id);
              if (!to) return [];
              const nodeIds = new Set<string>();
              for (const route of target.routes)
                for (const hostId of route.hostIds)
                  for (const id of topology.hosts.find((host) => host.id === hostId)?.nodeUuids ?? [])
                    nodeIds.add(id);
              return [...nodeIds].map((nodeId) => {
                const from = nodePoints.get(nodeId);
                return from ? (
                  <Edge
                    key={`${nodeId}:${target.id}`}
                    from={{ x: from.x + 170, y: from.y }}
                    to={to}
                    status={target.status}
                  />
                ) : null;
              });
            })}
            {targets
              .filter((target) => target.kind === 'internet')
              .map((target) => {
                const from = targetPoints.get(target.id) as Point;
                return (
                  <Edge
                    key={`${target.id}:internet`}
                    from={{ x: from.x + 170, y: from.y }}
                    to={internet}
                    status={target.status}
                  />
                );
              })}
          </svg>
          <GraphCard
            x={20}
            y={client.y}
            width={100}
            title="Клиенты"
            subtitle="VPN-трафик"
            status="ok"
            icon={UsersIcon}
            selected={false}
            onClick={() => {}}
          />
          {topology.hosts.map((host) => {
            const point = hostPoints.get(host.id) as Point;
            return (
              <GraphCard
                key={host.id}
                x={point.x}
                y={point.y}
                width={170}
                title={host.name}
                subtitle={`${host.address}:${host.port}`}
                status={host.status}
                icon={NetworkIcon}
                selected={false}
                onClick={() => setSelected({ kind: 'host', id: host.id })}
              />
            );
          })}
          {topology.nodes.map((node) => {
            const point = nodePoints.get(node.id) as Point;
            return (
              <GraphCard
                key={node.id}
                x={point.x}
                y={point.y}
                width={170}
                title={node.name}
                subtitle={`${node.usersOnline ?? '—'} онлайн · ${node.address}`}
                status={node.status}
                icon={ServerIcon}
                selected={false}
                onClick={() => setSelected({ kind: 'node', id: node.id })}
              />
            );
          })}
          {targets.map((target) => {
            const point = targetPoints.get(target.id) as Point;
            return (
              <GraphCard
                key={target.id}
                x={point.x}
                y={point.y}
                width={170}
                title={target.label}
                subtitle={`${target.routes.length} ${target.routes.length === 1 ? 'правило' : 'правил'}`}
                status={target.status}
                icon={target.kind === 'internet' ? CloudIcon : RouteIcon}
                selected={false}
                onClick={() => setSelected({ kind: 'target', id: target.id })}
              />
            );
          })}
          <GraphCard
            x={850}
            y={internet.y}
            width={150}
            title="Интернет"
            subtitle="назначение"
            status="ok"
            icon={CloudIcon}
            selected={false}
            onClick={() => {}}
          />
        </div>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-3">
        <CircleDotIcon className="size-3.5" aria-hidden="true" />
        Нажмите на хост, ноду или выход, чтобы открыть аккуратную схему одного пути.
      </p>
    </div>
  );
}

function nodeStatus(topology: RemnawaveTopology, id: string): Status {
  return topology.nodes.find((node) => node.id === id)?.status ?? 'unknown';
}

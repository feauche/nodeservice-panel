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
import { useEffect, useMemo, useRef, useState } from 'react';
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
  count <= 1 ? height / 2 : 96 + (index * (height - 192)) / (count - 1);

function useMeasuredWidth(enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [enabled]);
  return [ref, width] as const;
}

function estimatedCardHeight(title: string, subtitle: string, width: number): number {
  const textWidth = Math.max(70, width - 74);
  const lines = (value: string, averageCharacterWidth: number) =>
    Math.max(
      1,
      Math.ceil(Array.from(value).length / Math.max(10, Math.floor(textWidth / averageCharacterWidth))),
    );
  return Math.max(80, 42 + lines(title, 7) * 17 + lines(subtitle, 6) * 16);
}

function Edge({
  from,
  to,
  status = 'ok',
  active = false,
  dimmed = false,
  animated = false,
}: {
  from: Point;
  to: Point;
  status?: Status;
  active?: boolean;
  dimmed?: boolean;
  animated?: boolean;
}) {
  const middle = (from.x + to.x) / 2;
  const path = `M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`;
  const color =
    status === 'error' ? 'var(--ns-crit)' : status === 'warning' ? 'var(--ns-warn)' : 'var(--ns-accent)';
  return (
    <g className="transition-opacity duration-200" opacity={dimmed ? 0.1 : 1}>
      <path
        className={animated ? 'ns-topology-flow' : undefined}
        d={path}
        fill="none"
        stroke={active ? color : 'var(--border)'}
        strokeWidth={active ? 2.5 : 1.5}
        strokeDasharray={animated ? undefined : '6 7'}
        strokeLinecap="round"
      />
      {status === 'error' && !dimmed && (
        <foreignObject x={middle - 10} y={(from.y + to.y) / 2 - 10} width="20" height="20">
          <XIcon className="size-5 text-crit drop-shadow-[0_0_8px_color-mix(in_srgb,var(--crit)_45%,transparent)]" />
        </foreignObject>
      )}
      {status === 'warning' && !dimmed && (
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
  highlighted = false,
  dimmed = false,
  onClick,
  onHoverChange,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  subtitle: string;
  status: Status;
  icon: typeof ServerIcon;
  selected: boolean;
  highlighted?: boolean;
  dimmed?: boolean;
  onClick: () => void;
  onHoverChange?: (hovered: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      onFocus={() => onHoverChange?.(true)}
      onBlur={() => onHoverChange?.(false)}
      className={cn(
        'absolute flex min-h-20 -translate-y-1/2 items-center gap-2.5 rounded-xl border bg-surface px-3.5 py-3 text-left shadow-sm transition-[color,background-color,border-color,box-shadow,opacity] duration-200 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        STATUS[status].border,
        (selected || highlighted) &&
          'z-10 ring-2 ring-brand/55 shadow-[0_0_24px_color-mix(in_srgb,var(--ns-accent)_14%,transparent)]',
        dimmed && 'opacity-30',
      )}
      style={{ left: x, top: y, width }}
    >
      <span
        className={cn(
          'grid size-8 flex-none place-items-center rounded-lg bg-surface-3',
          STATUS[status].text,
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1.5">
          <span
            className={cn('mt-[5px] size-1.5 flex-none rounded-full', STATUS[status].dot)}
            aria-hidden="true"
          />
          <span className="min-w-0 break-words text-[12.5px] leading-[17px] font-semibold text-foreground">
            {title}
          </span>
        </span>
        <span className="mt-1 block [overflow-wrap:anywhere] text-[10.5px] leading-4 text-text-3">
          {subtitle}
        </span>
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

function sourceNodeIds(target: TargetGroup, hosts: readonly RemnawaveTopologyHost[]): string[] {
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const ids = new Set<string>();
  for (const route of target.routes)
    for (const hostId of route.hostIds)
      for (const nodeId of hostById.get(hostId)?.nodeUuids ?? []) ids.add(nodeId);
  return [...ids];
}

function hostIsInSelection(
  selection: NonNullable<Selection>,
  host: RemnawaveTopologyHost,
  targets: readonly TargetGroup[],
): boolean {
  if (selection.kind === 'host') return selection.id === host.id;
  if (selection.kind === 'node') return host.nodeUuids.includes(selection.id);
  return (
    targets
      .find((target) => target.id === selection.id)
      ?.routes.some((route) => route.hostIds.includes(host.id)) ?? false
  );
}

function nodeIsInSelection(
  selection: NonNullable<Selection>,
  nodeId: string,
  hosts: readonly RemnawaveTopologyHost[],
  targets: readonly TargetGroup[],
): boolean {
  if (selection.kind === 'node') return selection.id === nodeId;
  if (selection.kind === 'host')
    return hosts.find((host) => host.id === selection.id)?.nodeUuids.includes(nodeId) ?? false;
  const target = targets.find((item) => item.id === selection.id);
  return target ? sourceNodeIds(target, hosts).includes(nodeId) : false;
}

function targetIsInSelection(
  selection: NonNullable<Selection>,
  target: TargetGroup,
  hosts: readonly RemnawaveTopologyHost[],
): boolean {
  if (selection.kind === 'target') return selection.id === target.id;
  if (selection.kind === 'host') return target.routes.some((route) => route.hostIds.includes(selection.id));
  return sourceNodeIds(target, hosts).includes(selection.id);
}

function orderByNeighbours<T extends { id: string }>(
  items: readonly T[],
  neighbours: (item: T) => readonly string[],
  neighbourPositions: ReadonlyMap<string, number>,
): T[] {
  const original = new Map(items.map((item, index) => [item.id, index]));
  return [...items].sort((left, right) => {
    const score = (item: T): number => {
      const positions = neighbours(item)
        .map((id) => neighbourPositions.get(id))
        .filter((value): value is number => value !== undefined);
      return positions.length
        ? positions.reduce((sum, value) => sum + value, 0) / positions.length
        : Number.POSITIVE_INFINITY;
    };
    return score(left) - score(right) || (original.get(left.id) ?? 0) - (original.get(right.id) ?? 0);
  });
}

function orderedLayers(
  hosts: readonly RemnawaveTopologyHost[],
  nodes: RemnawaveTopology['nodes'],
  targets: readonly TargetGroup[],
) {
  let orderedHosts = [...hosts];
  let orderedNodes = [...nodes];
  for (let pass = 0; pass < 4; pass += 1) {
    const hostPositions = new Map(orderedHosts.map((host, index) => [host.id, index]));
    orderedNodes = orderByNeighbours(
      orderedNodes,
      (node) => orderedHosts.filter((host) => host.nodeUuids.includes(node.id)).map((host) => host.id),
      hostPositions,
    );
    const nodePositions = new Map(orderedNodes.map((node, index) => [node.id, index]));
    orderedHosts = orderByNeighbours(orderedHosts, (host) => host.nodeUuids, nodePositions);
  }
  const nodePositions = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const orderedTargets = orderByNeighbours(
    targets,
    (target) => sourceNodeIds(target, orderedHosts),
    nodePositions,
  );
  return { hosts: orderedHosts, nodes: orderedNodes, targets: orderedTargets };
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
  const [frameRef, viewportWidth] = useMeasuredWidth();
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
  const hostTitle = hosts[0]?.name ?? 'Хост не определён';
  const hostSubtitle = hosts[0] ? `${hosts[0].address}:${hosts[0].port}` : 'нет подтверждённой связи';
  const nodeTitle = nodes[0]?.name ?? 'Нода не определена';
  const nodeSubtitle = nodes[0]?.address ?? 'нет подтверждённой связи';
  const targetTitle = target?.label ?? 'Выход не определён';
  const targetSubtitle = routes[0]?.match.join(' · ') ?? 'нет правила';
  const graphWidth = Math.max(1_260, viewportWidth);
  const sidePadding = 28;
  const clientWidth = 200;
  const cardWidth = 240;
  const tallestCard = Math.max(
    estimatedCardHeight('Клиент', 'VPN-подключение', clientWidth),
    estimatedCardHeight(hostTitle, hostSubtitle, cardWidth),
    estimatedCardHeight(nodeTitle, nodeSubtitle, cardWidth),
    estimatedCardHeight(targetTitle, targetSubtitle, cardWidth),
  );
  const graphHeight = Math.max(340, tallestCard + 180);
  const graphY = graphHeight / 2;
  const firstCenter = sidePadding + clientWidth / 2;
  const lastCenter = graphWidth - sidePadding - cardWidth / 2;
  const step = (lastCenter - firstCenter) / 3;
  const centers = Array.from({ length: 4 }, (_, index) => firstCenter + step * index);
  const clientLeft = centers[0] - clientWidth / 2;
  const hostLeft = centers[1] - cardWidth / 2;
  const nodeLeft = centers[2] - cardWidth / 2;
  const targetLeft = centers[3] - cardWidth / 2;
  return (
    <div>
      <Button
        type="button"
        variant="outline"
        onClick={onBack}
        className="mb-4 h-10 gap-2 border-brand/40 bg-brand-soft px-3.5 text-[12.5px] font-semibold text-brand shadow-sm hover:border-brand/60 hover:bg-brand-soft"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Вернуться ко всей топологии
      </Button>
      <div ref={frameRef} className="overflow-x-auto rounded-xl border border-border bg-surface-2/35">
        <div className="relative" style={{ height: graphHeight, width: graphWidth }}>
          {['Клиент', 'Хост', 'Нода', 'Назначение'].map((label, index) => (
            <span
              key={label}
              className="absolute top-5 w-[220px] -translate-x-1/2 text-center text-[10px] font-semibold tracking-[0.08em] text-text-3 uppercase"
              style={{ left: centers[index] }}
            >
              {label}
            </span>
          ))}
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            <Edge
              from={{ x: clientLeft + clientWidth, y: graphY }}
              to={{ x: hostLeft, y: graphY }}
              status={hosts[0]?.status ?? 'unknown'}
              active
              animated
            />
            <Edge
              from={{ x: hostLeft + cardWidth, y: graphY }}
              to={{ x: nodeLeft, y: graphY }}
              status={nodes[0]?.status ?? 'unknown'}
              active
              animated
            />
            <Edge
              from={{ x: nodeLeft + cardWidth, y: graphY }}
              to={{ x: targetLeft, y: graphY }}
              status={target?.status ?? 'unknown'}
              active
              animated
            />
          </svg>
          <GraphCard
            x={clientLeft}
            y={graphY}
            width={clientWidth}
            title="Клиент"
            subtitle="VPN-подключение"
            status="ok"
            icon={UsersIcon}
            selected={false}
            onClick={() => {}}
          />
          <GraphCard
            x={hostLeft}
            y={graphY}
            width={cardWidth}
            title={hostTitle}
            subtitle={hostSubtitle}
            status={hosts[0]?.status ?? 'unknown'}
            icon={NetworkIcon}
            selected={selected.kind === 'host'}
            onClick={() => {}}
          />
          <GraphCard
            x={nodeLeft}
            y={graphY}
            width={cardWidth}
            title={nodeTitle}
            subtitle={nodeSubtitle}
            status={nodes[0]?.status ?? 'unknown'}
            icon={ServerIcon}
            selected={selected.kind === 'node'}
            onClick={() => {}}
          />
          <GraphCard
            x={targetLeft}
            y={graphY}
            width={cardWidth}
            title={targetTitle}
            subtitle={targetSubtitle}
            status={target?.status ?? 'unknown'}
            icon={target?.kind === 'internet' ? CloudIcon : RouteIcon}
            selected={selected.kind === 'target'}
            onClick={() => {}}
          />
          {bad !== 'ok' && (
            <div
              className={cn(
                'absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 text-[11.5px]',
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
              <div className="flex items-start justify-between gap-2 text-[12px] font-semibold">
                <span className="min-w-0 break-words leading-4">{route.targetLabel}</span>
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
  const [hovered, setHovered] = useState<Selection>(null);
  const targets = useMemo(() => groupTargets(topology.routes), [topology.routes]);
  const layers = useMemo(
    () => orderedLayers(topology.hosts, topology.nodes, targets),
    [topology.hosts, topology.nodes, targets],
  );
  const hasTopology = topology.hosts.length > 0 || topology.nodes.length > 0 || topology.routes.length > 0;
  const graphVisible = hasTopology && selected === null;
  const [graphFrameRef, viewportWidth] = useMeasuredWidth(graphVisible);
  if (!hasTopology)
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

  const graphWidth = Math.max(1_500, viewportWidth);
  const sidePadding = 28;
  const clientWidth = 200;
  const cardWidth = 220;
  const internetWidth = 190;
  const tallestCard = Math.max(
    estimatedCardHeight('Клиенты', 'VPN-трафик', clientWidth),
    estimatedCardHeight('Интернет', 'назначение', internetWidth),
    ...layers.hosts.map((host) => estimatedCardHeight(host.name, `${host.address}:${host.port}`, cardWidth)),
    ...layers.nodes.map((node) =>
      estimatedCardHeight(node.name, `${node.usersOnline ?? '—'} онлайн · ${node.address}`, cardWidth),
    ),
    ...layers.targets.map((target) =>
      estimatedCardHeight(
        target.label,
        `${target.routes.length} ${target.routes.length === 1 ? 'правило' : 'правил'}`,
        cardWidth,
      ),
    ),
  );
  const rowStep = Math.max(112, tallestCard + 24);
  const height = Math.max(
    520,
    Math.max(layers.hosts.length, layers.nodes.length, layers.targets.length) * rowStep + 150,
  );
  const firstCenter = sidePadding + clientWidth / 2;
  const lastCenter = graphWidth - sidePadding - internetWidth / 2;
  const columnStep = (lastCenter - firstCenter) / 4;
  const columnCenters = Array.from({ length: 5 }, (_, index) => firstCenter + columnStep * index);
  const clientLeft = columnCenters[0] - clientWidth / 2;
  const hostLeft = columnCenters[1] - cardWidth / 2;
  const nodeLeft = columnCenters[2] - cardWidth / 2;
  const targetLeft = columnCenters[3] - cardWidth / 2;
  const internetLeft = columnCenters[4] - internetWidth / 2;
  const hostPoints = new Map(
    layers.hosts.map((item, index) => [
      item.id,
      { x: hostLeft, y: yFor(index, layers.hosts.length, height) },
    ]),
  );
  const nodePoints = new Map(
    layers.nodes.map((item, index) => [
      item.id,
      { x: nodeLeft, y: yFor(index, layers.nodes.length, height) },
    ]),
  );
  const targetPoints = new Map(
    layers.targets.map((item, index) => [
      item.id,
      { x: targetLeft, y: yFor(index, layers.targets.length, height) },
    ]),
  );
  const client = { x: clientLeft + clientWidth, y: height / 2 };
  const internet = { x: internetLeft, y: height / 2 };
  const internetHighlighted = hovered
    ? layers.targets.some(
        (target) => target.kind === 'internet' && targetIsInSelection(hovered, target, layers.hosts),
      )
    : false;

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
      <div ref={graphFrameRef} className="overflow-x-auto rounded-2xl border border-border bg-surface-2/30">
        <div className="relative" style={{ height, width: graphWidth }}>
          {['Клиенты', 'Хосты', 'Ноды', 'Маршруты', 'Назначение'].map((label, index) => (
            <span
              key={label}
              className="absolute top-4 w-[180px] -translate-x-1/2 text-center text-[10px] font-semibold tracking-[0.08em] text-text-3 uppercase"
              style={{ left: columnCenters[index] }}
            >
              {label}
            </span>
          ))}
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            {layers.hosts.map((host) => {
              const point = hostPoints.get(host.id) as Point;
              const active = hovered ? hostIsInSelection(hovered, host, layers.targets) : false;
              return (
                <Edge
                  key={`client:${host.id}`}
                  from={client}
                  to={{ x: point.x, y: point.y }}
                  status={host.status}
                  active={active}
                  dimmed={hovered !== null && !active}
                  animated={active}
                />
              );
            })}
            {layers.hosts.flatMap((host) =>
              host.nodeUuids.map((nodeId) => {
                const from = hostPoints.get(host.id);
                const to = nodePoints.get(nodeId);
                if (!from || !to) return null;
                const active = hovered
                  ? hostIsInSelection(hovered, host, layers.targets) &&
                    nodeIsInSelection(hovered, nodeId, layers.hosts, layers.targets)
                  : false;
                return (
                  <Edge
                    key={`${host.id}:${nodeId}`}
                    from={{ x: from.x + cardWidth, y: from.y }}
                    to={to}
                    status={nodeStatus(topology, nodeId)}
                    active={active}
                    dimmed={hovered !== null && !active}
                    animated={active}
                  />
                );
              }),
            )}
            {layers.targets.flatMap((target) => {
              const to = targetPoints.get(target.id);
              if (!to) return [];
              return sourceNodeIds(target, layers.hosts).map((nodeId) => {
                const from = nodePoints.get(nodeId);
                const active = hovered
                  ? nodeIsInSelection(hovered, nodeId, layers.hosts, layers.targets) &&
                    targetIsInSelection(hovered, target, layers.hosts)
                  : false;
                return from ? (
                  <Edge
                    key={`${nodeId}:${target.id}`}
                    from={{ x: from.x + cardWidth, y: from.y }}
                    to={to}
                    status={target.status}
                    active={active}
                    dimmed={hovered !== null && !active}
                    animated={active}
                  />
                ) : null;
              });
            })}
            {layers.targets
              .filter((target) => target.kind === 'internet')
              .map((target) => {
                const from = targetPoints.get(target.id) as Point;
                const active = hovered ? targetIsInSelection(hovered, target, layers.hosts) : false;
                return (
                  <Edge
                    key={`${target.id}:internet`}
                    from={{ x: from.x + cardWidth, y: from.y }}
                    to={internet}
                    status={target.status}
                    active={active}
                    dimmed={hovered !== null && !active}
                    animated={active}
                  />
                );
              })}
          </svg>
          <GraphCard
            x={clientLeft}
            y={client.y}
            width={clientWidth}
            title="Клиенты"
            subtitle="VPN-трафик"
            status="ok"
            icon={UsersIcon}
            selected={false}
            highlighted={hovered !== null}
            onClick={() => {}}
          />
          {layers.hosts.map((host) => {
            const point = hostPoints.get(host.id) as Point;
            const highlighted = hovered ? hostIsInSelection(hovered, host, layers.targets) : false;
            return (
              <GraphCard
                key={host.id}
                x={point.x}
                y={point.y}
                width={cardWidth}
                title={host.name}
                subtitle={`${host.address}:${host.port}`}
                status={host.status}
                icon={NetworkIcon}
                selected={false}
                highlighted={highlighted}
                dimmed={hovered !== null && !highlighted}
                onClick={() => setSelected({ kind: 'host', id: host.id })}
                onHoverChange={(value) => setHovered(value ? { kind: 'host', id: host.id } : null)}
              />
            );
          })}
          {layers.nodes.map((node) => {
            const point = nodePoints.get(node.id) as Point;
            const highlighted = hovered
              ? nodeIsInSelection(hovered, node.id, layers.hosts, layers.targets)
              : false;
            return (
              <GraphCard
                key={node.id}
                x={point.x}
                y={point.y}
                width={cardWidth}
                title={node.name}
                subtitle={`${node.usersOnline ?? '—'} онлайн · ${node.address}`}
                status={node.status}
                icon={ServerIcon}
                selected={false}
                highlighted={highlighted}
                dimmed={hovered !== null && !highlighted}
                onClick={() => setSelected({ kind: 'node', id: node.id })}
                onHoverChange={(value) => setHovered(value ? { kind: 'node', id: node.id } : null)}
              />
            );
          })}
          {layers.targets.map((target) => {
            const point = targetPoints.get(target.id) as Point;
            const highlighted = hovered ? targetIsInSelection(hovered, target, layers.hosts) : false;
            return (
              <GraphCard
                key={target.id}
                x={point.x}
                y={point.y}
                width={cardWidth}
                title={target.label}
                subtitle={`${target.routes.length} ${target.routes.length === 1 ? 'правило' : 'правил'}`}
                status={target.status}
                icon={target.kind === 'internet' ? CloudIcon : RouteIcon}
                selected={false}
                highlighted={highlighted}
                dimmed={hovered !== null && !highlighted}
                onClick={() => setSelected({ kind: 'target', id: target.id })}
                onHoverChange={(value) => setHovered(value ? { kind: 'target', id: target.id } : null)}
              />
            );
          })}
          <GraphCard
            x={internetLeft}
            y={internet.y}
            width={internetWidth}
            title="Интернет"
            subtitle="назначение"
            status="ok"
            icon={CloudIcon}
            selected={false}
            highlighted={internetHighlighted}
            dimmed={hovered !== null && !internetHighlighted}
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

import type {
  RemnawaveTopology,
  RemnawaveTopologyHost,
  RemnawaveTopologyNode,
  RemnawaveTopologyRoute,
} from '@nodeservice/shared';
import {
  ArrowLeftIcon,
  CircleDotIcon,
  CloudIcon,
  Maximize2Icon,
  MinusIcon,
  MoveIcon,
  NetworkIcon,
  PlusIcon,
  RouteIcon,
  ServerIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Status = RemnawaveTopologyHost['status'];
type Selection = { kind: 'host' | 'node' | 'exit'; id: string } | null;
type Point = { x: number; y: number };

interface ExitGroup {
  id: string;
  label: string;
  kind: RemnawaveTopologyRoute['targetKind'];
  status: Status;
  nodeId: string | null;
  routes: RemnawaveTopologyRoute[];
}

interface SelectionContext {
  hostIds: Set<string>;
  nodeIds: Set<string>;
  exitIds: Set<string>;
  routeIds: Set<string>;
  hostNodeEdgeIds: Set<string>;
  routeEdgeIds: Set<string>;
  reachesInternet: boolean;
}

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

const MIN_GRAPH_SCALE = 0.18;
const MAX_GRAPH_SCALE = 1.8;

/** Масштабируемое полотно: колесо меняет масштаб относительно курсора, фон перетаскивается мышью. */
function GraphViewport({
  width,
  height,
  compact = false,
  children,
}: {
  width: number;
  height: number;
  compact?: boolean;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });

  const fitGraph = useCallback(() => {
    if (!frame.width || !frame.height) return;
    const inset = compact ? 32 : 52;
    const scale = Math.min(
      1,
      Math.max(MIN_GRAPH_SCALE, Math.min((frame.width - inset) / width, (frame.height - inset) / height)),
    );
    setView({
      scale,
      x: (frame.width - width * scale) / 2,
      y: (frame.height - height * scale) / 2,
    });
  }, [compact, frame.height, frame.width, height, width]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const update = () => setFrame({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => fitGraph(), [fitGraph]);

  const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const bounds = frameRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setView((current) => {
      const scale = Math.min(MAX_GRAPH_SCALE, Math.max(MIN_GRAPH_SCALE, nextScale));
      const anchorX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
      const anchorY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
      const worldX = (anchorX - current.x) / current.scale;
      const worldY = (anchorY - current.y) / current.scale;
      return { scale, x: anchorX - worldX * scale, y: anchorY - worldY * scale };
    });
  }, []);

  return (
    <div
      ref={frameRef}
      data-testid="topology-viewport"
      className={cn(
        'relative isolate overflow-hidden rounded-2xl border border-border bg-surface-2/30 select-none',
        compact ? 'h-[430px] max-md:h-[360px]' : 'h-[clamp(520px,68dvh,760px)] max-md:h-[62dvh]',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
      style={{ touchAction: 'none' }}
      onWheel={(event) => {
        event.preventDefault();
        zoomAt(view.scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: view.x,
          top: view.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = dragRef.current;
        if (!start || start.pointerId !== event.pointerId) return;
        setView((current) => ({
          ...current,
          x: start.left + event.clientX - start.x,
          y: start.top + event.clientY - start.y,
        }));
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
      }}
    >
      <div
        className="absolute inset-0 opacity-35 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:24px_24px]"
        aria-hidden="true"
      />
      <div
        className="absolute top-0 left-0 will-change-transform"
        style={{
          width,
          height,
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {children}
      </div>
      <div className="absolute top-3 right-3 z-30 flex items-center gap-1 rounded-xl border border-border bg-surface/95 p-1 shadow-pop">
        <button
          type="button"
          aria-label="Уменьшить граф"
          className="grid size-8 cursor-pointer place-items-center rounded-lg text-text-2 hover:bg-surface-3 hover:text-foreground"
          onClick={() => zoomAt(view.scale / 1.2)}
        >
          <MinusIcon className="size-4" />
        </button>
        <span className="w-12 text-center font-mono text-[10px] text-text-3">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          aria-label="Увеличить граф"
          className="grid size-8 cursor-pointer place-items-center rounded-lg text-text-2 hover:bg-surface-3 hover:text-foreground"
          onClick={() => zoomAt(view.scale * 1.2)}
        >
          <PlusIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Показать весь граф"
          title="Показать весь граф"
          className="grid size-8 cursor-pointer place-items-center rounded-lg text-text-2 hover:bg-surface-3 hover:text-foreground"
          onClick={fitGraph}
        >
          <Maximize2Icon className="size-3.5" />
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 z-20 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 text-[10px] text-text-3 shadow-sm max-sm:hidden">
        <MoveIcon className="size-3.5" /> Зажмите и тяните · колесо меняет масштаб
      </div>
    </div>
  );
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
    <g className="transition-opacity duration-200" opacity={dimmed ? 0.08 : 1}>
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
        dimmed && 'opacity-25',
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

function worseStatus(current: Status, candidate: Status): Status {
  const rank: Record<Status, number> = { ok: 0, unknown: 1, warning: 2, error: 3 };
  return rank[candidate] > rank[current] ? candidate : current;
}

function sourceNodeIds(route: RemnawaveTopologyRoute, hosts: readonly RemnawaveTopologyHost[]): string[] {
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  return [...new Set(route.hostIds.flatMap((hostId) => hostById.get(hostId)?.nodeUuids ?? []))];
}

const edgeId = (...parts: string[]) => JSON.stringify(parts);

function routeSourceLinks(
  route: RemnawaveTopologyRoute,
  hosts: readonly RemnawaveTopologyHost[],
): Array<{ hostId: string; nodeId: string }> {
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  return route.hostIds.flatMap((hostId) =>
    (hostById.get(hostId)?.nodeUuids ?? []).map((nodeId) => ({ hostId, nodeId })),
  );
}

function selectedSourceNodeIds(
  route: RemnawaveTopologyRoute,
  selection: NonNullable<Selection>,
  hosts: readonly RemnawaveTopologyHost[],
): string[] {
  if (selection.kind === 'host') {
    if (!route.hostIds.includes(selection.id)) return [];
    return hosts.find((host) => host.id === selection.id)?.nodeUuids ?? [];
  }
  const sources = sourceNodeIds(route, hosts);
  if (selection.kind === 'node') return sources.includes(selection.id) ? [selection.id] : [];
  return sources;
}

function groupExits(
  routes: readonly RemnawaveTopologyRoute[],
  nodes: readonly RemnawaveTopologyNode[],
): ExitGroup[] {
  const groups = new Map<string, ExitGroup>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const add = (
    key: string,
    route: RemnawaveTopologyRoute,
    label: string,
    nodeId: string | null,
    status: Status,
  ) => {
    const found = groups.get(key);
    if (found) {
      if (!found.routes.some((item) => item.id === route.id)) found.routes.push(route);
      found.status = worseStatus(found.status, status);
      return;
    }
    groups.set(key, {
      id: safeId(key),
      label,
      kind: route.targetKind,
      status,
      nodeId,
      routes: [route],
    });
  };

  for (const route of routes) {
    if (route.targetKind === 'internet') continue;
    if (route.targetKind === 'node' && route.targetNodeUuids.length) {
      for (const nodeId of route.targetNodeUuids) {
        const node = nodeById.get(nodeId);
        add(`node:${nodeId}`, route, node?.name ?? route.targetLabel, nodeId, node?.status ?? route.status);
      }
      continue;
    }
    const key = `${route.targetKind}:${route.targetLabel}`;
    add(key, route, route.targetLabel, null, route.status);
  }
  return [...groups.values()];
}

function exitSubtitle(exit: ExitGroup, topology: RemnawaveTopology): string {
  if (exit.nodeId) {
    const node = topology.nodes.find((item) => item.id === exit.nodeId);
    return node ? `${node.usersOnline ?? '—'} онлайн · ${node.address}` : 'выходная нода';
  }
  if (exit.kind === 'blocked') return 'трафик будет остановлен';
  if (exit.kind === 'unknown') return 'назначение не подтверждено';
  return 'сервис исходящего трафика';
}

function routeExitIds(route: RemnawaveTopologyRoute, exits: readonly ExitGroup[]): string[] {
  return exits
    .filter((exit) => exit.routes.some((candidate) => candidate.id === route.id))
    .map((exit) => exit.id);
}

function reachesInternet(route: RemnawaveTopologyRoute): boolean {
  return route.targetKind === 'internet' || route.targetKind === 'node' || route.targetKind === 'service';
}

function contextForSelection(
  selection: NonNullable<Selection>,
  topology: RemnawaveTopology,
  exits: readonly ExitGroup[],
): SelectionContext {
  let routes: RemnawaveTopologyRoute[] = [];
  if (selection.kind === 'host')
    routes = topology.routes.filter((route) => route.hostIds.includes(selection.id));
  else if (selection.kind === 'node')
    routes = topology.routes.filter((route) => sourceNodeIds(route, topology.hosts).includes(selection.id));
  else routes = exits.find((exit) => exit.id === selection.id)?.routes ?? [];

  const sourceLinks = routes.flatMap((route) =>
    routeSourceLinks(route, topology.hosts)
      .filter((link) => selection.kind !== 'host' || link.hostId === selection.id)
      .filter((link) => selection.kind !== 'node' || link.nodeId === selection.id)
      .map((link) => ({ ...link, route })),
  );
  const hostIds = new Set(sourceLinks.map((link) => link.hostId));
  const nodeIds = new Set(sourceLinks.map((link) => link.nodeId));
  if (selection.kind === 'host') hostIds.add(selection.id);
  if (selection.kind === 'node') nodeIds.add(selection.id);
  const hostNodeEdgeIds = new Set(sourceLinks.map((link) => edgeId(link.hostId, link.nodeId)));
  const exitIds = new Set(routes.flatMap((route) => routeExitIds(route, exits)));
  if (selection.kind === 'exit') exitIds.add(selection.id);
  const routeEdgeIds = new Set<string>();
  for (const { route, nodeId } of sourceLinks) {
    if (route.targetKind === 'internet') routeEdgeIds.add(edgeId(route.id, nodeId, 'internet'));
    else for (const exitId of routeExitIds(route, exits)) routeEdgeIds.add(edgeId(route.id, nodeId, exitId));
  }
  return {
    hostIds,
    nodeIds,
    exitIds,
    routeIds: new Set(routes.map((route) => route.id)),
    hostNodeEdgeIds,
    routeEdgeIds,
    reachesInternet: routes.some(reachesInternet),
  };
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

function orderedLayers(topology: RemnawaveTopology, exits: readonly ExitGroup[]) {
  const entryIds = new Set(topology.hosts.flatMap((host) => host.nodeUuids));
  let hosts = [...topology.hosts];
  let entryNodes = topology.nodes.filter((node) => entryIds.has(node.id));
  for (let pass = 0; pass < 4; pass += 1) {
    const hostPositions = new Map(hosts.map((host, index) => [host.id, index]));
    entryNodes = orderByNeighbours(
      entryNodes,
      (node) => hosts.filter((host) => host.nodeUuids.includes(node.id)).map((host) => host.id),
      hostPositions,
    );
    const nodePositions = new Map(entryNodes.map((node, index) => [node.id, index]));
    hosts = orderByNeighbours(hosts, (host) => host.nodeUuids, nodePositions);
  }
  const nodePositions = new Map(entryNodes.map((node, index) => [node.id, index]));
  const orderedExits = orderByNeighbours(
    exits,
    (exit) => [...new Set(exit.routes.flatMap((route) => sourceNodeIds(route, hosts)))],
    nodePositions,
  );
  return { hosts, entryNodes, exits: orderedExits };
}

function routeDescription(
  route: RemnawaveTopologyRoute,
  entryNode: RemnawaveTopologyNode | null,
  exitNode: RemnawaveTopologyNode | null,
): string {
  const from = entryNode ? `на входную ноду «${entryNode.name}»` : 'на входную ноду';
  const condition = route.isDefault
    ? 'Весь трафик, для которого не нашлось отдельного условия,'
    : `Трафик по условию «${route.match.join(' · ')}»`;
  if (route.targetKind === 'node')
    return `${condition} приходит ${from}, затем Xray передаёт его на выходную ноду «${exitNode?.name ?? route.targetLabel}».`;
  if (route.targetKind === 'internet')
    return `${condition} приходит ${from} и выходит в интернет прямо с неё.`;
  if (route.targetKind === 'blocked')
    return `${condition} приходит ${from}, после чего Xray намеренно отклоняет соединение.`;
  return `${condition} приходит ${from}, затем Xray передаёт его в сервис «${route.targetLabel}».`;
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
  const exits = groupExits(topology.routes, topology.nodes);
  const context = contextForSelection(selected, topology, exits);
  const routes = topology.routes.filter((route) => context.routeIds.has(route.id));
  const primaryRoute = routes[0] ?? null;
  const selectedHost =
    selected.kind === 'host' ? topology.hosts.find((host) => host.id === selected.id) : null;
  const host =
    selectedHost ??
    topology.hosts.find(
      (item) =>
        primaryRoute?.hostIds.includes(item.id) &&
        (selected.kind !== 'node' || item.nodeUuids.includes(selected.id)),
    ) ??
    null;
  const primarySources = primaryRoute ? selectedSourceNodeIds(primaryRoute, selected, topology.hosts) : [];
  const entryNode =
    topology.nodes.find(
      (node) => selected.kind === 'node' && node.id === selected.id && primarySources.includes(node.id),
    ) ??
    topology.nodes.find((node) => primarySources.includes(node.id)) ??
    null;
  const exitNode = topology.nodes.find((node) => primaryRoute?.targetNodeUuids.includes(node.id)) ?? null;
  const chosenExit =
    exits.find((exit) => selected.kind === 'exit' && exit.id === selected.id) ??
    exits.find((exit) => primaryRoute && exit.routes.some((route) => route.id === primaryRoute.id)) ??
    null;
  const exitTitle = primaryRoute
    ? primaryRoute.targetKind === 'internet'
      ? 'Напрямую'
      : (exitNode?.name ?? chosenExit?.label ?? primaryRoute.targetLabel)
    : 'Выход не определён';
  const exitSubtitleText = primaryRoute
    ? primaryRoute.targetKind === 'node'
      ? (exitNode?.address ?? 'адрес не подтверждён')
      : primaryRoute.targetKind === 'internet'
        ? 'с входной ноды'
        : primaryRoute.targetKind === 'blocked'
          ? 'трафик останавливается'
          : 'сервис исходящего трафика'
    : 'нет подтверждённой связи';
  const destinationTitle =
    primaryRoute?.targetKind === 'blocked'
      ? 'Соединение отклонено'
      : primaryRoute?.targetKind === 'unknown'
        ? 'Назначение неизвестно'
        : 'Интернет';
  const destinationStatus: Status =
    primaryRoute?.targetKind === 'blocked'
      ? 'warning'
      : primaryRoute?.targetKind === 'unknown'
        ? 'unknown'
        : (primaryRoute?.status ?? 'unknown');
  const graphWidth = Math.max(1_500, viewportWidth);
  const sidePadding = 30;
  const cardWidth = 230;
  const tallestCard = Math.max(
    estimatedCardHeight('Клиент', 'VPN-подключение', cardWidth),
    estimatedCardHeight(
      host?.name ?? 'Хост не определён',
      host ? `${host.address}:${host.port}` : '',
      cardWidth,
    ),
    estimatedCardHeight(entryNode?.name ?? 'Входная нода не определена', entryNode?.address ?? '', cardWidth),
    estimatedCardHeight(exitTitle, exitSubtitleText, cardWidth),
    estimatedCardHeight(destinationTitle, 'куда приходит трафик', cardWidth),
  );
  const graphHeight = Math.max(350, tallestCard + 190);
  const graphY = graphHeight / 2;
  const firstCenter = sidePadding + cardWidth / 2;
  const lastCenter = graphWidth - sidePadding - cardWidth / 2;
  const step = (lastCenter - firstCenter) / 4;
  const centers = Array.from({ length: 5 }, (_, index) => firstCenter + step * index);
  const lefts = centers.map((center) => center - cardWidth / 2);
  const graphStatus = [host?.status, entryNode?.status, primaryRoute?.status]
    .filter((status): status is Status => Boolean(status))
    .reduce<Status>(worseStatus, 'ok');
  const path = topology.paths.find(
    (candidate) =>
      candidate.hostId === host?.id &&
      candidate.entryNodeUuid === entryNode?.id &&
      candidate.routeId === primaryRoute?.id &&
      (candidate.exitNodeUuid === exitNode?.id || (!candidate.exitNodeUuid && !exitNode)),
  );
  const visibleSegments = path?.segments.filter((segment) => segment.runtime) ?? [];

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
      <div ref={frameRef}>
        <GraphViewport width={graphWidth} height={graphHeight} compact>
          {['Клиент', 'Хост', 'Входная нода', 'Выход', 'Назначение'].map((label, index) => (
            <span
              key={label}
              className="absolute top-5 w-[220px] -translate-x-1/2 text-center text-[10px] font-semibold tracking-[0.08em] text-text-3 uppercase"
              style={{ left: centers[index] }}
            >
              {label}
            </span>
          ))}
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            {lefts.slice(1).map((left, index) => (
              <Edge
                key={left}
                from={{ x: lefts[index] + cardWidth, y: graphY }}
                to={{ x: left, y: graphY }}
                status={
                  index === 0
                    ? (host?.status ?? 'unknown')
                    : index === 1
                      ? (entryNode?.status ?? 'unknown')
                      : index === 2
                        ? (primaryRoute?.status ?? 'unknown')
                        : destinationStatus
                }
                active
                animated
              />
            ))}
          </svg>
          {path?.segments.slice(1, 5).map((segment, index) => {
            const runtime = segment.runtime;
            if (!runtime) return null;
            return (
              <div
                key={segment.id}
                className={cn(
                  'absolute top-[calc(50%+54px)] w-[190px] -translate-x-1/2 rounded-lg border bg-surface/95 px-2.5 py-2 text-center shadow-sm',
                  STATUS[runtime.status].border,
                )}
                style={{
                  left:
                    ((centers[Math.min(index + 1, 4)] ?? centers[4] ?? 0) +
                      (centers[Math.min(index + 2, 4)] ?? centers[4] ?? 0)) /
                    2,
                }}
                title={`${runtime.detail} · ${new Date(runtime.checkedAt).toLocaleString('ru-RU')}`}
              >
                <div className={cn('text-[10.5px] font-semibold', STATUS[runtime.status].text)}>
                  {runtime.label}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[9.5px] leading-3.5 text-text-3">
                  {runtime.detail}
                </div>
              </div>
            );
          })}
          <GraphCard
            x={lefts[0]}
            y={graphY}
            width={cardWidth}
            title="Клиент"
            subtitle="VPN-подключение"
            status="ok"
            icon={UsersIcon}
            selected={false}
            onClick={() => {}}
          />
          <GraphCard
            x={lefts[1]}
            y={graphY}
            width={cardWidth}
            title={host?.name ?? 'Хост не определён'}
            subtitle={host ? `${host.address}:${host.port}` : 'нет подтверждённой связи'}
            status={host?.status ?? 'unknown'}
            icon={NetworkIcon}
            selected={selected.kind === 'host'}
            onClick={() => {}}
          />
          <GraphCard
            x={lefts[2]}
            y={graphY}
            width={cardWidth}
            title={entryNode?.name ?? 'Входная нода не определена'}
            subtitle={entryNode?.address ?? 'нет подтверждённой связи'}
            status={entryNode?.status ?? 'unknown'}
            icon={ServerIcon}
            selected={selected.kind === 'node'}
            onClick={() => {}}
          />
          <GraphCard
            x={lefts[3]}
            y={graphY}
            width={cardWidth}
            title={exitTitle}
            subtitle={exitSubtitleText}
            status={primaryRoute?.status ?? 'unknown'}
            icon={primaryRoute?.targetKind === 'node' ? ServerIcon : RouteIcon}
            selected={selected.kind === 'exit'}
            onClick={() => {}}
          />
          <GraphCard
            x={lefts[4]}
            y={graphY}
            width={cardWidth}
            title={destinationTitle}
            subtitle="куда приходит трафик"
            status={destinationStatus}
            icon={primaryRoute?.targetKind === 'blocked' ? XIcon : CloudIcon}
            selected={false}
            onClick={() => {}}
          />
          {graphStatus !== 'ok' && (
            <div
              className={cn(
                'absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 text-[11.5px]',
                STATUS[graphStatus].text,
              )}
            >
              {graphStatus === 'error' ? (
                <XIcon className="size-4" />
              ) : (
                <TriangleAlertIcon className="size-4" />
              )}
              Путь требует внимания — причина указана в разделе «Проблемы».
            </div>
          )}
        </GraphViewport>
      </div>
      {visibleSegments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-2">
          {visibleSegments.map((segment) => (
            <span
              key={segment.id}
              className={cn(
                'rounded-full border px-2.5 py-1',
                STATUS[segment.runtime?.status ?? 'unknown'].border,
              )}
            >
              {segment.runtime?.label}: {segment.runtime?.detail}
            </span>
          ))}
        </div>
      )}
      {routes.length > 0 && (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {routes.slice(0, 8).map((route) => {
            const source = topology.nodes.find((node) =>
              selectedSourceNodeIds(route, selected, topology.hosts).includes(node.id),
            );
            const destination = topology.nodes.find((node) => route.targetNodeUuids.includes(node.id));
            return (
              <article key={route.id} className="rounded-xl border border-border bg-surface-2 px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-[10.5px] font-semibold tracking-[0.05em] text-text-3 uppercase">
                      {route.isDefault ? 'Остальной трафик' : route.match.join(' · ')}
                    </div>
                    <div className="mt-1 break-words text-[13px] font-semibold">
                      {route.targetKind === 'node'
                        ? `Выход через ${destination?.name ?? route.targetLabel}`
                        : route.targetLabel}
                    </div>
                  </div>
                  <span className="rounded-full border border-border px-2 py-1 text-[10px] text-text-3">
                    {route.confidence === 'confirmed' ? 'связь подтверждена' : 'связь распознана частично'}
                  </span>
                </div>
                <p className="mt-2.5 text-[11.5px] leading-5 text-text-2">
                  {routeDescription(route, source ?? null, destination ?? null)}
                </p>
                {route.note && <p className="mt-2 text-[11px] leading-4 text-warn">{route.note}</p>}
                <details className="mt-3 border-t border-border pt-2.5 text-[11px] text-text-3">
                  <summary className="cursor-pointer font-semibold text-text-2">Технические детали</summary>
                  <dl className="mt-2.5 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 leading-4">
                    <dt>Outbound</dt>
                    <dd className="break-words font-mono text-[10.5px] text-text-2">{route.outboundTag}</dd>
                    <dt>Протокол</dt>
                    <dd className="text-text-2">{route.outboundProtocol ?? 'не указан'}</dd>
                    {route.outboundAddress && (
                      <>
                        <dt>Адрес</dt>
                        <dd className="break-all font-mono text-[10.5px] text-text-2">
                          {route.outboundAddress}
                        </dd>
                      </>
                    )}
                  </dl>
                  <p className="mt-2 leading-4">{route.explanation}</p>
                </details>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RemnawaveTopologyMap({ topology }: { topology: RemnawaveTopology }) {
  const [selected, setSelected] = useState<Selection>(null);
  const [hovered, setHovered] = useState<Selection>(null);
  const exits = useMemo(() => groupExits(topology.routes, topology.nodes), [topology.routes, topology.nodes]);
  const layers = useMemo(() => orderedLayers(topology, exits), [topology, exits]);
  const hasTopology = topology.hosts.length > 0 || topology.nodes.length > 0 || topology.routes.length > 0;
  const graphVisible = hasTopology && selected === null;
  const [graphFrameRef, viewportWidth] = useMeasuredWidth(graphVisible);
  if (!hasTopology)
    return (
      <div className="rounded-xl border border-border bg-surface-2/35 px-4 py-12 text-center">
        <NetworkIcon className="mx-auto size-5 text-text-3" aria-hidden="true" />
        <h2 className="mt-2 font-heading text-[14px] font-bold">Карту пока не из чего собрать</h2>
        <p className="mx-auto mt-1 max-w-[520px] text-[12px] leading-5 text-text-3">
          Remnawave не вернула хосты, ноды и маршруты. После их настройки карта появится здесь автоматически.
        </p>
      </div>
    );
  if (selected)
    return <FocusedFlow topology={topology} selected={selected} onBack={() => setSelected(null)} />;

  const graphWidth = Math.max(1_560, viewportWidth);
  const sidePadding = 28;
  const clientWidth = 220;
  const cardWidth = 230;
  const internetWidth = 190;
  const tallestCard = Math.max(
    estimatedCardHeight('Клиенты', 'VPN-подключения', clientWidth),
    estimatedCardHeight('Интернет', 'назначение', internetWidth),
    ...layers.hosts.map((host) => estimatedCardHeight(host.name, `${host.address}:${host.port}`, cardWidth)),
    ...layers.entryNodes.map((node) =>
      estimatedCardHeight(node.name, `${node.usersOnline ?? '—'} онлайн · ${node.address}`, cardWidth),
    ),
    ...layers.exits.map((exit) => estimatedCardHeight(exit.label, exitSubtitle(exit, topology), cardWidth)),
  );
  const rowStep = Math.max(112, tallestCard + 24);
  const height = Math.max(
    520,
    Math.max(layers.hosts.length, layers.entryNodes.length, layers.exits.length) * rowStep + 150,
  );
  const firstCenter = sidePadding + clientWidth / 2;
  const lastCenter = graphWidth - sidePadding - internetWidth / 2;
  const columnStep = (lastCenter - firstCenter) / 4;
  const columnCenters = Array.from({ length: 5 }, (_, index) => firstCenter + columnStep * index);
  const clientLeft = columnCenters[0] - clientWidth / 2;
  const hostLeft = columnCenters[1] - cardWidth / 2;
  const nodeLeft = columnCenters[2] - cardWidth / 2;
  const exitLeft = columnCenters[3] - cardWidth / 2;
  const internetLeft = columnCenters[4] - internetWidth / 2;
  const hostPoints = new Map(
    layers.hosts.map((item, index) => [
      item.id,
      { x: hostLeft, y: yFor(index, layers.hosts.length, height) },
    ]),
  );
  const nodePoints = new Map(
    layers.entryNodes.map((item, index) => [
      item.id,
      { x: nodeLeft, y: yFor(index, layers.entryNodes.length, height) },
    ]),
  );
  const exitPoints = new Map(
    layers.exits.map((item, index) => [
      item.id,
      { x: exitLeft, y: yFor(index, layers.exits.length, height) },
    ]),
  );
  const client = { x: clientLeft + clientWidth, y: height / 2 };
  const internet = { x: internetLeft, y: height / 2 };
  const hoverContext = hovered ? contextForSelection(hovered, topology, exits) : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-[15px] font-bold">Как идёт трафик</h2>
          <p className="mt-1 max-w-[820px] text-[12px] leading-5 text-text-3">
            Карта показывает реальные хосты и ноды. Если outbound передаёт трафик на другую ноду, она показана
            как выходная нода. Технические имена outbound видны внутри выбранного пути.
          </p>
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
      <div ref={graphFrameRef}>
        <GraphViewport width={graphWidth} height={height}>
          {['Клиенты', 'Хосты', 'Входные ноды', 'Выход', 'Назначение'].map((label, index) => (
            <span
              key={label}
              className="absolute top-4 w-[190px] -translate-x-1/2 text-center text-[10px] font-semibold tracking-[0.08em] text-text-3 uppercase"
              style={{ left: columnCenters[index] }}
            >
              {label}
            </span>
          ))}
          <svg className="absolute inset-0 size-full" aria-hidden="true">
            {layers.hosts.map((host) => {
              const point = hostPoints.get(host.id) as Point;
              const active = hoverContext?.hostIds.has(host.id) ?? false;
              return (
                <Edge
                  key={`client:${host.id}`}
                  from={client}
                  to={point}
                  status={host.status}
                  active={active}
                  dimmed={hoverContext !== null && !active}
                  animated={active}
                />
              );
            })}
            {layers.hosts.flatMap((host) =>
              host.nodeUuids.map((nodeId) => {
                const from = hostPoints.get(host.id);
                const to = nodePoints.get(nodeId);
                if (!from || !to) return null;
                const active = hoverContext?.hostNodeEdgeIds.has(edgeId(host.id, nodeId)) ?? false;
                return (
                  <Edge
                    key={`${host.id}:${nodeId}`}
                    from={{ x: from.x + cardWidth, y: from.y }}
                    to={to}
                    status={nodeStatus(topology, nodeId)}
                    active={active}
                    dimmed={hoverContext !== null && !active}
                    animated={active}
                  />
                );
              }),
            )}
            {topology.routes.flatMap((route) => {
              const sources = sourceNodeIds(route, layers.hosts);
              if (route.targetKind === 'internet')
                return sources.map((nodeId) => {
                  const from = nodePoints.get(nodeId);
                  if (!from) return null;
                  const active =
                    hoverContext?.routeEdgeIds.has(edgeId(route.id, nodeId, 'internet')) ?? false;
                  return (
                    <Edge
                      key={`${route.id}:${nodeId}:internet`}
                      from={{ x: from.x + cardWidth, y: from.y }}
                      to={internet}
                      status={route.status}
                      active={active}
                      dimmed={hoverContext !== null && !active}
                      animated={active}
                    />
                  );
                });
              return routeExitIds(route, layers.exits).flatMap((exitId) => {
                const to = exitPoints.get(exitId);
                if (!to) return [];
                return sources.map((nodeId) => {
                  const from = nodePoints.get(nodeId);
                  if (!from) return null;
                  const active = hoverContext?.routeEdgeIds.has(edgeId(route.id, nodeId, exitId)) ?? false;
                  return (
                    <Edge
                      key={`${route.id}:${nodeId}:${exitId}`}
                      from={{ x: from.x + cardWidth, y: from.y }}
                      to={to}
                      status={route.status}
                      active={active}
                      dimmed={hoverContext !== null && !active}
                      animated={active}
                    />
                  );
                });
              });
            })}
            {layers.exits
              .filter((exit) => exit.routes.some(reachesInternet))
              .map((exit) => {
                const from = exitPoints.get(exit.id) as Point;
                const active = hoverContext?.exitIds.has(exit.id) ?? false;
                return (
                  <Edge
                    key={`${exit.id}:internet`}
                    from={{ x: from.x + cardWidth, y: from.y }}
                    to={internet}
                    status={exit.status}
                    active={active}
                    dimmed={hoverContext !== null && !active}
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
            subtitle="VPN-подключения"
            status="ok"
            icon={UsersIcon}
            selected={false}
            highlighted={hoverContext !== null}
            onClick={() => {}}
          />
          {layers.hosts.map((host) => {
            const point = hostPoints.get(host.id) as Point;
            const highlighted = hoverContext?.hostIds.has(host.id) ?? false;
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
                dimmed={hoverContext !== null && !highlighted}
                onClick={() => setSelected({ kind: 'host', id: host.id })}
                onHoverChange={(value) => setHovered(value ? { kind: 'host', id: host.id } : null)}
              />
            );
          })}
          {layers.entryNodes.map((node) => {
            const point = nodePoints.get(node.id) as Point;
            const highlighted = hoverContext?.nodeIds.has(node.id) ?? false;
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
                dimmed={hoverContext !== null && !highlighted}
                onClick={() => setSelected({ kind: 'node', id: node.id })}
                onHoverChange={(value) => setHovered(value ? { kind: 'node', id: node.id } : null)}
              />
            );
          })}
          {layers.exits.map((exit) => {
            const point = exitPoints.get(exit.id) as Point;
            const highlighted = hoverContext?.exitIds.has(exit.id) ?? false;
            return (
              <GraphCard
                key={exit.id}
                x={point.x}
                y={point.y}
                width={cardWidth}
                title={exit.label}
                subtitle={exitSubtitle(exit, topology)}
                status={exit.status}
                icon={exit.nodeId ? ServerIcon : RouteIcon}
                selected={false}
                highlighted={highlighted}
                dimmed={hoverContext !== null && !highlighted}
                onClick={() => setSelected({ kind: 'exit', id: exit.id })}
                onHoverChange={(value) => setHovered(value ? { kind: 'exit', id: exit.id } : null)}
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
            highlighted={hoverContext?.reachesInternet ?? false}
            dimmed={hoverContext !== null && !hoverContext.reachesInternet}
            onClick={() => {}}
          />
        </GraphViewport>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-3">
        <CircleDotIcon className="size-3.5" aria-hidden="true" />
        Нажмите на хост, входную или выходную ноду, чтобы открыть один путь без лишних связей.
      </p>
    </div>
  );
}

function nodeStatus(topology: RemnawaveTopology, id: string): Status {
  return topology.nodes.find((node) => node.id === id)?.status ?? 'unknown';
}

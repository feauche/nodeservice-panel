import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Provider } from '@nodeservice/shared';
import {
  AGENT_STATUS_LABELS,
  type OverviewServerMetrics,
  SERVER_PROBLEM,
  type Server,
} from '@nodeservice/shared';
import {
  CopyPlusIcon,
  GripVerticalIcon,
  KeyRoundIcon,
  MoreVerticalIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatMbps, formatPct } from '@/features/overview/overview-format';
import { Sparkline } from '@/features/overview/primitives';
import { ProviderIcon } from '@/features/providers/provider-icon';
import { useProviders } from '@/features/providers/providers-api';
import { formatAgo } from '@/features/security/security-format';
import { StepUpCancelledError } from '@/features/security/step-up';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { AgentInstallDialog } from './agent-install-dialog';
import { HEALTH_COLORS, HEALTH_LABELS, type ServerHealth, serverHealth } from './server-health';
import { useCheckServer, useDeleteServer, useDuplicateServer, useTrustHostKey } from './servers-api';

/** ОС + версия + архитектура одной строкой (требование 3.10). */
export function osLine(server: Server): string {
  const os = [server.facts.os, server.facts.osVersion].filter(Boolean).join(' ');
  return [os || null, server.facts.arch].filter(Boolean).join(' · ') || 'ОС неизвестна';
}

/** Пилюля состояния SSH: одна строка, время проверки — в подсказке. */
export function SshPill({ server }: { server: Server }) {
  const tone = server.sshOk === true ? 'ok' : server.sshOk === false ? 'crit' : 'muted';
  const label =
    server.sshOk === true ? 'SSH в порядке' : server.sshOk === false ? 'SSH недоступен' : 'SSH не проверен';
  return (
    <span title={server.lastSshCheckAt ? `Проверено ${formatAgo(server.lastSshCheckAt)}` : undefined}>
      <Pill tone={tone}>{label}</Pill>
    </span>
  );
}

/** Точка состояния сервера: цвет = здоровье, подпись — в подсказке и для скринридера. */
export function HealthDot({ health, className }: { health: ServerHealth; className?: string }) {
  return (
    <span
      role="img"
      aria-label={HEALTH_LABELS[health]}
      title={HEALTH_LABELS[health]}
      className={cn('inline-block size-2 flex-none rounded-full', className)}
      style={{
        background: HEALTH_COLORS[health],
        boxShadow: `0 0 0 3px color-mix(in srgb, ${HEALTH_COLORS[health]} 18%, transparent)`,
      }}
    />
  );
}

const ACTION_BTN =
  'size-8 rounded-[9px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground';

function Gauges({
  metrics,
  offline,
}: {
  metrics: OverviewServerMetrics | null | undefined;
  offline: boolean;
}) {
  // Порт дуплексный: в лимит упирается более загруженное направление, его и показываем крупно.
  // Сумма rx+tx у VPN-ноды выглядит вдвое больше реальной нагрузки, поэтому её не используем.
  const rx = metrics?.netRxBps ?? null;
  const tx = metrics?.netTxBps ?? null;
  const netBps = rx === null && tx === null ? null : Math.max(rx ?? 0, tx ?? 0);
  // От 10 Мбит/с дробная часть не нужна — иначе значение не влезает в ячейку.
  const mbit = (bps: number) =>
    bps * 8 >= 10_000_000 ? String(Math.round((bps * 8) / 1_000_000)) : formatMbps(bps);
  const net = netBps === null ? null : mbit(netBps);
  const netTitle =
    netBps === null ? undefined : `Входящий ↓ ${mbit(rx ?? 0)} · исходящий ↑ ${mbit(tx ?? 0)} Мбит/с`;
  const cells: Array<{ label: string; value: string; unit?: string; title?: string }> = [
    { label: 'CPU', value: offline ? '—' : formatPct(metrics?.cpuPct), unit: '%' },
    { label: 'RAM', value: offline ? '—' : formatPct(metrics?.memPct), unit: '%' },
    { label: 'Сеть', value: offline || net === null ? '—' : net, unit: ' Мбит/с', title: netTitle },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {cells.map((c) => (
        <div key={c.label} title={c.title} className="min-w-0 rounded-[9px] bg-surface-2 px-2.5 py-[7px]">
          <div className="text-[10.5px] leading-none text-text-3">{c.label}</div>
          <div className="mt-1 truncate font-heading text-[14px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
            {c.value}
            {c.value !== '—' && <span className="text-[11px] font-medium text-text-3">{c.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function CardSpark({
  metrics,
  health,
}: {
  metrics: OverviewServerMetrics | null | undefined;
  health: ServerHealth;
}) {
  const values = metrics?.cpuSpark ?? [];
  const enough = values.filter((v) => v !== null).length >= 2;
  return (
    <div className="h-7">
      {enough ? (
        <Sparkline values={values} stroke={HEALTH_COLORS[health]} stretch className="h-full w-full" />
      ) : (
        <div className="grid h-full place-items-center text-[11px] text-text-3">Метрик пока нет</div>
      )}
    </div>
  );
}

/** Статус агента. Пока панель ставит агента по SSH — пульсирующая пилюля (витрина, вариант II). */
export function AgentPill({ server }: { server: Server }) {
  if (server.agentStatus === 'installing')
    return (
      <span
        data-testid="agent-installing"
        className="inline-flex h-[22px] animate-pulse items-center gap-1.5 rounded-full bg-brand-soft px-2.5 text-[11.5px] font-semibold text-brand motion-reduce:animate-none"
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        {AGENT_STATUS_LABELS.installing}
      </span>
    );
  return (
    <Pill tone={server.agentStatus === 'online' ? 'ok' : server.agentStatus === 'offline' ? 'crit' : 'muted'}>
      {AGENT_STATUS_LABELS[server.agentStatus]}
    </Pill>
  );
}

function StatusPills({ server }: { server: Server }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <AgentPill server={server} />
        <SshPill server={server} />
        <NodePill server={server} />
      </div>
      {server.agentStatus === 'installing' && (
        <div aria-hidden="true" className="h-[3px] overflow-hidden rounded-full bg-surface-3">
          <div className="h-full w-2/5 animate-slide rounded-full bg-brand motion-reduce:animate-none" />
        </div>
      )}
    </div>
  );
}

/** Нода на сервере: зелёная «Нода», красная «Нода остановлена / не найдена»; без ноды — ничего. */
function NodePill({ server }: { server: Server }) {
  if (server.nodeWatch === 'off') return null;
  if (server.node === 'running') return <Pill tone="ok">Нода</Pill>;
  if (server.node === 'stopped') return <Pill tone="crit">Нода остановлена</Pill>;
  if (server.node === 'none' && server.nodeWatch === 'on') return <Pill tone="crit">Нода не найдена</Pill>;
  return null;
}

/** Система и ресурсы одной строкой, ниже — теги (и место под ручку перетаскивания справа). */
function CardFooter({
  server,
  provider,
  handle,
}: {
  server: Server;
  provider: Provider | null;
  handle?: ReactNode;
}) {
  const resources = [
    server.facts.cpuCores ? `${server.facts.cpuCores} CPU` : null,
    server.facts.memoryMb ? `${Math.round(server.facts.memoryMb / 1024)} ГБ` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const line = resources ? `${osLine(server)} · ${resources}` : osLine(server);
  const title = provider ? `${provider.name} · ${line}` : line;
  return (
    <div className="flex flex-col gap-2">
      {/* Провайдер — часть описания железа (витрина «Карточка сервера», V3): «[иконка] Time Web · Ubuntu … » */}
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-3" title={title}>
        {provider && <ProviderIcon provider={provider} size="sm" className="flex-none" />}
        <span className="truncate">
          {provider && <b className="font-semibold text-text-2">{provider.name}</b>}
          {provider && ' · '}
          {line}
        </span>
      </div>
      {(server.tags.length > 0 || handle) && (
        <div className="flex min-h-6 items-center gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {server.tags.map((t) => (
              <span
                key={t}
                className="rounded-[6px] border border-border bg-surface-2 px-2 py-[2px] text-[11px] font-medium text-text-2"
              >
                {t}
              </span>
            ))}
          </div>
          {handle}
        </div>
      )}
    </div>
  );
}

/** Провайдер сервера из справочника — общий для карточки и её «призрака». */
function useServerProvider(server: Server): Provider | null {
  const providers = useProviders();
  return server.providerId ? (providers.data?.items.find((p) => p.id === server.providerId) ?? null) : null;
}

/** Адрес SSH. Провайдер живёт в нижней строке карточки, а не здесь: адрес — про подключение. */
function AddressLine({ server }: { server: Server }) {
  return (
    <p className="mt-0.5 min-w-0 truncate font-mono text-[11.5px] text-text-3">
      {server.sshUser}@{server.host}:{server.port}
    </p>
  );
}

/** «Призрак» для DragOverlay: летит за курсором при перетаскивании и плавно «долетает» в слот. */
export function ServerCardGhost({
  server,
  metrics,
}: {
  server: Server;
  metrics?: OverviewServerMetrics | null;
}) {
  const health = serverHealth(server, metrics);
  const provider = useServerProvider(server);
  return (
    <div className="relative flex cursor-grabbing flex-col gap-3 rounded-2xl border border-border-2 bg-surface p-4 shadow-float">
      <div className="flex items-start gap-2.5">
        <HealthDot health={health} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-heading text-[15px] leading-[1.25] font-bold tracking-[-0.01em]">
            {server.name}
          </h2>
          <AddressLine server={server} />
        </div>
      </div>
      <StatusPills server={server} />
      <Gauges metrics={metrics} offline={health === 'crit'} />
      <CardSpark metrics={metrics} health={health} />
      <CardFooter server={server} provider={provider} />
    </div>
  );
}

interface Props {
  server: Server;
  /** Последние значения и спарклайн CPU из /metrics/overview; null — метрик нет. */
  metrics?: OverviewServerMetrics | null;
  /** Клик по карточке: страница сервера (метрики, журнал). */
  onOpen: (server: Server) => void;
  /** Меню «Изменить»: модалка настроек. */
  onEdit: (server: Server) => void;
}

/**
 * Карточка сервера: точка состояния, имя и адрес, действия; пилюли агента и SSH;
 * CPU / RAM / сеть; спарклайн CPU в цвет состояния; система и теги.
 */
export function ServerCard({ server, metrics, onOpen, onEdit }: Props) {
  const check = useCheckServer();
  const duplicate = useDuplicateServer();
  const sortable = useSortable({ id: server.id });
  const remove = useDeleteServer();
  const trust = useTrustHostKey();
  const provider = useServerProvider(server);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mismatch, setMismatch] = useState<{ offered: string } | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const health = serverHealth(server, metrics);

  const doCheck = async () => {
    try {
      await check.mutateAsync(server.id);
      toast.success(`${server.name}: связь работает. Данные о системе обновлены.`);
    } catch (err) {
      if (isApiError(err) && err.type === SERVER_PROBLEM.hostKeyMismatch) {
        const offered = err.extensionString('offeredFingerprint');
        if (offered) {
          setMismatch({ offered });
          return;
        }
      }
      toast.error(apiErrorMessage(err));
    }
  };

  const doTrust = async () => {
    if (!mismatch) return;
    try {
      await trust.mutateAsync({ id: server.id, fingerprint: mismatch.offered });
      setMismatch(null);
      toast.success(`${server.name}: новый отпечаток доверен, связь восстановлена.`);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.error(apiErrorMessage(err));
    }
  };

  const doDuplicate = async () => {
    try {
      const copy = await duplicate.mutateAsync(server.id);
      toast.success(`Создана копия «${copy.name}».`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(server.id);
      toast.success(`Сервер «${server.name}» удалён.`);
      setDeleteOpen(false);
    } catch (err) {
      setDeleteOpen(false);
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: клик по карточке — ярлык, доступный путь есть в меню «Изменить»
    // biome-ignore lint/a11y/useKeyWithClickEvents: с клавиатуры настройки открываются через меню карточки, ручка перетаскивания фокусируема
    <article
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        // dnd-kit сам гасит transition на активной карточке во время drag и включает на «долёте» к слоту.
        transition: sortable.transition,
      }}
      onClick={(e) => {
        // Порталы (меню, диалоги) всплывают по дереву React, а не DOM — реагируем только на свои клики.
        if (e.target instanceof Node && e.currentTarget.contains(e.target)) onOpen(server);
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-3 rounded-2xl border border-border bg-surface p-4 transition-[border-color,box-shadow] duration-200 hover:border-border-2 hover:shadow-[0_2px_10px_-4px_rgb(0_0_0/0.35)]',
        sortable.isDragging && 'opacity-0',
      )}
    >
      {/* Шапка: состояние, имя, адрес, действия */}
      <div className="flex items-start gap-2.5">
        <HealthDot health={health} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-heading text-[15px] leading-[1.25] font-bold tracking-[-0.01em]">
            {server.name}
          </h2>
          <AddressLine server={server} />
        </div>
        <div className="flex flex-none items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                onClick={(e) => e.stopPropagation()}
                type="button"
                variant="outline"
                aria-label={`Действия с ${server.name}`}
                className={ACTION_BTN}
              >
                <MoreVerticalIcon className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              <DropdownMenuItem disabled={check.isPending} onSelect={() => void doCheck()}>
                <RefreshCwIcon
                  className={cn('size-4', check.isPending && 'animate-spin')}
                  aria-hidden="true"
                />
                Проверить связь по SSH
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onEdit(server)}>
                <PencilIcon className="size-4" aria-hidden="true" />
                Изменить
              </DropdownMenuItem>
              <DropdownMenuItem disabled={duplicate.isPending} onSelect={() => void doDuplicate()}>
                <CopyPlusIcon className="size-4" aria-hidden="true" />
                Дублировать
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setInstallOpen(true)}>
                <KeyRoundIcon className="size-4" aria-hidden="true" />
                {server.agentStatus === 'online' ? 'Переустановить агента' : 'Установить агента'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2Icon className="size-4" aria-hidden="true" />
                Удалить
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <StatusPills server={server} />
      <Gauges metrics={metrics} offline={health === 'crit'} />
      <CardSpark metrics={metrics} health={health} />
      <CardFooter
        server={server}
        provider={provider}
        handle={
          // Ручка перетаскивания в правом нижнем углу: порядок карточек можно менять, сетка сохраняется
          <button
            type="button"
            ref={sortable.setActivatorNodeRef}
            {...sortable.attributes}
            {...sortable.listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Перетащить «${server.name}»`}
            title="Перетащить"
            className="grid size-6 flex-none cursor-grab touch-none place-items-center rounded-[7px] text-text-3 opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-foreground [@media(hover:none)]:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-1 active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-4" aria-hidden="true" />
          </button>
        }
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        kind="crit"
        title={`Удалить «${server.name}»?`}
        description="Сервер пропадёт из панели вместе с историей проверок. Сам сервер и то, что на нём установлено, не трогаем."
        yesLabel="Да, удалить"
        loading={remove.isPending}
        onConfirm={doDelete}
      />

      {/* Смена отпечатка сервера: сравнение и явное доверие */}
      <Dialog open={mismatch !== null} onOpenChange={(o) => !o && setMismatch(null)}>
        <DialogContent className="sm:max-w-[500px] rounded-2xl border-border bg-surface p-6">
          <DialogHeader>
            <DialogTitle className="font-heading text-[17px]">Отпечаток сервера изменился</DialogTitle>
            <DialogDescription className="text-[12.5px] text-text-2">
              Так бывает после переустановки системы. Если вы сервер не переустанавливали, не доверяйте:
              возможно, кто-то подменяет его собой.
            </DialogDescription>
          </DialogHeader>
          <dl className="mt-1 flex flex-col gap-2 text-[12px]">
            <div>
              <dt className="text-text-3">Был</dt>
              <dd className="mt-0.5 break-all rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 font-mono">
                {server.hostKeyFingerprint ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-text-3">Стал</dt>
              <dd className="mt-0.5 break-all rounded-[8px] border border-warn/40 bg-warn-soft px-2.5 py-1.5 font-mono">
                {mismatch?.offered}
              </dd>
            </div>
          </dl>
          <DialogActions>
            <DialogSecondaryButton onClick={() => setMismatch(null)}>Не доверять</DialogSecondaryButton>
            <DialogPrimaryButton disabled={trust.isPending} onClick={() => void doTrust()}>
              Доверять новому
            </DialogPrimaryButton>
          </DialogActions>
        </DialogContent>
      </Dialog>

      <AgentInstallDialog server={server} open={installOpen} onOpenChange={setInstallOpen} />
    </article>
  );
}

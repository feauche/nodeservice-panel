import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AGENT_STATUS_LABELS, SERVER_PROBLEM, type Server } from '@nodeservice/shared';
import {
  CopyPlusIcon,
  KeyRoundIcon,
  MoreVerticalIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAgo } from '@/features/security/security-format';
import { StepUpCancelledError } from '@/features/security/step-up';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AgentInstallDialog } from './agent-install-dialog';
import { useCheckServer, useDeleteServer, useDuplicateServer, useTrustHostKey } from './servers-api';

/** ОС + версия + архитектура одной строкой (требование 3.10). */
export function osLine(server: Server): string {
  const os = [server.facts.os, server.facts.osVersion].filter(Boolean).join(' ');
  return [os || null, server.facts.arch].filter(Boolean).join(' · ') || 'ОС неизвестна';
}

/** Пилюля состояния SSH: одна строка, время проверки — в подсказке и в строке ресурсов. */
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

/** «Призрак» для DragOverlay: летит за курсором при перетаскивании и плавно «долетает» в слот. */
export function ServerCardGhost({ server }: { server: Server }) {
  const resources = [
    server.facts.cpuCores ? `${server.facts.cpuCores} CPU` : null,
    server.facts.memoryMb ? `${Math.round(server.facts.memoryMb / 1024)} ГБ RAM` : null,
    server.lastSshCheckAt ? `проверено ${formatAgo(server.lastSshCheckAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="relative flex rotate-1 cursor-grabbing flex-col gap-2.5 rounded-2xl border border-border-2 bg-surface p-4 shadow-float">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-heading text-[15px] font-bold tracking-[-0.01em]">{server.name}</h2>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-text-3">
            {server.sshUser}@{server.host}:{server.port}
          </p>
        </div>
        <div aria-hidden="true" className="flex flex-none items-center gap-1">
          <span className="grid size-8 place-items-center rounded-[9px] border border-border bg-surface-2 text-text-2">
            <RefreshCwIcon className="size-4" />
          </span>
          <span className="grid size-8 place-items-center rounded-[9px] border border-border bg-surface-2 text-text-2">
            <MoreVerticalIcon className="size-4" />
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill
          tone={server.agentStatus === 'online' ? 'ok' : server.agentStatus === 'offline' ? 'crit' : 'muted'}
        >
          {AGENT_STATUS_LABELS[server.agentStatus]}
        </Pill>
        <SshPill server={server} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[12.5px] text-text-2">{osLine(server)}</span>
        {resources && <span className="truncate text-[12px] text-text-3">{resources}</span>}
      </div>
      {server.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {server.tags.map((t) => (
            <span
              key={t}
              className="rounded-[8px] border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-2"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <span
        aria-hidden="true"
        className="absolute right-2 bottom-1.5 p-1.5 text-[19px] leading-none text-text-2"
      >
        ⠿
      </span>
    </div>
  );
}

interface Props {
  server: Server;
  /** Клик по карточке: страница сервера (метрики, журнал). */
  onOpen: (server: Server) => void;
  /** Меню «Изменить»: модалка настроек. */
  onEdit: (server: Server) => void;
}

/** Компактная карточка для сетки (4 в ряд на широких экранах). */
export function ServerCard({ server, onOpen, onEdit }: Props) {
  const check = useCheckServer();
  const duplicate = useDuplicateServer();
  const sortable = useSortable({ id: server.id });
  const remove = useDeleteServer();
  const trust = useTrustHostKey();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mismatch, setMismatch] = useState<{ offered: string } | null>(null);
  const [installOpen, setInstallOpen] = useState(false);

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

  const resources = [
    server.facts.cpuCores ? `${server.facts.cpuCores} CPU` : null,
    server.facts.memoryMb ? `${Math.round(server.facts.memoryMb / 1024)} ГБ RAM` : null,
    server.lastSshCheckAt ? `проверено ${formatAgo(server.lastSshCheckAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: клик по карточке — ярлык, доступный путь есть в меню «Изменить»
    // biome-ignore lint/a11y/useKeyWithClickEvents: с клавиатуры настройки открываются через меню карточки, ручка ⠿ фокусируема
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
        'relative flex cursor-pointer flex-col gap-2.5 rounded-2xl border border-border bg-surface p-4 transition-[border-color,box-shadow] duration-200 hover:border-border-2 hover:shadow-[0_2px_10px_-4px_rgb(0_0_0/0.35)]',
        sortable.isDragging && 'opacity-0',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-heading text-[15px] font-bold tracking-[-0.01em]">{server.name}</h2>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-text-3">
            {server.sshUser}@{server.host}:{server.port}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                aria-label="Проверить связь"
                disabled={check.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  void doCheck();
                }}
                className="size-8 rounded-[9px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
              >
                <RefreshCwIcon
                  className={cn('size-4', check.isPending && 'animate-spin')}
                  aria-hidden="true"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Проверить связь по SSH</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                onClick={(e) => e.stopPropagation()}
                type="button"
                variant="outline"
                aria-label={`Действия с ${server.name}`}
                className="size-8 rounded-[9px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
              >
                <MoreVerticalIcon className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
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
                Установить агента
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

      <div className="flex flex-wrap items-center gap-1.5">
        <Pill
          tone={server.agentStatus === 'online' ? 'ok' : server.agentStatus === 'offline' ? 'crit' : 'muted'}
        >
          {AGENT_STATUS_LABELS[server.agentStatus]}
        </Pill>
        <SshPill server={server} />
      </div>

      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[12.5px] text-text-2">{osLine(server)}</span>
        {resources && <span className="truncate text-[12px] text-text-3">{resources}</span>}
      </div>

      {server.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {server.tags.map((t) => (
            <span
              key={t}
              className="rounded-[8px] border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-text-2"
            >
              {t}
            </span>
          ))}
        </div>
      )}

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

      {/* Ручка перетаскивания: порядок карточек можно менять, сетка сохраняется */}
      <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Перетащить «${server.name}»`}
        title="Перетащить"
        className="absolute right-2 bottom-1.5 cursor-grab touch-none select-none rounded-[8px] p-1.5 text-[19px] leading-none text-text-3 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-1 active:cursor-grabbing"
      >
        ⠿
      </button>

      {/* Смена отпечатка сервера: сравнение и явное доверие */}
      <Dialog open={mismatch !== null} onOpenChange={(o) => !o && setMismatch(null)}>
        <DialogContent className="sm:max-w-[500px] rounded-2xl border-border bg-surface p-6">
          <DialogHeader>
            <DialogTitle className="font-heading text-[17px]">Отпечаток сервера изменился</DialogTitle>
            <DialogDescription className="text-[12.5px] text-text-2">
              Так бывает после переустановки системы. Если ты сервер не переустанавливал — не доверяй:
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

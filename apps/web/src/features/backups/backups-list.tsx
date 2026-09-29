import { BACKUP_KIND_LABELS, type BackupItem } from '@nodeservice/shared';
import {
  DownloadIcon,
  LockIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { backupsApi } from './backups-api';
import { formatSize, formatWhen } from './backups-format';

/**
 * «Копии на сервере» (вариант A). Колонки постоянной ширины — значения ровно под заголовками; действия —
 * одной кнопкой «⋯» со списком. Ширина — по блоку, а не по экрану (container query): совсем узко строка
 * складывается — время и имя сверху, размер и состояние под ними.
 */
export function BackupsList({
  items,
  keep,
  timeZone,
  loading,
  busy,
  onRestore,
  onDelete,
}: {
  items: BackupItem[];
  keep: number | null;
  timeZone: string;
  loading: boolean;
  /** Идёт копия или восстановление — восстанавливать и удалять нельзя. */
  busy: boolean;
  onRestore: (item: BackupItem) => void;
  onDelete: (item: BackupItem) => void;
}) {
  return (
    <section className="@container overflow-hidden rounded-[14px] border border-border bg-surface">
      <div className="px-[18px] pt-3.5 pb-3 max-md:px-4">
        <h3 className="m-0 font-heading text-[14.5px] font-semibold tracking-[-0.01em]">Копии на сервере</h3>
        <p className="m-0 mt-0.5 text-[12.5px] text-text-3">
          {keep
            ? `Хранятся последние ${keep}: старше удаляются сами после новой копии. Копии «перед восстановлением» — отдельно, две последние.`
            : 'Архивы на сервере панели. Имя файла — под временем.'}
        </p>
      </div>
      <div
        className="hidden grid-cols-[minmax(0,1fr)_76px_190px_32px] items-center gap-3 border-t border-border bg-surface-2/60 px-[18px] py-2 text-[11px] font-semibold tracking-[0.05em] text-text-3 uppercase @min-[560px]:grid"
        aria-hidden="true"
      >
        <span>Когда</span>
        <span className="text-right">Размер</span>
        <span>Состояние</span>
        <span className="text-right">
          <span className="sr-only">Действия</span>
        </span>
      </div>
      {loading ? (
        <div className="flex flex-col gap-2 border-t border-border p-4">
          <Skeleton className="h-12 rounded-[10px]" />
          <Skeleton className="h-12 rounded-[10px]" />
          <Skeleton className="h-12 rounded-[10px]" />
        </div>
      ) : items.length === 0 ? (
        <p className="m-0 border-t border-border px-4 py-8 text-center text-[12.5px] text-text-3">
          Копий пока нет. Нажмите «Сделать копию сейчас» — первая появится здесь через полминуты.
        </p>
      ) : (
        <ul className="m-0 list-none p-0" aria-label="Резервные копии">
          {items.map((it) => (
            <Row
              key={it.name}
              item={it}
              timeZone={timeZone}
              busy={busy}
              onRestore={() => onRestore(it)}
              onDelete={() => onDelete(it)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  item,
  timeZone,
  busy,
  onRestore,
  onDelete,
}: {
  item: BackupItem;
  timeZone: string;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const when = formatWhen(item.createdAt, timeZone);
  const kind =
    BACKUP_KIND_LABELS[item.kind] + (item.kind === 'pre_update' && item.version ? ` ${item.version}` : '');
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-border px-[18px] py-2.5 max-md:px-4 @min-[560px]:grid-cols-[minmax(0,1fr)_76px_190px_32px]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <b className="text-[13.5px] font-semibold whitespace-nowrap">{when}</b>
          <span className="rounded-full bg-surface-2 px-2 py-px text-[11px] font-medium text-text-3">
            {kind}
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-text-3" title={item.name}>
          {item.name}
        </div>
      </div>
      {/* Узко: размер и состояние — второй строкой под именем. */}
      <span className="col-start-1 row-start-2 font-mono text-[12.5px] text-text-2 tabular-nums @min-[560px]:col-start-auto @min-[560px]:row-start-auto @min-[560px]:text-right">
        <span className="@min-[560px]:hidden">Размер: </span>
        {formatSize(item.size)}
      </span>
      <span className="col-span-2 col-start-1 row-start-3 flex flex-wrap items-center gap-1.5 @min-[560px]:col-span-1 @min-[560px]:col-start-auto @min-[560px]:row-start-auto">
        <States item={item} />
      </span>
      <span className="col-start-2 row-span-1 row-start-1 flex justify-end @min-[560px]:col-start-auto @min-[560px]:row-start-auto">
        <Actions item={item} busy={busy} onRestore={onRestore} onDelete={onDelete} />
      </span>
    </li>
  );
}

/** Значок-отметка с подсказкой: «с паролем», «в Telegram» — чтобы состояние помещалось в одну строку. */
function IconPill({ title, label, children }: { title: string; label: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className="inline-grid size-[22px] place-items-center rounded-full bg-surface-2 text-text-3 [&_svg]:size-3"
    >
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function States({ item }: { item: BackupItem }) {
  const pills: ReactNode[] = [];
  if (item.verified === true)
    pills.push(
      <Pill key="v" tone="ok" title="Сразу после создания архив прочитан, база в нём разворачивается">
        ✓ проверена
      </Pill>,
    );
  else if (item.verified === false)
    pills.push(
      <Pill key="v" tone="crit" title="База в архиве не читается — на эту копию не рассчитывайте">
        повреждена
      </Pill>,
    );
  if (item.encrypted)
    pills.push(
      <IconPill key="e" title="Архив зашифрован паролем" label="с паролем">
        <LockIcon aria-hidden="true" />
      </IconPill>,
    );
  if (item.telegram)
    pills.push(
      item.telegram.ok ? (
        <IconPill key="t" title="Архив отправлен файлом в Telegram" label="в Telegram">
          <SendIcon aria-hidden="true" />
        </IconPill>
      ) : (
        <Pill key="t" tone="warn" title={item.telegram.note ?? 'Отправить в Telegram не удалось'}>
          не отправилась
        </Pill>
      ),
    );
  if (pills.length === 0)
    pills.push(
      <span key="n" className="text-[12px] text-text-3">
        —
      </span>,
    );
  return <>{pills}</>;
}

function Actions({
  item,
  busy,
  onRestore,
  onDelete,
}: {
  item: BackupItem;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const when = item.createdAt;
  return (
    <>
      {/* Действия — всегда одной кнопкой «⋯» со списком: колонки остаются ровно под заголовками. */}
      <span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Действия с копией ${when}`}
              className="grid size-[30px] cursor-pointer place-items-center rounded-[9px] border border-border bg-surface-2 text-text-2 transition-colors hover:border-border-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
            >
              <MoreHorizontalIcon className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuItem asChild>
              <a href={backupsApi.downloadUrl(item.name)} download>
                <DownloadIcon className="size-4" aria-hidden="true" />
                Скачать
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={onRestore}>
              <RotateCcwIcon className="size-4" aria-hidden="true" />
              Восстановить
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={busy} onSelect={onDelete}>
              <Trash2Icon className="size-4" aria-hidden="true" />
              Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </>
  );
}

import { BACKUP_STAGE_LABELS, type BackupItem } from '@nodeservice/shared';
import { DatabaseBackupIcon, DownloadIcon, Loader2Icon, TriangleAlertIcon, UploadIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeader } from '@/features/settings/settings-ui';
import { useTelegramSettings } from '@/features/settings/telegram-api';
import { timeZoneLabel } from '@/features/settings/time-zones';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useBackupSettings, useBackups } from './backups-api';
import { DeleteDialog, FileDialog, RestoreDialog, RunDialog } from './backups-dialogs';
import { formatSize, formatWhen, scheduleWords } from './backups-format';
import { BackupsList } from './backups-list';
import { BackupSettingsForm } from './backups-settings';

/**
 * «Настройки → Резервные копии» (витрина `backups-variants.html`, вариант A): сверху состояние и две
 * главные кнопки, сразу под ними список копий, ниже — настройки карточками и одна панель «Сохранить».
 */
export function BackupsPage() {
  const list = useBackups();
  const settings = useBackupSettings();
  const telegram = useTelegramSettings();
  const [runOpen, setRunOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [restoreItem, setRestoreItem] = useState<BackupItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<BackupItem | null>(null);

  const data = list.data;
  const s = settings.data;
  // Не загрузилось совсем (показать нечего) — говорим об этом и даём «Повторить», а не «Копий пока нет» и
  // вечную заглушку. Сбой при перечитывании уже показанного сюда не попадает: на экране остаётся прежнее.
  const listError = !data && list.isError ? list.error : null;
  const settingsError = !s && settings.isError ? settings.error : null;
  const retry = () => {
    if (listError) void list.refetch();
    if (settingsError) void settings.refetch();
  };
  const tz = data?.timeZone ?? 'Europe/Moscow';
  const items = data?.items ?? [];
  const busy = Boolean(data?.run.stage);
  const regular = items.filter((i) => i.kind !== 'pre_restore' && i.kind !== 'uploaded');

  const tg = s?.telegram;
  const dest = telegram.data?.destinations.find((x) => x.id === tg?.destinationId);
  const telegramReady = Boolean(tg?.enabled && (tg.target === 'own' ? tg.ownUrl : tg.destinationId && dest));
  const telegramWhere =
    tg?.target === 'own' ? 'отдельный чат для копий' : dest ? (dest.chatTitle ?? dest.chatId) : null;

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        icon={DatabaseBackupIcon}
        title="Резервные копии"
        description="Полная копия панели одним архивом: база, ключи шифрования и ваши файлы. По расписанию и вручную, с отправкой в Telegram."
      />

      {data && !data.available && (
        <div className="flex gap-2.5 rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[12.5px]">
          <TriangleAlertIcon className="mt-0.5 size-4 flex-none text-crit" aria-hidden="true" />
          <div>
            <b>Копии сейчас недоступны.</b> {data.unavailableReason}
          </div>
        </div>
      )}

      <StatusTiles
        loading={!listError && !settingsError && (list.isPending || settings.isPending)}
        tiles={
          data && s
            ? [
                {
                  label: 'Последняя копия',
                  value: busy
                    ? data.run.mode === 'restore'
                      ? 'Идёт восстановление'
                      : 'Идёт копия…'
                    : items[0]
                      ? formatWhen(items[0].createdAt, tz)
                      : 'Ещё не было',
                  sub: busy ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                      {data.run.stage ? BACKUP_STAGE_LABELS[data.run.stage] : ''}
                    </span>
                  ) : items[0] ? (
                    [
                      formatSize(items[0].size),
                      items[0].verified ? 'проверена' : null,
                      items[0].telegram?.ok ? 'в Telegram' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  ) : data.run.lastError ? (
                    <span className="text-crit">Последняя попытка не получилась</span>
                  ) : (
                    'Нажмите «Сделать копию сейчас»'
                  ),
                  tone: !busy && data.run.lastError ? 'crit' : undefined,
                },
                {
                  label: 'Следующая',
                  value: data.nextAt ? formatWhen(data.nextAt, tz) : '—',
                  sub: `${scheduleWords(s)}${s.auto ? ` · ${timeZoneLabel(tz).split(' · ')[1] ?? ''}` : ''}`,
                },
                {
                  label: 'На сервере',
                  value: `${regular.length} из ${s.keep}`,
                  sub: `${formatSize(data.totalSize)}${data.freeBytes != null ? ` · свободно ${formatSize(data.freeBytes)}` : ''}`,
                },
                {
                  label: 'Защита',
                  value: s.passwordSet ? 'С паролем' : 'Без пароля',
                  sub: s.passwordSet ? (
                    'AES-256, пароль — только у вас'
                  ) : (
                    <span className="text-warn">ключи шифрования в открытом виде</span>
                  ),
                },
              ]
            : []
        }
      />

      <div className="flex flex-wrap items-center justify-end gap-2.5 rounded-[13px] border border-border bg-surface px-4 py-2.5">
        <span className="min-w-[200px] flex-1 text-[12.5px] text-text-3">
          Копия занимает от десятков секунд до пары минут. Панель при этом работает.
        </span>
        <button
          type="button"
          onClick={() => setFileOpen(true)}
          disabled={!data?.available || busy}
          className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3.5 text-[13px] font-medium text-text-2 transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-50"
        >
          <UploadIcon className="size-3.5" aria-hidden="true" />
          Восстановить из файла…
        </button>
        <button
          type="button"
          onClick={() => setRunOpen(true)}
          disabled={!data?.available || (busy && data?.run.mode === 'restore')}
          className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-[9px] border border-transparent bg-cta px-3.5 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50"
        >
          <DownloadIcon className="size-3.5" aria-hidden="true" />
          {busy && data?.run.mode === 'backup' ? 'Ход копии' : 'Сделать копию сейчас'}
        </button>
      </div>

      <BackupsList
        items={items}
        keep={s?.keep ?? null}
        timeZone={tz}
        loading={list.isPending}
        error={listError}
        onRetry={retry}
        busy={busy}
        onRestore={setRestoreItem}
        onDelete={setDeleteItem}
      />

      {s && data ? (
        <BackupSettingsForm saved={s} timeZone={tz} totalSize={data.totalSize} count={regular.length} />
      ) : listError || settingsError ? (
        <p className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
          {/* Форме нужен и список (сколько копий и сколько они занимают): без него она не строится. */}
          {settingsError
            ? `Не удалось загрузить настройки копий. ${apiErrorMessage(settingsError)}`
            : 'Настройки копий откроются, когда загрузится список копий.'}{' '}
          <button type="button" className="cursor-pointer underline" onClick={retry}>
            Повторить
          </button>
        </p>
      ) : (
        <Skeleton className="h-[320px] rounded-[14px]" />
      )}

      <RunDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        data={data}
        updatedAt={list.dataUpdatedAt}
        telegramReady={telegramReady}
        telegramDefault={Boolean(tg?.enabled)}
        telegramWhere={telegramWhere}
      />
      <RestoreDialog item={restoreItem} tz={tz} onClose={() => setRestoreItem(null)} />
      <DeleteDialog item={deleteItem} items={items} tz={tz} onClose={() => setDeleteItem(null)} />
      <FileDialog open={fileOpen} tz={tz} onClose={() => setFileOpen(false)} />
    </div>
  );
}

function StatusTiles({
  loading,
  tiles,
}: {
  loading: boolean;
  tiles: Array<{ label: string; value: string; sub: ReactNode; tone?: 'crit' | undefined }>;
}) {
  if (loading)
    return (
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[84px] rounded-[13px]" />
        ))}
      </div>
    );
  // Страница не загрузилась — считать плитки не из чего; об ошибке сказано в списке и в настройках.
  if (tiles.length === 0) return null;
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={cn(
            'flex min-w-0 flex-col gap-0.5 rounded-[13px] border bg-surface px-4 py-3',
            t.tone === 'crit' ? 'border-crit/40' : 'border-border',
          )}
        >
          <span className="text-[11px] font-semibold tracking-[0.05em] text-text-3 uppercase">{t.label}</span>
          <b className="truncate font-heading text-[16px] font-semibold">{t.value}</b>
          <span className="truncate text-[12px] text-text-3">{t.sub}</span>
        </div>
      ))}
    </div>
  );
}

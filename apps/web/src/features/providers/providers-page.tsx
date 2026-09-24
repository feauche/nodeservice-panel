import { isProviderIconServiceUrl, PROVIDER_NOTE_MAX, type Provider } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  ArrowDownAZIcon,
  ArrowDownWideNarrowIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { ProviderDialog } from './provider-dialog';
import { ProviderIcon } from './provider-icon';
import {
  useDeleteProvider,
  useProviderServers,
  useProviders,
  useRefreshProviderIcon,
  useUpdateProvider,
} from './providers-api';

const BTN =
  'h-8 rounded-[9px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground';

/**
 * Справочник провайдеров в две панели: слева список с поиском, справа карточка выбранного —
 * иконка, сайт, его серверы и заметка про аккаунт и оплату.
 */
export function ProvidersPage() {
  const providers = useProviders();
  const remove = useDeleteProvider();
  const refresh = useRefreshProviderIcon();
  const [q, setQ] = useState('');
  // По умолчанию сверху те, у кого больше серверов (так отдаёт API); «по имени» — алфавит.
  const [sort, setSort] = useState<'servers' | 'name'>('servers');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const items = providers.data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? items.filter((p) => `${p.name} ${p.siteHost}`.toLowerCase().includes(needle))
      : items;
    return sort === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru')) : list;
  }, [items, q, sort]);
  const activeId = (selected && items.some((p) => p.id === selected) ? selected : filtered[0]?.id) ?? null;
  const active = items.find((p) => p.id === activeId) ?? null;

  const doDelete = async () => {
    if (!active) return;
    try {
      await remove.mutateAsync(active.id);
      setDeleting(false);
      setSelected(null);
      toast.success(`Провайдер «${active.name}» удалён.`);
    } catch (err) {
      setDeleting(false);
      toast.error(apiErrorMessage(err));
    }
  };
  const doRefresh = async () => {
    if (!active) return;
    try {
      const p = await refresh.mutateAsync(active.id);
      toast.success(
        p.hasIcon
          ? isProviderIconServiceUrl(p.iconSourceUrl)
            ? 'На сайте иконки нет, взяли из кэша Google.'
            : 'Иконка обновлена.'
          : 'Иконки не нашлось ни на сайте, ни в кэше Google — осталась буква.',
      );
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  if (providers.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start">
        <Skeleton className="h-[320px] rounded-2xl" />
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
    );
  }
  if (providers.isError) {
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(providers.error)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 basis-[220px]">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
            aria-hidden="true"
          />
          <Input
            aria-label="Поиск по провайдерам"
            placeholder="Название или сайт…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 rounded-[10px] bg-surface-2 pl-9 text-[13px]"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          aria-label={sort === 'servers' ? 'Сортировка: по числу серверов' : 'Сортировка: по имени'}
          title="Сменить сортировку"
          onClick={() => setSort((v) => (v === 'servers' ? 'name' : 'servers'))}
          className="h-9 rounded-[10px] bg-surface-2 px-3 text-[12.5px] text-text-2"
        >
          {sort === 'servers' ? (
            <ArrowDownWideNarrowIcon className="size-4" aria-hidden="true" />
          ) : (
            <ArrowDownAZIcon className="size-4" aria-hidden="true" />
          )}
          {sort === 'servers' ? 'По серверам' : 'По имени'}
        </Button>
        <Button
          type="button"
          onClick={() => setAdding(true)}
          className="h-9 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          Добавить провайдера
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-16 text-center">
          <p className="text-[14px] font-semibold">Провайдеров пока нет</p>
          <p className="mt-1 max-w-[420px] text-[12.5px] text-text-3">
            Добавьте хостеров, у которых куплены серверы: название и сайт. Иконку панель возьмёт с сайта, а на
            карточках серверов появится значок провайдера.
          </p>
          <Button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-4 h-9 rounded-[10px] bg-brand px-4 text-[13px] font-semibold text-(--ns-on-accent) hover:brightness-[1.07]"
          >
            Добавить первого провайдера
          </Button>
        </div>
      ) : (
        // Витрина «Провайдеры», вариант 1: колонки одной высоты, страница не прокручивается,
        // список слева и карточка справа живут в собственной прокрутке.
        <div className="grid gap-4 lg:h-[calc(100dvh-15.5rem)] lg:min-h-[420px] lg:grid-cols-[300px_minmax(0,1fr)]">
          <ul
            className="flex min-h-0 flex-col overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface"
            aria-label="Провайдеры"
          >
            {filtered.length === 0 && (
              <li className="px-4 py-8 text-center text-[12.5px] text-text-3">Ничего не найдено по «{q}».</li>
            )}
            {filtered.map((p) => (
              <li key={p.id} className="border-t border-border first:border-t-0">
                <button
                  type="button"
                  aria-pressed={p.id === activeId}
                  onClick={() => setSelected(p.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2',
                    p.id === activeId && 'bg-surface-2 shadow-[inset_3px_0_0_var(--ns-brand)]',
                  )}
                >
                  <ProviderIcon provider={p} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">{p.name}</span>
                    <span className="block truncate text-[11.5px] text-text-3">
                      {p.serversCount === 0
                        ? 'серверов нет'
                        : `${p.serversCount} ${plural(p.serversCount, 'сервер', 'сервера', 'серверов')}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {active && (
            <ProviderCard
              key={active.id}
              provider={active}
              onEdit={() => setEditing(active)}
              onDelete={() => setDeleting(true)}
              onRefresh={() => void doRefresh()}
              refreshing={refresh.isPending}
            />
          )}
        </div>
      )}

      <ProviderDialog open={adding} onOpenChange={setAdding} onSaved={(p) => setSelected(p.id)} />
      <ProviderDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        provider={editing}
      />
      {active && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          kind="crit"
          title={`Удалить провайдера «${active.name}»?`}
          description={
            active.serversCount > 0
              ? `У ${active.serversCount} ${plural(active.serversCount, 'сервера', 'серверов', 'серверов')} провайдер сбросится, сами серверы останутся.`
              : 'Серверов у него нет, удаление ничего не затронет.'
          }
          yesLabel="Да, удалить"
          loading={remove.isPending}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  onEdit,
  onDelete,
  onRefresh,
  refreshing,
}: {
  provider: Provider;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const servers = useProviderServers(provider.id);
  const update = useUpdateProvider();
  const [note, setNote] = useState(provider.note ?? '');
  useEffect(() => setNote(provider.note ?? ''), [provider.note]);
  const dirty = note.trim() !== (provider.note ?? '');

  const saveNote = async () => {
    try {
      await update.mutateAsync({ id: provider.id, body: { note: note.trim() || null } });
      toast.success('Заметка сохранена.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface"
      data-testid="provider-card"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <ProviderIcon provider={provider} size="lg" />
        <div className="min-w-0 flex-1 basis-[160px]">
          <h2 className="truncate font-heading text-[16px] font-bold">{provider.name}</h2>
          <a
            href={provider.siteUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[12.5px] text-brand underline-offset-2 hover:underline"
          >
            {provider.siteHost}
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
          {provider.iconPending ? (
            <div className="text-[11.5px] text-text-3">Ищем иконку на сайте…</div>
          ) : provider.iconSourceUrl ? (
            isProviderIconServiceUrl(provider.iconSourceUrl) ? (
              <div className="text-[11.5px] text-text-3">Иконка из кэша Google: на сайте её не нашлось</div>
            ) : (
              <div className="truncate text-[11.5px] text-text-3" title={provider.iconSourceUrl}>
                Иконка {provider.iconUrl ? 'по ссылке' : 'с сайта'}:{' '}
                {provider.iconSourceUrl.replace(/^https?:\/\//, '')}
              </div>
            )
          ) : (
            <div className="text-[11.5px] text-text-3">Иконка не найдена — показываем букву</div>
          )}
        </div>
        <div className="flex flex-none flex-wrap gap-2 max-sm:w-full">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            className={BTN}
            title="Заново взять иконку с сайта"
          >
            <RefreshCwIcon className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
            Иконка
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onEdit} className={BTN}>
            <PencilIcon className="size-3.5" aria-hidden="true" />
            Изменить
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDelete}
            className={cn(BTN, 'text-crit hover:bg-crit-soft hover:text-crit')}
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            Удалить
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-5 px-5 py-4">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">Серверы</div>
          {servers.isPending ? (
            <Skeleton className="mt-2 h-10 rounded-[10px]" />
          ) : (servers.data?.length ?? 0) === 0 ? (
            <p className="mt-2 rounded-[10px] border border-dashed border-border-2 px-4 py-4 text-center text-[12.5px] text-text-3">
              Серверов у этого провайдера пока нет. Провайдер выбирается в окне сервера, вкладка
              «Подключение».
            </p>
          ) : (
            <ul className="mt-2 overflow-hidden rounded-[10px] border border-border">
              {servers.data?.map((s) => (
                <li key={s.id} className="border-t border-border first:border-t-0">
                  <Link
                    to="/servers"
                    search={{ open: s.id }}
                    className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                    <span className="text-[12px] text-text-3">открыть →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label
            htmlFor="provider-note"
            className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase"
          >
            Заметка
          </label>
          <div className="mt-2 flex gap-2 max-sm:flex-col">
            <Input
              id="provider-note"
              value={note}
              maxLength={PROVIDER_NOTE_MAX}
              placeholder="Аккаунт, срок оплаты, тариф — что важно помнить об этом хостере"
              onChange={(e) => setNote(e.target.value)}
              className="h-10 flex-1 rounded-[10px] bg-surface-2"
            />
            <Button
              type="button"
              disabled={!dirty || update.isPending}
              onClick={() => void saveNote()}
              className="h-10 flex-none rounded-[10px] bg-brand px-4 text-[13px] font-semibold text-(--ns-on-accent) hover:brightness-[1.07] disabled:opacity-50"
            >
              {update.isPending && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
              Сохранить
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

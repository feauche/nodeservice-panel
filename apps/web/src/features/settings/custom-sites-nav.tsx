import { CUSTOM_SITES_MAX, type CustomSite, type CustomSites, customSitesSchema } from '@nodeservice/shared';
import { ExternalLinkIcon, Globe2Icon, Loader2Icon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useCustomSites, useUpdateCustomSites } from './settings-api';

type Mode = 'rail' | 'drawer';

function normalizedUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Явно указанный чужой протокол оставляем схеме: она покажет ошибку и не превратит его в сайт.
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  return trimmed ? `https://${trimmed}` : trimmed;
}

function SitesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const sites = useCustomSites();
  const update = useUpdateCustomSites();
  const [rows, setRows] = useState<CustomSite[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const initialized = useRef(false);

  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (sites.data && !initialized.current) {
      setRows(sites.data.items.map((site) => ({ ...site })));
      setErrors({});
      initialized.current = true;
    }
  }, [open, sites.data]);

  const patch = (id: string, field: 'name' | 'url', value: string) => {
    setRows((current) => current.map((site) => (site.id === id ? { ...site, [field]: value } : site)));
    setErrors((current) => ({ ...current, [`${id}.${field}`]: '' }));
  };

  const add = () => {
    if (rows.length >= CUSTOM_SITES_MAX) return;
    setRows((current) => [...current, { id: crypto.randomUUID(), name: '', url: '' }]);
  };

  const remove = (id: string) => {
    setRows((current) => current.filter((site) => site.id !== id));
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(id))),
    );
  };

  const save = async () => {
    const normalized = rows.map((site) => ({
      ...site,
      name: site.name.trim(),
      url: normalizedUrl(site.url),
    }));
    const parsed = customSitesSchema.safeParse({ items: normalized } satisfies CustomSites);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const [, index, field] = issue.path;
        const row = typeof index === 'number' ? normalized[index] : undefined;
        if (row && (field === 'name' || field === 'url')) next[`${row.id}.${field}`] ??= issue.message;
        else next.form ??= issue.message;
      }
      setRows(normalized);
      setErrors(next);
      return;
    }
    try {
      await update.mutateAsync(parsed.data);
      onOpenChange(false);
    } catch (error) {
      setErrors({ form: apiErrorMessage(error) });
    }
  };

  const busy = update.isPending;
  const unavailable = sites.isPending || sites.isError || !sites.data;
  const inputClass = 'h-9 rounded-[9px] bg-surface-2 text-[13px]';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="z-[110]"
        className="z-[110] flex max-h-[calc(100dvh-32px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[680px]"
      >
        <DialogHeader className="flex-none gap-1 px-6 pt-5 pb-1">
          <DialogTitle className="font-heading text-[18px]">Свои сайты</DialogTitle>
          <DialogDescription className="text-[13px] text-text-2">
            До пяти нужных сайтов отдельным блоком в боковом меню. Ссылки открываются в новой вкладке.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-4">
          {sites.isPending ? (
            <p className="rounded-[10px] border border-dashed border-border-2 px-4 py-6 text-center text-[13px] text-text-3">
              Загружаю сайты…
            </p>
          ) : sites.isError || !sites.data ? (
            <div className="rounded-[10px] border border-crit/30 bg-crit-soft px-4 py-4 text-center text-[13px] text-text-2">
              <p>Список не загрузился. Сохранение заблокировано, чтобы не потерять ссылки.</p>
              <button
                type="button"
                className="mt-2 cursor-pointer text-brand underline"
                onClick={() => void sites.refetch()}
              >
                Повторить
              </button>
            </div>
          ) : rows.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-border-2 px-4 py-6 text-center text-[13px] text-text-3">
              Пока здесь пусто. Добавьте первую ссылку.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {rows.map((site, index) => {
                const nameError = errors[`${site.id}.name`];
                const urlError = errors[`${site.id}.url`];
                return (
                  <li
                    key={site.id}
                    className="grid grid-cols-[180px_minmax(0,1fr)_36px] items-start gap-2 max-sm:grid-cols-[minmax(0,1fr)_36px]"
                  >
                    <div className="min-w-0">
                      <Input
                        aria-label={`Название сайта ${index + 1}`}
                        placeholder="Название"
                        value={site.name}
                        disabled={busy}
                        aria-invalid={nameError ? true : undefined}
                        onChange={(event) => patch(site.id, 'name', event.target.value)}
                        className={cn(inputClass, nameError && 'border-crit')}
                      />
                      {nameError && <p className="mt-1 text-[11.5px] text-crit">{nameError}</p>}
                    </div>
                    <div className="min-w-0 max-sm:order-3 max-sm:col-span-2">
                      <Input
                        aria-label={`Ссылка сайта ${index + 1}`}
                        placeholder="https://example.com"
                        value={site.url}
                        disabled={busy}
                        inputMode="url"
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-invalid={urlError ? true : undefined}
                        onChange={(event) => patch(site.id, 'url', event.target.value)}
                        onBlur={(event) => patch(site.id, 'url', normalizedUrl(event.target.value))}
                        className={cn(inputClass, 'font-mono text-[12px]', urlError && 'border-crit')}
                      />
                      {urlError && <p className="mt-1 text-[11.5px] text-crit">{urlError}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Удалить сайт ${site.name || index + 1}`}
                      title="Удалить"
                      onClick={() => remove(site.id)}
                      className="grid size-9 cursor-pointer place-items-center rounded-[9px] text-text-3 transition-colors hover:bg-crit-soft hover:text-crit disabled:opacity-50"
                    >
                      <Trash2Icon className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            disabled={busy || unavailable || rows.length >= CUSTOM_SITES_MAX}
            onClick={add}
            className="mt-3 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Добавить сайт
          </button>
          <span className="ml-2 text-[11.5px] text-text-3">
            {rows.length} из {CUSTOM_SITES_MAX}
          </span>
          {errors.form && (
            <p role="alert" className="mt-3 text-[12px] text-crit">
              {errors.form}
            </p>
          )}
        </div>

        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Название и ссылка сохраняются в панели и входят в резервную копию.
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy || unavailable}
              onClick={() => void save()}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Сохранить
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Отдельная группа внешних сайтов в рейле и мобильном меню. */
export function CustomSitesNav({
  collapsed,
  mode,
  onNavigate,
}: {
  collapsed: boolean;
  mode: Mode;
  onNavigate?: () => void;
}) {
  const sites = useCustomSites();
  const [dialogOpen, setDialogOpen] = useState(false);
  const iconOnly = mode === 'rail' && collapsed;
  const railOnPhone = mode === 'rail';
  const hideLabel = iconOnly;
  const items = sites.data?.items ?? [];

  return (
    <>
      <div
        className={cn(
          'mt-1 border-t border-border px-3 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.13em] text-text-3 uppercase',
          hideLabel && 'mx-2 px-0 text-center text-[0px]',
        )}
      >
        <span className={cn(railOnPhone && 'max-md:sr-only', hideLabel && 'sr-only')}>Свои сайты</span>
      </div>

      {items.map((site) => (
        <a
          key={site.id}
          href={site.url}
          target="_blank"
          rel="noopener noreferrer"
          title={iconOnly ? site.name : undefined}
          onClick={onNavigate}
          className={cn(
            'group relative flex items-center gap-[11px] rounded-[10px] px-3 py-[9px] text-[13.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
            railOnPhone && 'max-md:justify-center max-md:px-0',
            iconOnly && 'justify-center px-0',
          )}
        >
          <Globe2Icon className="size-[17px] flex-none" aria-hidden="true" />
          <span
            className={cn('min-w-0 flex-1 truncate', railOnPhone && 'max-md:sr-only', iconOnly && 'sr-only')}
          >
            {site.name}
          </span>
          <ExternalLinkIcon
            className={cn(
              'size-3.5 flex-none text-text-3 opacity-0 transition-opacity group-hover:opacity-100',
              (railOnPhone || iconOnly) && 'max-md:hidden',
              iconOnly && 'hidden',
            )}
            aria-hidden="true"
          />
        </a>
      ))}

      <button
        type="button"
        title={iconOnly ? 'Добавить сайт' : undefined}
        onClick={() => setDialogOpen(true)}
        className={cn(
          'flex w-full cursor-pointer items-center gap-[11px] rounded-[10px] px-3 py-[8px] text-left text-[13px] font-medium text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
          railOnPhone && 'max-md:justify-center max-md:px-0',
          iconOnly && 'justify-center px-0',
        )}
      >
        <PlusIcon className="size-[17px] flex-none" aria-hidden="true" />
        <span
          className={cn('min-w-0 flex-1 truncate', railOnPhone && 'max-md:sr-only', iconOnly && 'sr-only')}
        >
          {items.length >= CUSTOM_SITES_MAX ? 'Управлять сайтами' : 'Добавить сайт'}
        </span>
      </button>

      <SitesDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

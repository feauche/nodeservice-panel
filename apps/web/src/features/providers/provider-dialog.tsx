import {
  createProviderRequestSchema,
  PROVIDER_NAME_MAX,
  type Provider,
  providerIconUrlSchema,
  providerSiteHost,
} from '@nodeservice/shared';
import { Link2Icon, Loader2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/features/auth/components/field';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ProviderIcon } from './provider-icon';
import { providersApi, useCreateProvider, useUpdateProvider } from './providers-api';

const PREVIEW_DEBOUNCE_MS = 500;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Редактирование существующего; без него — создание. */
  provider?: Provider | null;
  /** Созданный/сохранённый провайдер — чтобы выбрать его в селекте или в списке. */
  onSaved?: (provider: Provider) => void;
}

/**
 * Форма провайдера: название и сайт, иконку панель находит на сайте сама и показывает превью
 * ещё до сохранения. Ссылку на иконку можно задать вручную — тогда берётся только она; в форме
 * «Изменить» поле уже заполнено адресом, откуда иконка взята. Открывается и из справочника,
 * и из окна сервера, и из формы добавления — поэтому z-index выше остальных диалогов.
 */
export function ProviderDialog({ open, onOpenChange, provider = null, onSaved }: Props) {
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const [name, setName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [iconOpen, setIconOpen] = useState(false);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{
    icon: string | null;
    source: string | null;
    manual: boolean;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSeq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: форма заполняется при открытии
  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setSiteUrl(provider?.siteUrl ?? '');
    const knownIcon = provider?.iconUrl ?? provider?.iconSourceUrl ?? '';
    setIconUrl(knownIcon);
    setIconOpen(Boolean(knownIcon));
    setNote(provider?.note ?? '');
    setErrors({});
    setPreview(null);
    setPreviewing(false);
  }, [open, provider?.id]);

  // Ручная ссылка — то, что отличается от найденной автоматически (в «Изменить» поле заполнено ею).
  const autoBaseline = provider && !provider.iconUrl ? (provider.iconSourceUrl ?? '') : '';
  const manualUrl = iconUrl.trim() === autoBaseline ? '' : iconUrl.trim();
  const siteChanged = siteUrl.trim() !== (provider?.siteUrl ?? '');
  const manualChanged = manualUrl !== (provider?.iconUrl ?? '');

  // Превью: когда перестали печатать, спрашиваем у API (оно само сходит на сайт или по ссылке).
  useEffect(() => {
    if (!open) return;
    const site = siteUrl.trim();
    if (!site || (!siteChanged && !manualChanged)) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const res = await providersApi.preview(site, manualUrl || null);
        if (seq === previewSeq.current)
          setPreview({ icon: res.iconDataUrl, source: res.sourceUrl, manual: Boolean(manualUrl) });
      } catch {
        if (seq === previewSeq.current) setPreview({ icon: null, source: null, manual: Boolean(manualUrl) });
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [siteUrl, manualUrl, siteChanged, manualChanged, open]);

  const busy = create.isPending || update.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Диалог открывается из форм сервера (окно сервера, добавление): submit через портал всплывает
    // по дереву React до внешней формы и отправил бы её — останавливаем здесь.
    e.stopPropagation();
    if (busy) return;
    const parsed = createProviderRequestSchema.safeParse({
      name,
      siteUrl,
      ...(note.trim() ? { note } : {}),
      ...(manualUrl ? { iconUrl: manualUrl } : {}),
    });
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      if (byPath.iconUrl) setIconOpen(true);
      setErrors(byPath);
      return;
    }
    try {
      const saved = provider
        ? await update.mutateAsync({
            id: provider.id,
            body: {
              name: parsed.data.name,
              siteUrl: parsed.data.siteUrl,
              note: note.trim() || null,
              iconUrl: parsed.data.iconUrl ?? null,
            },
          })
        : await create.mutateAsync(parsed.data);
      toast.success(provider ? `«${saved.name}» сохранён.` : `Провайдер «${saved.name}» добавлен.`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err) && err.errors.length > 0) {
        const byPath: Record<string, string> = {};
        for (const er of err.errors) byPath[er.path] ??= er.message;
        if (byPath.iconUrl) setIconOpen(true);
        setErrors(byPath);
      } else setErrors({ form: apiErrorMessage(err) });
    }
  };

  const previewProvider = {
    id: provider?.id ?? 'new',
    name: name || providerSiteHost(siteUrl) || '?',
    hasIcon: provider?.hasIcon ?? false,
    iconVersion: provider?.iconVersion ?? 0,
  };
  const iconSrc = preview ? preview.icon : undefined;
  const iconState = previewing
    ? manualUrl
      ? 'проверяем ссылку…'
      : 'ищем на сайте…'
    : preview
      ? preview.icon
        ? preview.manual
          ? 'по ссылке — нашли'
          : 'нашли на сайте'
        : preview.manual
          ? 'по ссылке картинки нет — будет буква'
          : 'на сайте иконки нет — будет буква'
      : provider?.hasIcon
        ? provider.iconUrl
          ? 'по ручной ссылке'
          : 'найдена на сайте'
        : siteUrl.trim()
          ? 'не нашли — будет буква'
          : 'появится после ввода сайта';
  const iconHint = manualUrl
    ? 'Берём только эту картинку. Очистите поле — панель снова будет искать на сайте.'
    : iconUrl.trim()
      ? 'Найдена на сайте автоматически. Замените, если нужна другая.'
      : 'Пусто — панель найдёт иконку на сайте сама.';
  const iconUrlValid = !iconUrl.trim() || providerIconUrlSchema.safeParse(iconUrl).success;
  const iconError =
    errors.iconUrl || (!iconUrlValid ? 'Нужна ссылка на картинку (http или https)' : undefined);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="z-[110]"
        className="z-[110] flex max-h-[calc(100vh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[520px]"
      >
        <DialogHeader className="flex-none gap-1 px-6 pt-5 pb-1">
          <DialogTitle className="font-heading text-[18px]">
            {provider ? 'Изменить провайдера' : 'Новый провайдер'}
          </DialogTitle>
          <DialogDescription className="text-[13px] text-text-2">
            Хостер, у которого куплен сервер. Иконку панель возьмёт с его сайта сама.
          </DialogDescription>
        </DialogHeader>
        <form
          id="provider-form"
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-4 pb-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="prov-name"
              label={
                <>
                  Название
                  <span className="ml-0.5 text-crit after:content-['*']" aria-hidden="true" />
                </>
              }
              error={errors.name || undefined}
            >
              <Input
                id="prov-name"
                autoFocus
                disabled={busy}
                maxLength={PROVIDER_NAME_MAX}
                placeholder="Hetzner"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? 'prov-name-error' : undefined}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setErrors((p) => ({ ...p, name: '', form: '' }));
                }}
                className="h-10 rounded-[10px] bg-surface-2"
              />
            </Field>
            <Field
              id="prov-site"
              label={
                <>
                  Сайт
                  <span className="ml-0.5 text-crit after:content-['*']" aria-hidden="true" />
                </>
              }
              error={errors.siteUrl || undefined}
            >
              <Input
                id="prov-site"
                disabled={busy}
                placeholder="hetzner.com"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={errors.siteUrl ? true : undefined}
                aria-describedby={errors.siteUrl ? 'prov-site-error' : undefined}
                value={siteUrl}
                onChange={(e) => {
                  setSiteUrl(e.target.value);
                  setErrors((p) => ({ ...p, siteUrl: '', form: '' }));
                }}
                className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
              />
            </Field>
          </div>

          <div className="rounded-[10px] border border-border bg-surface-2">
            <div className="flex items-center gap-3 px-3 py-2">
              <ProviderIcon provider={previewProvider} size="lg" src={iconSrc} />
              <div className="min-w-0 flex-1 text-[12.5px]">
                <div className="font-medium">Иконка</div>
                <div className={cn('flex items-center gap-1.5 text-text-3', previewing && 'text-text-2')}>
                  {previewing && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
                  <span data-testid="provider-icon-state">{iconState}</span>
                </div>
              </div>
              <button
                type="button"
                aria-expanded={iconOpen}
                aria-controls="prov-icon-url-field"
                onClick={() => setIconOpen((v) => !v)}
                className="flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-[8px] border border-border bg-surface px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
              >
                <Link2Icon className="size-3.5" aria-hidden="true" />
                {iconOpen ? 'Скрыть ссылку' : manualUrl ? 'Изменить ссылку' : 'Указать ссылку'}
              </button>
            </div>
            {/* Плавно: высота через grid-rows, как и всё раскрывающееся в панели */}
            <div
              id="prov-icon-url-field"
              className={cn(
                'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                iconOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="border-t border-border px-3 pt-3 pb-3">
                  <Field
                    id="prov-icon-url"
                    label="Ссылка на иконку"
                    hint={iconError ? undefined : iconHint}
                    error={iconError}
                  >
                    <Input
                      id="prov-icon-url"
                      disabled={busy}
                      tabIndex={iconOpen ? undefined : -1}
                      placeholder="https://site.com/favicon.svg"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-invalid={iconError ? true : undefined}
                      aria-describedby={iconError ? 'prov-icon-url-error' : 'prov-icon-url-hint'}
                      value={iconUrl}
                      onChange={(e) => {
                        setIconUrl(e.target.value);
                        setErrors((p) => ({ ...p, iconUrl: '', form: '' }));
                      }}
                      className="h-10 rounded-[10px] bg-surface font-mono text-[12.5px]"
                    />
                  </Field>
                </div>
              </div>
            </div>
          </div>

          <Field id="prov-note" label="Заметка" error={errors.note || undefined}>
            <Input
              id="prov-note"
              disabled={busy}
              placeholder="Необязательно: аккаунт, срок оплаты, тариф"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>
          {errors.form && (
            <p role="alert" className="text-[12px] text-crit">
              {errors.form}
            </p>
          )}
        </form>
        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            <span className="text-crit">*</span> обязательные поля. Провайдер общий для всех серверов.
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
              type="submit"
              form="provider-form"
              disabled={busy}
              className="h-10 flex-none rounded-[10px] px-4 sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {provider ? 'Сохранить' : 'Добавить'}
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

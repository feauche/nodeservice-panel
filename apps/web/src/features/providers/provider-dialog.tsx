import {
  createProviderRequestSchema,
  PROVIDER_NAME_MAX,
  type Provider,
  providerSiteHost,
} from '@nodeservice/shared';
import { Loader2Icon } from 'lucide-react';
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
 * ещё до сохранения. Открывается и из справочника, и из окна сервера, и из формы добавления —
 * поэтому z-index выше остальных диалогов.
 */
export function ProviderDialog({ open, onOpenChange, provider = null, onSaved }: Props) {
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const [name, setName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; icon: string | null } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSeq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: форма заполняется при открытии
  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setSiteUrl(provider?.siteUrl ?? '');
    setNote(provider?.note ?? '');
    setErrors({});
    setPreview(null);
  }, [open, provider?.id]);

  // Превью иконки: когда адрес перестали печатать, спрашиваем у API (оно само сходит на сайт).
  useEffect(() => {
    if (!open) return;
    const raw = siteUrl.trim();
    if (!raw || raw === provider?.siteUrl) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const res = await providersApi.preview(raw);
        if (seq === previewSeq.current) setPreview({ url: raw, icon: res.iconDataUrl });
      } catch {
        if (seq === previewSeq.current) setPreview({ url: raw, icon: null });
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [siteUrl, open, provider?.siteUrl]);

  const busy = create.isPending || update.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Диалог открывается из форм сервера (окно сервера, добавление): submit через портал всплывает
    // по дереву React до внешней формы и отправил бы её — останавливаем здесь.
    e.stopPropagation();
    if (busy) return;
    const parsed = createProviderRequestSchema.safeParse({ name, siteUrl, ...(note.trim() ? { note } : {}) });
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      setErrors(byPath);
      return;
    }
    try {
      const saved = provider
        ? await update.mutateAsync({
            id: provider.id,
            body: { name: parsed.data.name, siteUrl: parsed.data.siteUrl, note: note.trim() || null },
          })
        : await create.mutateAsync(parsed.data);
      toast.success(provider ? `«${saved.name}» сохранён.` : `Провайдер «${saved.name}» добавлен.`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err) && err.errors.length > 0) {
        const byPath: Record<string, string> = {};
        for (const er of err.errors) byPath[er.path] ??= er.message;
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
    ? 'ищем на сайте…'
    : preview
      ? preview.icon
        ? 'нашли на сайте'
        : 'на сайте иконки нет — будет буква'
      : provider?.hasIcon
        ? 'с сайта'
        : 'появится после ввода сайта';

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
        <form id="provider-form" onSubmit={submit} noValidate className="flex flex-col gap-4 px-6 pt-4 pb-5">
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
          <div className="flex items-center gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
            <ProviderIcon provider={previewProvider} size="lg" src={iconSrc} />
            <div className="min-w-0 text-[12.5px]">
              <div className="font-medium">Иконка</div>
              <div className={cn('flex items-center gap-1.5 text-text-3', previewing && 'text-text-2')}>
                {previewing && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
                <span data-testid="provider-icon-state">{iconState}</span>
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

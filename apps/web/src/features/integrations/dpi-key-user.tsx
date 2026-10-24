import { type DpiKeyPreview, dpiKeyPreviewSchema, dpiKeyUserSchema } from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheckIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';

/** Служебный пользователь Remnawave для ключей проверки VPN (витрина reference-pack-2026-10, раздел 2 — A). */
export const DPI_KEY_USER = ['dpi-key-user'] as const;
export const useDpiKeyUser = (enabled = true) =>
  useQuery({
    queryKey: DPI_KEY_USER,
    queryFn: ({ signal }) => api.get('/integrations/dpi/key-user', dpiKeyUserSchema, signal),
    staleTime: 60_000,
    enabled,
  });
/** Какой ключ возьмётся для ноды — заново при каждом открытии окна: подписка могла измениться. */
export const useDpiKeyPreview = (node: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ['dpi-key', node],
    queryFn: ({ signal }) => api.get(`/integrations/dpi/key/${node}`, dpiKeyPreviewSchema, signal),
    enabled: enabled && Boolean(node),
    retry: false,
    staleTime: 0,
  });

/**
 * «Пользователь для ключей» в «Подключении» DPI Checker: имя служебного пользователя Remnawave и, по нодам, есть ли
 * ключ в его подписке. Без пользователя ключ для проверки VPN вставляется вручную, как раньше.
 */
export function DpiKeyUserCard() {
  const client = useQueryClient();
  const id = useId();
  const query = useDpiKeyUser();
  const [name, setName] = useState('');
  const saved = query.data?.username ?? null;
  useEffect(() => setName(saved ?? ''), [saved]);
  const save = useMutation({
    mutationFn: (username: string | null) =>
      api.put('/integrations/dpi/key-user', { username }, dpiKeyUserSchema),
    onSuccess: (data) => {
      client.setQueryData(DPI_KEY_USER, data);
      void client.invalidateQueries({ queryKey: ['dpi-key'] });
    },
  });
  const data = query.data;
  const missing = data?.nodes.filter((n) => !n.host) ?? [];
  const total = data?.nodes.length ?? 0;
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(name.trim() || null);
  }
  return (
    <form
      onSubmit={submit}
      aria-label="Пользователь для ключей"
      className="flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface"
    >
      <div className="flex min-h-[72px] flex-wrap items-center gap-3 border-b border-border px-[18px] py-4 max-md:px-4">
        <span className="grid size-10 flex-none place-items-center rounded-[11px] border border-border bg-surface-2 text-text-2">
          <KeyRoundIcon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[15px] font-semibold">Ключ для проверки VPN</h2>
          <p className="mt-0.5 text-[12px] text-text-3">Необязательно. Без него ключ вставляется вручную.</p>
        </div>
        {query.isPending ? (
          <Skeleton className="h-6 w-28 rounded-full" />
        ) : !saved ? (
          <Pill>Вставлять вручную</Pill>
        ) : data?.error ? (
          <Pill tone="crit">Ключа нет</Pill>
        ) : (
          <Pill tone={missing.length ? 'warn' : 'ok'}>
            {missing.length
              ? `Ключи для ${total - missing.length} из ${total} ${plural(total, 'ноды', 'нод', 'нод')}`
              : 'Ключи для всех нод'}
          </Pill>
        )}
      </div>
      <div className="flex flex-col gap-3 px-[18px] py-4 max-md:px-4">
        <div className="min-w-0">
          <label htmlFor={`${id}-user`} className="mb-1.5 block text-[12.5px] font-medium text-text-2">
            Пользователь Remnawave для ключей
          </label>
          <Input
            id={`${id}-user`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            placeholder="Например, nodeservice-check"
            className="h-10 w-full rounded-[10px] bg-surface-2"
          />
        </div>
        <p className="text-[12px] leading-[18px] text-text-3">
          Создайте в Remnawave отдельного пользователя без срока, со сквадом, в котором все ноды, и впишите
          сюда его имя. Перед каждой проверкой VPN панель возьмёт ключ нужной ноды из его подписки — живых
          клиентов это не касается, в Remnawave панель ничего не меняет. Нужно право ключа Remnawave читать
          подписки.
        </p>
        {saved && data?.error && (
          <p
            role="alert"
            className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
          >
            {data.error}
          </p>
        )}
        {saved && !data?.error && missing.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-warn/35 bg-warn/[0.06] px-3 py-2.5">
            <p className="m-0 text-[12.5px] font-semibold text-warn">
              {missing.length === 1 ? 'Для этой ноды' : 'Для этих нод'} ключ придётся вставлять вручную
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {missing.map((n) => (
                <li key={n.uuid} className="text-[12.5px] leading-snug text-text-2">
                  <b className="font-semibold text-foreground">{n.name}</b> — {n.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {save.error && (
          <p
            role="alert"
            className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
          >
            {apiErrorMessage(save.error)}
          </p>
        )}
      </div>
      <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-[18px] py-3.5 max-md:px-4 max-sm:flex-col max-sm:items-stretch">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
          Сохранение сразу проверяет подписку: для каких нод ключ найдётся.
        </p>
        {saved && (
          <DialogSecondaryButton
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
            className="h-10 w-[180px] flex-none rounded-[10px] max-sm:w-full sm:w-[180px] sm:flex-none sm:max-w-none"
          >
            Вставлять вручную
          </DialogSecondaryButton>
        )}
        <DialogPrimaryButton
          type="submit"
          disabled={save.isPending || !name.trim()}
          className="h-10 w-[180px] flex-none rounded-[10px] max-sm:w-full sm:w-[180px] sm:flex-none sm:max-w-none"
        >
          {save.isPending ? 'Проверяю…' : 'Сохранить'}
        </DialogPrimaryButton>
      </div>
    </form>
  );
}

/**
 * Откуда возьмётся ключ в окне «Новая проверка»: из подписки служебного пользователя (Host и ключ со скрытым
 * идентификатором) или почему его там нет.
 */
export function KeySource({
  username,
  preview,
  pending,
  error,
  onManual,
}: {
  username: string;
  preview: DpiKeyPreview | undefined;
  pending: boolean;
  error: string | null;
  onManual: () => void;
}) {
  const bad = Boolean(error);
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-[12px] border px-3.5 py-3',
        bad ? 'border-warn/40 bg-warn/[0.06]' : 'border-ok/35 bg-ok/[0.06]',
      )}
    >
      {bad ? (
        <TriangleAlertIcon className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
      ) : (
        <CircleCheckIcon className="mt-0.5 size-4 flex-none text-ok" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <b className="block text-[13px] font-semibold">
          {bad ? `Ключа в подписке «${username}» нет` : `Ключ возьмётся из подписки «${username}»`}
        </b>
        {pending ? (
          <Skeleton className="mt-1.5 h-4 w-3/4 rounded-[6px]" />
        ) : bad ? (
          <p className="m-0 mt-1 text-[12px] leading-snug text-text-3">{error}</p>
        ) : (
          preview && (
            <>
              <p className="m-0 mt-1 text-[12px] leading-snug text-text-3">
                Для Host «{preview.host}» — {preview.address}:{preview.port}. Ключ берётся заново перед каждой
                проверкой, поэтому всегда свежий.
                {preview.shared && ' Host общий с другими нодами — подключение может прийти на любую из них.'}
              </p>
              <p className="m-0 mt-1.5 font-mono text-[11.5px] break-all text-text-2">{preview.preview}</p>
            </>
          )
        )}
        <button
          type="button"
          onClick={onManual}
          className="mt-1.5 cursor-pointer text-[12.5px] text-brand hover:underline"
        >
          Вставить свой ключ
        </button>
      </div>
    </div>
  );
}

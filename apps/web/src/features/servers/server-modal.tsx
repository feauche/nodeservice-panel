import {
  AGENT_STATUS_LABELS,
  type MetricRange,
  type Server,
  type SshAuth,
  type UpdateServerRequest,
  updateServerRequestSchema,
} from '@nodeservice/shared';
import {
  CopyPlusIcon,
  Loader2Icon,
  MoreVerticalIcon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Field } from '@/features/auth/components/field';
import { PasswordField } from '@/features/auth/components/password-field';
import { formatAgo } from '@/features/security/security-format';
import { StepUpCancelledError } from '@/features/security/step-up';
import { Pill } from '@/features/settings/settings-ui';
import { useTerminalStore } from '@/features/terminal/terminal-store';
import { apiErrorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AgentInstallDialog } from './agent-install-dialog';
import { osLine, SshPill } from './server-card';
import { JournalTab } from './server-detail/journal-tab';
import { MetricsTab } from './server-detail/metrics-tab';
import { useCheckServer, useDeleteServer, useDuplicateServer, useUpdateServer } from './servers-api';

export type ServerModalTab = 'metrics' | 'journal' | 'connection';

const TABS: Array<{ key: ServerModalTab; label: string }> = [
  { key: 'metrics', label: 'Метрики' },
  { key: 'journal', label: 'Журнал' },
  { key: 'connection', label: 'Подключение' },
];

interface Props {
  server: Server | null;
  initialTab: ServerModalTab;
  onClose: () => void;
}

/**
 * Большая модалка сервера: шапка с действиями и навигация «Метрики / Журнал / Подключение».
 * «Подключение» объединяет бывшие настройки (имя/теги/адрес/доступы/заметка) с футером действий.
 */
export function ServerModal({ server, initialTab, onClose }: Props) {
  const check = useCheckServer();
  const duplicate = useDuplicateServer();
  const remove = useDeleteServer();
  const [tab, setTab] = useState<ServerModalTab>(initialTab);
  const [range, setRange] = useState<MetricRange>('1h');
  const [installOpen, setInstallOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: вкладка выставляется при каждом открытии
  useEffect(() => {
    if (server) setTab(initialTab);
  }, [server?.id, initialTab]);

  if (!server) return null;
  const s = server;

  const resources = [
    osLine(s),
    s.facts.cpuCores ? `${s.facts.cpuCores} CPU` : null,
    s.facts.memoryMb ? `${Math.round(s.facts.memoryMb / 1024)} ГБ RAM` : null,
    s.lastSshCheckAt ? `проверено ${formatAgo(s.lastSshCheckAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const doCheck = async () => {
    try {
      await check.mutateAsync(s.id);
      toast.success(`${s.name}: связь работает. Данные о системе обновлены.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const doDuplicate = async () => {
    try {
      const copy = await duplicate.mutateAsync(s.id);
      toast.success(`Создана копия «${copy.name}».`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const doDelete = async () => {
    try {
      await remove.mutateAsync(s.id);
      setDeleteOpen(false);
      onClose();
      toast.success(`Сервер «${s.name}» удалён.`);
    } catch (err) {
      setDeleteOpen(false);
      if (!(err instanceof StepUpCancelledError)) toast.error(apiErrorMessage(err));
    }
  };

  return (
    <Dialog open modal={false} onOpenChange={(o) => !o && onClose()}>
      {/* Свой блюр-фон: в неблокирующем режиме Radix не рисует overlay, а плавающий терминал (z-90)
          должен оставаться кликабельным. Сам фон (z-40 — под контентом модалки z-50 и терминалом)
          закрывает модалку по клику, как привычный overlay; клики по терминалу/меню/селектам лежат
          выше фона и до него не доходят — поэтому модалку не роняют. */}
      {createPortal(
        <button
          type="button"
          aria-label="Закрыть"
          tabIndex={-1}
          onClick={onClose}
          className="fixed inset-0 z-40 cursor-default bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
        />,
        document.body,
      )}
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="flex h-[min(780px,calc(100vh-56px))] w-[min(1120px,calc(100vw-40px))] flex-col gap-0 overflow-hidden rounded-2xl border-border bg-surface p-0 sm:max-w-[1120px]"
      >
        {/* Шапка */}
        <DialogHeader className="flex-none gap-1 border-b border-border px-6 pt-5 pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2.5">
                <DialogTitle className="truncate font-heading text-[20px] font-bold tracking-[-0.01em]">
                  {s.name}
                </DialogTitle>
                <Pill
                  tone={s.agentStatus === 'online' ? 'ok' : s.agentStatus === 'offline' ? 'crit' : 'muted'}
                >
                  {AGENT_STATUS_LABELS[s.agentStatus]}
                </Pill>
                <SshPill server={s} />
              </div>
              <DialogDescription className="mt-1 truncate font-mono text-[12px] text-text-3">
                {s.sshUser}@{s.host}:{s.port}
              </DialogDescription>
              {resources && <p className="mt-0.5 truncate text-[12.5px] text-text-2">{resources}</p>}
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={check.isPending}
                onClick={() => void doCheck()}
                className="h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground"
              >
                <RefreshCwIcon
                  className={cn('size-3.5', check.isPending && 'animate-spin')}
                  aria-hidden="true"
                />
                Проверить связь
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Действия с ${s.name}`}
                    className="size-9 rounded-[10px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
                  >
                    <MoreVerticalIcon className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[220px]">
                  {s.agentStatus !== 'online' && (
                    <DropdownMenuItem onSelect={() => setInstallOpen(true)}>
                      <TerminalIcon className="size-4" aria-hidden="true" />
                      Установить агента
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem disabled={duplicate.isPending} onSelect={() => void doDuplicate()}>
                    <CopyPlusIcon className="size-4" aria-hidden="true" />
                    Дублировать
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                    <Trash2Icon className="size-4" aria-hidden="true" />
                    Удалить
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="outline"
                aria-label="Закрыть"
                onClick={onClose}
                className="size-9 rounded-[10px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
          {/* Навигация модалки */}
          <fieldset className="m-0 mt-3 flex h-10 w-fit items-center rounded-[11px] border border-border bg-surface-2 p-[3px]">
            <legend className="sr-only">Разделы сервера</legend>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'h-full cursor-pointer rounded-[8px] px-4 text-[13px] font-semibold text-text-3 transition-colors hover:text-foreground',
                  tab === t.key && 'bg-surface text-foreground shadow-[0_1px_0_var(--ns-hairline)]',
                )}
              >
                {t.label}
              </button>
            ))}
          </fieldset>
        </DialogHeader>

        {/* Контент вкладки */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {tab === 'metrics' && <MetricsTab serverId={s.id} range={range} onRange={setRange} />}
          {tab === 'journal' && <JournalTab serverId={s.id} />}
          {tab === 'connection' && (
            <ConnectionTab server={s} onDelete={() => setDeleteOpen(true)} onDuplicate={doDuplicate} />
          )}
        </div>

        <AgentInstallDialog server={s} open={installOpen} onOpenChange={setInstallOpen} />
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          kind="crit"
          title={`Удалить «${s.name}»?`}
          description="Сервер пропадёт из панели вместе с историей проверок. Сам сервер и то, что на нём установлено, не трогаем."
          yesLabel="Да, удалить"
          loading={remove.isPending}
          onConfirm={doDelete}
        />
      </DialogContent>
    </Dialog>
  );
}

const AUTH_TABS = [
  { key: 'keep', label: 'Не менять' },
  { key: 'password', label: 'Пароль' },
  { key: 'key', label: 'Свой ключ' },
  { key: 'panel-key', label: 'Ключ панели' },
] as const;

/** «Подключение»: бывшие настройки одним экраном — общее и доступы SSH, футер действий. */
function ConnectionTab({
  server,
  onDelete,
  onDuplicate,
}: {
  server: Server;
  onDelete: () => void;
  onDuplicate: () => Promise<void>;
}) {
  const update = useUpdateServer();
  const openTerminal = useTerminalStore((st) => st.open);
  const [form, setForm] = useState({ name: '', host: '', port: '22', sshUser: '', tags: '', notes: '' });
  const [authTab, setAuthTab] = useState<(typeof AUTH_TABS)[number]['key']>('keep');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyExtra, setBusyExtra] = useState(false);

  useEffect(() => {
    setForm({
      name: server.name,
      host: server.host,
      port: String(server.port),
      sshUser: server.sshUser,
      tags: server.tags.join(', '),
      notes: server.notes ?? '',
    });
    setAuthTab('keep');
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    setErrors({});
  }, [server]);

  const endpointChanged =
    form.host !== server.host || form.port !== String(server.port) || form.sshUser !== server.sshUser;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const auth: SshAuth | undefined =
      authTab === 'keep'
        ? undefined
        : authTab === 'password'
          ? { method: 'password', password }
          : authTab === 'key'
            ? { method: 'key', privateKey, ...(passphrase ? { passphrase } : {}) }
            : { method: 'panel-key' };
    const parsed = updateServerRequestSchema.safeParse({
      name: form.name,
      host: form.host,
      port: form.port,
      sshUser: form.sshUser,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: form.notes.trim() ? form.notes.trim() : null,
      ...(auth ? { auth } : {}),
    });
    if (!parsed.success) {
      const byPath: Record<string, string> = {};
      for (const issue of parsed.error.issues) byPath[String(issue.path[0])] ??= issue.message;
      setErrors(byPath);
      return;
    }
    try {
      await update.mutateAsync({ id: server.id, patch: parsed.data as UpdateServerRequest });
      setErrors({});
      toast.success(`«${parsed.data.name ?? server.name}» сохранён.`);
    } catch (err) {
      if (isApiError(err) && err.errors.length > 0) {
        const byPath: Record<string, string> = {};
        for (const er of err.errors) byPath[er.path] ??= er.message;
        setErrors(byPath);
      } else setErrors({ form: apiErrorMessage(err) });
    }
  };

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((p) => ({ ...p, [key]: '', form: '' }));
  };

  const busy = update.isPending || busyExtra;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mx-auto flex min-h-full w-full max-w-[880px] flex-col gap-4"
    >
      {/* Общее */}
      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">Общее</h3>
          <span className="text-[12px] text-text-3">на связь не влияет</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="sm-name" label="Название" error={errors.name || undefined}>
            <Input
              id="sm-name"
              value={form.name}
              onChange={set('name')}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>
          <Field id="sm-tags" label="Теги (через запятую)" error={errors.tags || undefined}>
            <Input
              id="sm-tags"
              value={form.tags}
              onChange={set('tags')}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field id="sm-notes" label="Заметка" error={errors.notes || undefined}>
            <Input
              id="sm-notes"
              value={form.notes}
              onChange={set('notes')}
              className="h-10 rounded-[10px] bg-surface-2"
            />
          </Field>
        </div>
      </section>

      {/* Доступ по SSH */}
      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">Доступ по SSH</h3>
          <span className="text-[12px] text-text-3">
            {authTab !== 'keep'
              ? 'новые доступы проверяются настоящим подключением, пароль не сохраняется'
              : endpointChanged
                ? 'смена адреса или пользователя сбросит отпечаток сервера'
                : 'адрес, пользователь и способ входа'}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_110px_200px]">
          <Field id="sm-host" label="IP или домен" error={errors.host || undefined}>
            <Input
              id="sm-host"
              value={form.host}
              onChange={set('host')}
              className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
            />
          </Field>
          <Field id="sm-port" label="Порт" error={errors.port || undefined}>
            <Input
              id="sm-port"
              inputMode="numeric"
              value={form.port}
              onChange={set('port')}
              className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
            />
          </Field>
          <Field id="sm-user" label="Пользователь SSH" error={errors.sshUser || undefined}>
            <Input
              id="sm-user"
              value={form.sshUser}
              onChange={set('sshUser')}
              className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
            />
          </Field>
        </div>
        <div className="mt-4">
          <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface-2 p-[3px]">
            <legend className="sr-only">Доступы SSH</legend>
            {AUTH_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={authTab === t.key}
                className={cn(
                  'h-full cursor-pointer rounded-[7px] px-3 text-[12px] font-medium text-text-3 transition-colors hover:text-foreground',
                  authTab === t.key && 'bg-surface text-foreground shadow-[0_1px_0_var(--ns-hairline)]',
                )}
                onClick={() => {
                  setAuthTab(t.key);
                  setErrors({});
                }}
              >
                {t.label}
              </button>
            ))}
          </fieldset>
          {authTab === 'password' && (
            <div className="mt-3 max-w-[420px]">
              <Field
                id="sm-password"
                label="Новый пароль SSH"
                hint="Нужен один раз: панель заново поставит свой ключ и продолжит ходить по нему."
                error={errors.password || undefined}
              >
                <PasswordField
                  id="sm-password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
          )}
          {authTab === 'key' && (
            <div className="mt-3 flex max-w-[640px] flex-col gap-3.5">
              <Field id="sm-key" label="Приватный ключ (OpenSSH/PEM)" error={errors.privateKey || undefined}>
                <textarea
                  id="sm-key"
                  rows={4}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  className="w-full resize-y rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] outline-none focus-visible:border-brand/50"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </Field>
              <Field id="sm-passphrase" label="Пароль от ключа (если есть)">
                <PasswordField
                  id="sm-passphrase"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
            </div>
          )}
          {authTab === 'panel-key' && (
            <p className="mt-3 text-[12.5px] text-text-2">
              Перейти на ключ панели (он уже должен быть в authorized_keys на сервере).
            </p>
          )}
        </div>
      </section>

      {/* Опасная зона */}
      <section className="rounded-2xl border border-crit/30 bg-crit-soft/15 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold tracking-[0.09em] text-crit uppercase">Опасная зона</h3>
            <p className="mt-1 text-[12.5px] text-text-2">
              Сервер пропадёт из панели вместе с историей проверок. Сам сервер и то, что на нём установлено,
              не трогаем.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onDelete}
            className="h-9 flex-none rounded-[10px] border-crit/40 bg-crit-soft px-3.5 text-[12.5px] font-semibold text-crit hover:bg-crit-soft hover:brightness-115"
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            Удалить сервер
          </Button>
        </div>
      </section>

      {errors.form && (
        <p role="alert" className="text-[12px] text-crit">
          {errors.form}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-center gap-3 border-t border-border pt-4 max-sm:flex-col">
        <DialogSecondaryButton
          disabled={busy}
          onClick={() =>
            openTerminal({
              id: server.id,
              name: server.name,
              host: server.host,
              port: server.port,
              sshUser: server.sshUser,
            })
          }
        >
          <TerminalIcon className="size-4" aria-hidden="true" />
          SSH-терминал
        </DialogSecondaryButton>
        <DialogSecondaryButton
          disabled={busy}
          onClick={() => {
            setBusyExtra(true);
            void onDuplicate().finally(() => setBusyExtra(false));
          }}
        >
          <CopyPlusIcon className="size-4" aria-hidden="true" />
          Дублировать
        </DialogSecondaryButton>
        <DialogPrimaryButton type="submit" disabled={busy}>
          {update.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
          Сохранить
        </DialogPrimaryButton>
      </div>
    </form>
  );
}

import {
  type IntegrationConnection,
  type IntegrationProvider,
  type IntegrationStatus,
  integrationStatusSchema,
  integrationsStatusSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon, UnplugIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DialogPrimaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { formatDate } from '@/features/security/security-format';
import { Pill, RowButton, SettingsCard } from '@/features/settings/settings-ui';
import { api, apiErrorMessage, request } from '@/lib/api';
import { BsBalanceSkeleton, BsCheckerWorkspace } from './bschecker-workspace';
import { DnsWorkspace, DpiWorkspace, DpiWorkspaceSkeleton } from './workspace';

const key = ['integrations'] as const;
const names = { dpi: 'DPI Checker', regru: 'REG.RU', cloudflare: 'Cloudflare', bschecker: 'BS Checker' };
function ConnectionCard({
  provider,
  status,
  embedded = false,
}: {
  provider: IntegrationProvider;
  status?: IntegrationStatus;
  embedded?: boolean;
}) {
  const client = useQueryClient();
  const id = useId();
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation({
    mutationFn: async ({
      action,
      body,
    }: {
      action: 'connect' | 'refresh' | 'disconnect';
      body?: IntegrationConnection;
    }) =>
      action === 'disconnect'
        ? request(`/integrations/${provider}`, { method: 'DELETE' })
        : api.post(`/integrations/${provider}/${action}`, body ?? {}, integrationStatusSchema),
    onSuccess: () => {
      setApiKey('');
      setPassword('');
      setConfirm(false);
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ['dpi-workspace'] });
      void client.invalidateQueries({ queryKey: ['bschecker-workspace'] });
      void client.invalidateQueries({ queryKey: ['dns-workspace'] });
      void client.invalidateQueries({ queryKey: ['dns-history'] });
    },
  });
  async function run(action: 'connect' | 'refresh' | 'disconnect') {
    setError(null);
    try {
      await mutation.mutateAsync({
        action,
        body: action === 'connect' ? (provider === 'regru' ? { username, password } : { apiKey }) : undefined,
      });
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void run('connect');
  }
  return (
    <form
      id={id}
      onSubmit={submit}
      data-provider={provider}
      className={
        embedded
          ? 'flex h-full min-w-0 flex-col overflow-hidden bg-surface'
          : 'flex h-full min-w-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface'
      }
    >
      <div className="flex min-h-[72px] flex-wrap items-center gap-3 border-b border-border px-[18px] py-4 max-md:px-4">
        <span className="grid size-10 flex-none place-items-center rounded-[11px] border border-border bg-surface-2">
          <img
            src={`/integration-icons/${provider}.${provider === 'bschecker' ? 'svg' : 'ico'}`}
            alt=""
            className="size-6 rounded-[5px]"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[15px] font-semibold">{names[provider]}</h2>
          <p className="mt-0.5 text-[12px] text-text-3">
            {status?.checkedAt ? `Проверено ${formatDate(status.checkedAt)}` : 'Подключение аккаунта'}
          </p>
        </div>
        {provider === 'dpi' && (
          <span className="text-[12px] text-text-3">
            Баланс{' '}
            <b className="ml-1.5 font-mono text-[13px] font-semibold text-text-2">
              {status?.balance !== null && status?.balance !== undefined ? `${status.balance} USD` : '—'}
            </b>
          </span>
        )}
        <Pill tone={status?.connected ? 'ok' : 'muted'}>
          {status?.connected ? 'Подключён' : 'Не подключён'}
        </Pill>
        {status?.connected && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={`Обновить ${names[provider]}`}
              title="Обновить данные"
              disabled={mutation.isPending}
              onClick={() => void run('refresh')}
              className="grid size-9 place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:border-brand/50 hover:bg-surface-2 hover:text-brand disabled:opacity-50"
            >
              <RefreshCwIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label={`Отключить ${names[provider]}`}
              title="Отключить"
              onClick={() => setConfirm(true)}
              className="grid size-9 place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:border-crit/50 hover:bg-crit-soft hover:text-crit"
            >
              <UnplugIcon className="size-4" />
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 px-[18px] py-4 max-md:px-4">
        {provider === 'regru' ? (
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="min-w-0">
              <label htmlFor={`${id}-login`} className="mb-1.5 block text-[12.5px] font-medium text-text-2">
                Логин REG.RU
              </label>
              <Input
                id={`${id}-login`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="off"
                placeholder="Логин аккаунта"
                className="h-10 w-full rounded-[10px] bg-surface-2"
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor={`${id}-password`}
                className="mb-1.5 block text-[12.5px] font-medium text-text-2"
              >
                Пароль API
              </label>
              <PasswordField
                id={`${id}-password`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="Введите пароль API"
                className="h-10 w-full"
              />
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <label htmlFor={`${id}-token`} className="mb-1.5 block text-[12.5px] font-medium text-text-2">
              {provider === 'dpi'
                ? 'API-токен DPI Checker'
                : provider === 'bschecker'
                  ? 'API-ключ BS Checker'
                  : 'API Token Cloudflare'}
            </label>
            <PasswordField
              id={`${id}-token`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Вставьте API-токен"
              className="h-10 w-full"
            />
          </div>
        )}
        <p className="min-h-9 text-[12px] leading-[18px] text-text-3">
          {provider === 'regru'
            ? 'Логин аккаунта и пароль доступа к API из личного кабинета REG.RU.'
            : provider === 'cloudflare'
              ? 'Cloudflare API Token: Zone Read и DNS Read для нужных зон. Для замены записей — DNS Edit. Global API Key сюда не подходит.'
              : provider === 'bschecker'
                ? 'Ключ bsk_live… из bsbord.com. Подключение читает баланс; платные проверки запускаются только вручную.'
                : 'Токен из личного кабинета DPI Checker. После подключения загрузится баланс.'}
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
          >
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-[18px] py-3.5 max-md:px-4 max-sm:flex-col max-sm:items-stretch">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
          Доступы хранятся в панели в зашифрованном виде.
        </p>
        <DialogPrimaryButton
          type="submit"
          disabled={mutation.isPending}
          className="h-10 w-[180px] flex-none rounded-[10px] max-sm:w-full sm:w-[180px] sm:flex-none sm:max-w-none"
        >
          {mutation.isPending ? 'Проверяю…' : status?.connected ? 'Сохранить доступы' : 'Подключить'}
        </DialogPrimaryButton>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Отключить ${names[provider]}?`}
        description="Сохранённые доступы будут удалены из панели."
        yesLabel="Отключить"
        loading={mutation.isPending}
        onConfirm={() => void run('disconnect')}
      />
    </form>
  );
}

export function IntegrationsPage({ kind }: { kind: 'dpi' | 'dns' | 'bschecker' }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get('/integrations', integrationsStatusSchema, signal),
  });
  const providers: IntegrationProvider[] =
    kind === 'dpi' ? ['dpi'] : kind === 'bschecker' ? ['bschecker'] : ['regru', 'cloudflare'];
  const domains =
    query.data?.items
      .filter((s) => providers.includes(s.provider))
      .flatMap((s) => s.domains.map((name) => ({ name, provider: s.provider }))) ?? [];
  const connected = query.data?.items.some((s) => providers.includes(s.provider) && s.connected);
  if (connected)
    return (
      <>
        <div>
          {kind === 'bschecker' ? (
            <BsCheckerWorkspace settings={() => setSettingsOpen(true)} />
          ) : kind === 'dpi' ? (
            <DpiWorkspace
              balance={query.data?.items.find((s) => s.provider === 'dpi')?.balance ?? null}
              settings={() => setSettingsOpen(true)}
            />
          ) : (
            <DnsWorkspace settings={() => setSettingsOpen(true)} />
          )}
        </div>
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent
            className={
              kind === 'bschecker'
                ? 'max-h-[90dvh] overflow-auto sm:max-w-[600px]'
                : 'max-h-[90dvh] overflow-auto sm:max-w-[1000px]'
            }
          >
            <DialogTitle>
              Подключения {kind === 'dpi' ? 'DPI Checker' : kind === 'bschecker' ? 'BS Checker' : 'DNS'}
            </DialogTitle>
            <DialogDescription>
              Сохранённые доступы уже используются. Вводите новый ключ только для изменения подключения.
            </DialogDescription>
            <div
              className={
                kind === 'dns'
                  ? 'grid overflow-hidden rounded-[14px] border border-border bg-border gap-px lg:grid-cols-2'
                  : ''
              }
            >
              {providers.map((provider) => (
                <ConnectionCard
                  key={provider}
                  provider={provider}
                  status={query.data?.items.find((s) => s.provider === provider)}
                  embedded={kind === 'dns'}
                />
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      {query.isPending ? (
        kind === 'dpi' ? (
          <DpiWorkspaceSkeleton />
        ) : kind === 'bschecker' ? (
          <div aria-busy="true" className="space-y-4">
            <div className="flex flex-wrap items-center gap-6 rounded-[14px] border border-border bg-surface px-[18px] py-4">
              <div className="min-w-0 flex-1 max-sm:basis-full">
                <BsBalanceSkeleton />
              </div>
              <Skeleton aria-hidden="true" className="h-10 w-40 rounded-[10px] motion-reduce:animate-none" />
              <Skeleton aria-hidden="true" className="h-10 w-36 rounded-[10px] motion-reduce:animate-none" />
            </div>
            <div aria-hidden="true" className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-80 rounded-[14px] motion-reduce:animate-none" />
              <Skeleton className="h-80 rounded-[14px] motion-reduce:animate-none" />
            </div>
          </div>
        ) : (
          <Skeleton className="h-60 rounded-[14px]" />
        )
      ) : query.isError ? (
        <p role="alert" className="rounded-[12px] border border-crit/30 bg-crit-soft p-4 text-[13px]">
          {apiErrorMessage(query.error)} <RowButton onClick={() => void query.refetch()}>Повторить</RowButton>
        </p>
      ) : (
        <div
          className={kind === 'dns' ? 'grid grid-cols-2 items-stretch gap-4 max-xl:grid-cols-1' : 'w-full'}
        >
          {providers.map((provider) => (
            <ConnectionCard
              key={provider}
              provider={provider}
              status={query.data.items.find((s) => s.provider === provider)}
            />
          ))}
        </div>
      )}
      {kind === 'dns' && domains.length > 0 && (
        <SettingsCard title="Домены">
          <div className="divide-y divide-border">
            {domains.map((d) => (
              <div
                key={`${d.provider}:${d.name}`}
                className="flex items-center justify-between gap-3 py-3 text-[13px]"
              >
                <span className="break-all font-mono">{d.name}</span>
                <span className="text-text-3">{names[d.provider]}</span>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

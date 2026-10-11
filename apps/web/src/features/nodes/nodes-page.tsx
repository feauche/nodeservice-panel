import { Loader2Icon, RefreshCwIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConnectionPermissions } from './connection-permissions';
import { bytes as traffic } from './node-card';
import { NodeDialog } from './node-dialog';
import { NodeInventory } from './node-inventory';
import {
  useCheckRemnaPermissions,
  useConnectNodes,
  useDisconnectNodes,
  useNodes,
  useRefreshNodes,
} from './nodes-api';

const fieldLabel = 'mb-1.5 block text-[12.5px] font-medium text-text-2';
const secondary =
  'h-9 rounded-[10px] border-border bg-surface px-3 text-[12.5px] text-text-2 hover:bg-surface-2 hover:text-foreground';
export function NodesPage() {
  const query = useNodes();
  const connect = useConnectNodes();
  const checkPermissions = useCheckRemnaPermissions();
  const [permissionPreview, setPermissionPreview] = useState<Awaited<
    ReturnType<typeof checkPermissions.mutateAsync>
  > | null>(null);
  const refresh = useRefreshNodes();
  const disconnect = useDisconnectNodes();
  const status = query.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [disconnecting, setDisconnecting] = useState(false);
  useEffect(() => {
    if (status?.domain) setDomain(status.domain);
  }, [status?.domain]);
  const nodes = status?.nodes ?? [];
  const activeNode = nodes.find((n) => n.uuid === selected);
  const filtered = useMemo(
    () =>
      nodes.filter(
        (n) =>
          `${n.name} ${n.address} ${n.countryCode ?? ''} ${n.providerName ?? ''}`
            .toLowerCase()
            .includes(search.toLowerCase().trim()) &&
          (filter === 'all' || filter === (n.isDisabled ? 'disabled' : n.isConnected ? 'connected' : 'down')),
      ),
    [nodes, search, filter],
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setPermissionPreview(
        await checkPermissions.mutateAsync({ domain: domain.trim(), apiKey: apiKey.trim() }),
      );
      await connect.mutateAsync({ domain: domain.trim(), apiKey: apiKey.trim() });
      setPermissionPreview(null);
      setApiKey('');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  async function update() {
    setError(null);
    try {
      await refresh.mutateAsync();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  if (query.isPending)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  if (query.isError)
    return (
      <section className="rounded-2xl border border-border bg-surface p-5">
        <p className="text-sm text-crit">{apiErrorMessage(query.error)}</p>
        <Button className={secondary} variant="outline" onClick={() => void query.refetch()}>
          Повторить
        </Button>
      </section>
    );
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-heading text-[15px] font-semibold">Подключение Remnawave</h2>
          <Pill tone={status?.connected ? 'ok' : 'muted'}>
            {status?.connected ? 'Подключено' : 'Не подключено'}
          </Pill>
          <span className="flex-1" />
          {status?.connected && (
            <Button
              variant="outline"
              className={secondary}
              onClick={() => setConnectionOpen(!connectionOpen)}
            >
              {connectionOpen ? 'Свернуть' : 'Настроить подключение'}
            </Button>
          )}
          {status?.connected && (
            <Button variant="outline" className={secondary} onClick={() => setDisconnecting(true)}>
              Отключить
            </Button>
          )}
        </div>
        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            !status?.connected || connectionOpen
              ? 'grid-rows-[1fr] opacity-100'
              : 'grid-rows-[0fr] opacity-0',
          )}
          inert={status?.connected && !connectionOpen ? true : undefined}
        >
          <div className="min-h-0 overflow-hidden">
            <form
              onSubmit={save}
              className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] xl:items-end"
            >
              <div className="min-w-0">
                <label htmlFor="nodes-domain" className={fieldLabel}>
                  Домен панели
                </label>
                <Input
                  id="nodes-domain"
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    setPermissionPreview(null);
                  }}
                  placeholder="https://panel.example.com"
                  autoComplete="url"
                  disabled={connect.isPending || checkPermissions.isPending}
                  className="h-10"
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="nodes-key" className={fieldLabel}>
                  API-ключ
                </label>
                <PasswordField
                  id="nodes-key"
                  className="h-10 py-0 text-[13px]"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setPermissionPreview(null);
                  }}
                  placeholder={
                    status?.connected ? 'Новый ключ для изменения подключения' : 'Ключ API Remnawave'
                  }
                  autoComplete="off"
                  disabled={connect.isPending || checkPermissions.isPending}
                />
              </div>
              <Button
                type="submit"
                disabled={connect.isPending || checkPermissions.isPending || !domain.trim() || !apiKey.trim()}
                className="h-10 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
              >
                {connect.isPending && <Loader2Icon className="size-4 animate-spin" />}
                {status?.connected ? 'Проверить и сохранить' : 'Подключить'}
              </Button>
            </form>
            <ConnectionPermissions
              preview={permissionPreview}
              enabled={Boolean(!status?.connected || connectionOpen)}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-crit">
            {error}
          </p>
        )}
      </section>
      {status?.providerError && (
        <p role="alert" className="rounded-xl border border-warn/25 bg-warn/10 p-4 text-[12px] text-warn">
          {status.providerError}
        </p>
      )}
      {status?.error && (
        <section
          role="alert"
          className="rounded-xl border border-warn/25 bg-warn-soft px-4 py-3 text-[13px] text-warn"
        >
          Не удалось обновить данные: {status.error}. Показан сохранённый снимок.
        </section>
      )}
      {status?.connected ? (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[
              ['Ноды', nodes.length],
              ['На связи', nodes.filter((n) => n.isConnected && !n.isDisabled).length],
              ['Онлайн', nodes.reduce((sum, n) => sum + (n.usersOnline ?? 0), 0)],
              ['Трафик всего', status.stats ? traffic(status.stats.trafficBytesLifetime) : '—'],
            ].map(([name, value]) => (
              <div key={name} className="rounded-2xl border border-border bg-surface px-4 py-3.5">
                <div className="text-[11px] text-text-3">{name}</div>
                <div className="mt-1 font-heading text-[24px] font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </div>
          <section className="overflow-hidden rounded-2xl border border-border bg-surface">
            <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
              <h2 className="font-heading text-[15px] font-semibold">Ноды</h2>
              <span className="flex-1" />
              <span className="text-[11.5px] text-text-3">
                {status.checkedAt &&
                  `Обновлено ${new Date(status.checkedAt).toLocaleTimeString('ru-RU')} · каждые 15 секунд`}
              </span>
              <Button
                variant="outline"
                className={secondary}
                disabled={refresh.isPending}
                onClick={() => void update()}
              >
                <RefreshCwIcon className={cn('size-3.5', refresh.isPending && 'animate-spin')} />
                Обновить
              </Button>
            </div>
            <NodeInventory
              toolbar={
                <>
                  <div className="relative min-w-0 flex-1">
                    <SearchIcon className="pointer-events-none absolute top-3 left-3 size-4 text-text-3" />
                    <Input
                      aria-label="Поиск ноды"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Название, провайдер, адрес или страна"
                      className="h-10 pl-9"
                    />
                  </div>
                  <Combobox
                    ariaLabel="Состояние ноды"
                    value={filter}
                    onChange={(v) => setFilter(v ?? 'all')}
                    placeholder="Все состояния"
                    options={[
                      { value: 'all', label: 'Все состояния' },
                      { value: 'connected', label: 'На связи' },
                      { value: 'down', label: 'Не на связи' },
                      { value: 'disabled', label: 'Отключены' },
                    ]}
                    className="h-10 w-[180px] shrink-0 rounded-[10px] max-sm:w-full"
                  />
                </>
              }
              nodes={filtered}
              allNodes={nodes}
              stale={Boolean(status.error)}
              onSelect={setSelected}
              searching={Boolean(search.trim()) || filter !== 'all'}
            />
            {!filtered.length && (
              <div className="px-5 py-12 text-center text-[13px] text-text-3">
                {nodes.length ? 'Ноды не найдены' : 'В подключённой панели пока нет нод.'}
              </div>
            )}
          </section>
          <p className="text-[11.5px] leading-relaxed text-text-3">
            «Доступна» — состояние ноды в Remnawave. Результаты проверки доступности VPN отображаются
            отдельно.
          </p>
        </>
      ) : (
        <section className="rounded-2xl border border-dashed border-border px-5 py-12 text-center">
          <h2 className="font-heading text-[16px] font-semibold">Подключите панель Remnawave</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-text-3">
            Введите домен и API-ключ выше — здесь появятся ваши ноды, онлайн и состояние подключения.
          </p>
        </section>
      )}
      {activeNode && (
        <NodeDialog
          key={selected}
          node={activeNode}
          stale={Boolean(status?.error)}
          onClose={() => setSelected(null)}
        />
      )}
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Отключить Remnawave?"
        description="Сохранённые домен и API-ключ будут удалены из NodeService. Ноды в самой Remnawave останутся без изменений."
        yesLabel="Отключить"
        loading={disconnect.isPending}
        onConfirm={async () => {
          setError(null);
          try {
            await disconnect.mutateAsync();
            setDomain('');
            setApiKey('');
            setDisconnecting(false);
          } catch (e) {
            setError(apiErrorMessage(e));
          }
        }}
      />
    </div>
  );
}

import {
  type DnsRecord,
  dnsHistorySchema,
  dnsWorkspaceSchema,
  type IntegrationStatus,
  integrationStatusSchema,
  integrationsStatusSchema,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  ClockIcon,
  EllipsisIcon,
  Loader2Icon,
  PlugIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useMemo, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CountryFlag } from '@/components/country-flag';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { KpiCard, KpiCardSkeleton } from '@/components/kpi-card';
import { PageActions } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { nodeOption } from '@/features/nodes/node-option';
import { useNodes } from '@/features/nodes/nodes-api';
import { formatAgo } from '@/features/security/security-format';
import { Pill, Toggle } from '@/features/settings/settings-ui';
import { api, apiErrorMessage, request } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';

type Provider = 'cloudflare' | 'regru';
const PROVIDERS: Provider[] = ['cloudflare', 'regru'];
const PROVIDER_NAME: Record<string, string> = { cloudflare: 'Cloudflare', regru: 'REG.RU' };
const providerIcon = (p: string) => `/integration-icons/${p}.ico`;
type Filter = 'all' | 'linked' | 'diff' | 'free';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'Все'],
  ['linked', 'Связаны с нодами'],
  ['diff', 'Отличаются'],
  ['free', 'Без ноды'],
];
/** match — адрес совпадает с нодой; diff — у ноды другой адрес; linked — связана, но это не IP (CNAME и т. п.). */
type RecordState = 'match' | 'diff' | 'linked' | 'free';
const isIp = (r: DnsRecord) => r.type === 'A' || r.type === 'AAAA';
export function recordState(r: DnsRecord): RecordState {
  if (!r.nodes.length) return 'free';
  if (r.nodes.some((n) => n.address === r.content)) return 'match';
  return isIp(r) ? 'diff' : 'linked';
}
const STATE_ORDER: Record<RecordState, number> = { diff: 0, match: 1, linked: 2, free: 3 };
/** У Cloudflare TTL 1 — «авто» (5 минут). */
const ttlText = (r: DnsRecord) => (r.provider === 'cloudflare' && r.ttl === 1 ? 'TTL авто' : `TTL ${r.ttl}`);
function ttlHint(r: DnsRecord) {
  const seconds = r.provider === 'cloudflare' && r.ttl === 1 ? 300 : r.ttl;
  return seconds <= 60
    ? 'Новый адрес заработает почти сразу.'
    : `Старый адрес могут видеть ещё до ${Math.ceil(seconds / 60)} мин (${ttlText(r)}).`;
}
const outline = 'h-10 rounded-[10px] px-4 text-[13px] font-medium';
const whenFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
type HistoryItem = z.infer<typeof dnsHistorySchema>['items'][number];
/** Итог замены пилюлей: автозамена, вручную, частично, ошибка. */
function HistoryPill({ item }: { item: HistoryItem }) {
  if (item.status === 'success')
    return <Pill tone={item.automatic ? 'ok' : 'muted'}>{item.automatic ? 'Автозамена' : 'Вручную'}</Pill>;
  if (item.status === 'partial') return <Pill tone="warn">Частично</Pill>;
  return <Pill tone="crit">Ошибка</Pill>;
}
const HISTORY_DOT: Record<string, string> = { success: 'bg-ok', partial: 'bg-warn' };

/** Нода записи: флаг, имя и точка — на связи или нет. */
function NodeChip({ uuid, name, nodes }: { uuid: string; name: string; nodes: RemnawaveNode[] }) {
  const n = nodes.find((x) => x.uuid === uuid);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2 text-[13px]">
      {n?.countryCode && <CountryFlag code={n.countryCode} size="sm" />}
      <span className="truncate">{name}</span>
      <span
        title={n ? (n.isConnected ? 'На связи' : 'Нет связи') : undefined}
        className={cn(
          'size-1.5 flex-none rounded-full',
          n ? (n.isConnected ? 'bg-ok' : 'bg-crit') : 'bg-text-3',
        )}
        aria-hidden="true"
      />
    </span>
  );
}

/** Шапка окна: значок провайдера (если есть), заголовок с пояснением и «Закрыть» справа. */
function DialogHead({
  icon,
  title,
  description,
}: {
  icon?: string;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 max-sm:px-4">
      {icon && <img src={icon} alt="" className="size-[26px] flex-none rounded-[7px]" />}
      <div className="min-w-0 flex-1">
        <DialogTitle className="font-heading text-[17px] break-all">{title}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[12.5px] text-text-3">{description}</DialogDescription>
      </div>
      <DialogClose
        aria-label="Закрыть окно"
        className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <XIcon className="size-4" aria-hidden="true" />
      </DialogClose>
    </div>
  );
}
const dialogFoot =
  'flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4';
// Ширина своя, не «растянуть на ряд»: у общих кнопок окна на широком экране flex-1.
const footButton = 'h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:flex-none sm:max-w-none';

/** Строка записи: домен → нода, адрес и совпадает ли он, автозамена или «Заменить», подробнее. */
function RecordRow({
  r,
  nodes,
  auto,
  busy,
  onOpen,
  onAuto,
}: {
  r: DnsRecord;
  nodes: RemnawaveNode[];
  auto: boolean;
  busy: boolean;
  onOpen: () => void;
  onAuto: (on: boolean) => void;
}) {
  const state = recordState(r);
  const canAuto = isIp(r) && r.nodes.length === 1 && state !== 'diff';
  const linked = r.nodes[0];
  const note =
    state === 'diff' ? (
      <span className="text-warn">у ноды {r.nodes.map((n) => n.address).join(', ')}</span>
    ) : state === 'match' ? (
      <span className="text-ok">совпадает с нодой</span>
    ) : null;
  const key = (e: KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: строка открывает окно записи, внутри — свои кнопки
    <div
      role="button"
      tabIndex={0}
      aria-label={`Запись ${r.name}`}
      onClick={onOpen}
      onKeyDown={key}
      className={cn(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-[18px] py-[11px] text-[13px] transition-colors first:border-t-0 hover:bg-surface-2/55 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand md:grid-cols-[minmax(0,1.1fr)_16px_minmax(0,1.1fr)_minmax(0,1fr)_150px_36px]',
        state === 'diff' && 'bg-warn/[0.05] shadow-[inset_3px_0_0_var(--ns-warn)]',
      )}
    >
      <div className="min-w-0">
        <b className="block truncate font-semibold">{r.name}</b>
        <small className="text-[11.5px] text-text-3">
          {r.type} · {ttlText(r)}
        </small>
        {/* На телефоне нода и адрес — строкой под доменом. */}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-2 md:hidden">
          {linked ? <NodeChip uuid={linked.uuid} name={linked.name} nodes={nodes} /> : 'не связана с нодой'}
          <span className="font-mono text-[11.5px] break-all">{r.content}</span>
          {note}
        </div>
      </div>
      <ArrowRightIcon className="size-4 text-text-3 max-md:hidden" aria-hidden="true" />
      <div className="min-w-0 max-md:hidden">
        {r.nodes.length ? (
          <div className="flex flex-col gap-0.5">
            {r.nodes.map((n) => (
              <NodeChip key={n.uuid} uuid={n.uuid} name={n.name} nodes={nodes} />
            ))}
          </div>
        ) : (
          <span className="text-text-3">не связана с нодой</span>
        )}
      </div>
      <div className="min-w-0 max-md:hidden">
        <span className="font-mono text-[12.5px] break-all">{r.content}</span>
        {note && <div className="mt-0.5 text-[12px]">{note}</div>}
      </div>
      {/* Свои действия у переключателя и «Заменить»: нажатие по ним не открывает окно. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: обёртка только гасит всплытие нажатия */}
      <div
        className="flex items-center gap-2 justify-self-end md:justify-self-start"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {state === 'diff' ? (
          <button
            type="button"
            onClick={onOpen}
            className="h-[30px] cursor-pointer rounded-[8px] bg-warn-soft px-3 text-[12.5px] font-semibold text-warn transition-colors hover:bg-warn/25"
          >
            Заменить
          </button>
        ) : canAuto ? (
          <>
            <Toggle
              id={`dns-auto-${r.id}`}
              checked={auto}
              disabled={busy}
              aria-label={`Автозамена ${r.name}`}
              onChange={onAuto}
            />
            <span className="text-[12px] text-text-3 max-md:hidden">Автозамена</span>
          </>
        ) : null}
      </div>
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-[10px] text-text-3 transition-colors max-md:hidden"
      >
        <EllipsisIcon className="size-4" />
      </span>
    </div>
  );
}

/** Окно записи: нода, адрес в DNS и у ноды, автозамена, история записи и замена. */
function RecordDialog({
  record,
  nodes,
  history,
  auto,
  autoBusy,
  onAuto,
  onClose,
}: {
  record: DnsRecord;
  nodes: RemnawaveNode[];
  history: HistoryItem[];
  auto: boolean;
  autoBusy: boolean;
  onAuto: (on: boolean) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [node, setNode] = useState<string | null>(
    record.nodes.length === 1 ? (record.nodes[0]?.uuid ?? null) : null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = nodes.find((n) => n.uuid === node);
  const state = recordState(record);
  const ip = isIp(record);
  const same = Boolean(target && target.address === record.content);
  // Адрес уже как у ноды и запись связана с ней — менять нечего, остаётся только «Закрыть».
  const done = same && record.nodes.some((n) => n.uuid === node);
  const mine = history.filter((h) => h.domain === record.name && h.provider === record.provider);
  async function apply() {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api.post(
        '/integrations/dns/apply',
        { recordId: record.id, nodeUuid: target.uuid, expected: record.content },
        z.object({ changed: z.boolean() }),
      );
      await client.invalidateQueries({ queryKey: ['dns-workspace'] });
      await client.invalidateQueries({ queryKey: ['dns-history'] });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[720px]"
      >
        <DialogHead
          icon={providerIcon(record.provider)}
          title={<span className="font-mono">{record.name}</span>}
          description={`${PROVIDER_NAME[record.provider]} · ${record.type}-запись · ${ttlText(record)}`}
        />
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5 max-sm:px-4">
          {ip ? (
            <div>
              <p id="dns-node-label" className="mb-1.5 text-[12.5px] font-medium text-text-2">
                Нода
              </p>
              <Combobox
                id="dns-node"
                ariaLabel="Нода"
                value={node}
                onChange={setNode}
                options={nodes.map((n) => nodeOption({ id: n.uuid, name: n.name, host: n.address }))}
                placeholder="Выберите ноду"
                searchPlaceholder="Найти ноду…"
                disabled={busy}
                className="h-10 w-full"
              />
            </div>
          ) : (
            <p className="rounded-[12px] border border-border bg-surface-2 px-3.5 py-2.5 text-[12.5px] text-text-2">
              {record.type}-запись указывает не на IP-адрес — её можно только посмотреть. Менять адрес можно у
              A и AAAA.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div
              className={cn(
                'rounded-[12px] border px-3.5 py-3',
                state === 'diff' && !same ? 'border-warn/40 bg-warn/[0.06]' : 'border-border bg-surface-2/50',
              )}
            >
              <span className="text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                В DNS сейчас
              </span>
              <b className="mt-1 block font-mono text-[15px] font-semibold break-all">{record.content}</b>
              <small className={cn('text-[12px]', state === 'diff' ? 'text-warn' : 'text-text-3')}>
                {state === 'diff'
                  ? 'отличается от адреса ноды'
                  : state === 'match'
                    ? 'совпадает с нодой'
                    : '—'}
              </small>
            </div>
            <div className="rounded-[12px] border border-border bg-surface-2/50 px-3.5 py-3">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                Адрес ноды
              </span>
              <b className="mt-1 block font-mono text-[15px] font-semibold break-all">
                {target?.address ?? '—'}
              </b>
              <small className="text-[12px] text-text-3">
                {target ? 'по данным Remnawave' : 'выберите ноду'}
              </small>
            </div>
          </div>
          {ip && record.nodes.length === 1 && (
            <div className="flex items-center gap-3 rounded-[12px] border border-border px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <label htmlFor="dns-auto-dialog" className="text-[13.5px] font-semibold">
                  Автозамена
                </label>
                <p className="mt-0.5 text-[12px] leading-snug text-text-3">
                  Сменится адрес ноды «{record.nodes[0]?.name}» — панель сама обновит эту запись. Каждая
                  замена попадает в «Историю замен».
                </p>
              </div>
              <Toggle id="dns-auto-dialog" checked={auto} disabled={autoBusy} onChange={onAuto} />
            </div>
          )}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
              История этой записи
            </p>
            {mine.length ? (
              <ol className="flex flex-col" aria-label="История записи">
                {mine.slice(0, 10).map((h) => (
                  <li
                    key={`${h.at}:${h.old}:${h.next}`}
                    className="grid grid-cols-[110px_10px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border py-2.5 text-[13px] first:border-t-0 max-sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <span className="text-[12px] text-text-3 tabular-nums max-sm:col-span-2">
                      {whenFmt.format(new Date(h.at))}
                    </span>
                    <span
                      className={cn('size-2 rounded-full max-sm:hidden', HISTORY_DOT[h.status] ?? 'bg-crit')}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 font-mono text-[12.5px] break-all">
                      {h.old} → {h.next}
                    </span>
                    <HistoryPill item={h} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12.5px] text-text-3">Эту запись ещё не меняли.</p>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {error}
            </p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            {!ip ? 'Изменений не будет.' : done ? 'Адрес записи уже совпадает с нодой.' : ttlHint(record)}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              {ip && !done ? 'Отмена' : 'Закрыть'}
            </DialogSecondaryButton>
            {ip && !done && (
              <DialogPrimaryButton
                disabled={busy || !target}
                onClick={() => void apply()}
                className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
              >
                {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                {!target ? 'Заменить' : same ? 'Связать с нодой' : `Заменить на ${target.address}`}
              </DialogPrimaryButton>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** «История замен»: все изменения адресов в записях — вручную и автозаменой. */
function HistoryDialog({
  open,
  onOpenChange,
  query,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  query: { isPending: boolean; data?: { items: HistoryItem[] } };
}) {
  const items = query.data?.items ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[720px]"
      >
        <DialogHead
          title="История замен"
          description="Замены адресов в DNS-записях: вручную и автозаменой."
        />
        <div className="min-h-0 overflow-y-auto px-6 py-3 max-sm:px-4">
          {query.isPending ? (
            <div role="status" aria-label="Загрузка истории замен" className="flex flex-col gap-3 py-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11 w-full rounded-[10px]" />
              ))}
            </div>
          ) : items.length ? (
            <ol aria-label="История замен" className="flex flex-col">
              {items.slice(0, 100).map((h) => (
                <li
                  key={`${h.at}:${h.domain}:${h.old}:${h.next}`}
                  className="grid grid-cols-[110px_10px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border py-3 first:border-t-0 max-sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <span className="text-[12px] text-text-3 tabular-nums max-sm:col-span-2">
                    {whenFmt.format(new Date(h.at))}
                  </span>
                  <span
                    className={cn('size-2 rounded-full max-sm:hidden', HISTORY_DOT[h.status] ?? 'bg-crit')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <b className="block font-mono text-[12.5px] font-semibold break-all">{h.domain}</b>
                    <span className="font-mono text-[12px] break-all text-text-3">
                      {h.old} → {h.next}
                    </span>
                  </span>
                  <HistoryPill item={h} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-[13px] text-text-3">Замен пока не было.</p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Ручные замены записываются и в «Журнал».
          </p>
          <DialogSecondaryButton onClick={() => onOpenChange(false)} className={footButton}>
            Закрыть
          </DialogSecondaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Аккаунт DNS-провайдера в окне «Подключения»: состояние, обновить, изменить доступ, отключить. */
function Account({
  provider,
  status,
  zones,
}: {
  provider: Provider;
  status?: IntegrationStatus;
  zones: number;
}) {
  const client = useQueryClient();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const connected = Boolean(status?.connected);
  const mutation = useMutation({
    mutationFn: async (action: 'connect' | 'refresh' | 'disconnect') => {
      if (action === 'disconnect') await request(`/integrations/${provider}`, { method: 'DELETE' });
      else
        await api.post(
          `/integrations/${provider}/${action}`,
          action === 'connect' ? (provider === 'regru' ? { username, password } : { apiKey }) : {},
          integrationStatusSchema,
        );
    },
    onSuccess: () => {
      setApiKey('');
      setPassword('');
      setEditing(false);
      setConfirm(false);
      void client.invalidateQueries({ queryKey: ['integrations'] });
      void client.invalidateQueries({ queryKey: ['dns-workspace'] });
    },
  });
  async function run(action: 'connect' | 'refresh' | 'disconnect') {
    setError('');
    try {
      await mutation.mutateAsync(action);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void run('connect');
  }
  const small = 'h-9 rounded-[10px] px-3.5 text-[12.5px] font-medium';
  return (
    <div className="overflow-hidden rounded-[14px] border border-border" data-provider={provider}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <img src={providerIcon(provider)} alt="" className="size-7 flex-none rounded-[7px]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[14px] font-semibold">{PROVIDER_NAME[provider]}</b>
            <Pill tone={connected ? 'ok' : 'muted'}>{connected ? 'Подключён' : 'Не подключён'}</Pill>
          </div>
          <p className="mt-0.5 text-[12px] text-text-3">
            {connected
              ? [
                  `${zones} ${plural(zones, 'зона', 'зоны', 'зон')}`,
                  provider === 'regru' ? 'логин и пароль API' : 'токен API',
                  status?.checkedAt ? `проверено ${formatAgo(status.checkedAt)}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : provider === 'regru'
                ? 'Логин аккаунта и пароль API из личного кабинета REG.RU.'
                : 'Токен API с правами Zone Read и DNS Read, для замены записей — DNS Edit.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button
                variant="outline"
                className={small}
                disabled={mutation.isPending}
                onClick={() => void run('refresh')}
              >
                Обновить
              </Button>
              <Button variant="outline" className={small} onClick={() => setEditing((v) => !v)}>
                Изменить
              </Button>
              <Button
                variant="outline"
                className={cn(small, 'hover:border-crit/50 hover:bg-crit-soft hover:text-crit')}
                onClick={() => setConfirm(true)}
              >
                Отключить
              </Button>
            </>
          ) : (
            !editing && (
              <DialogPrimaryButton
                onClick={() => setEditing(true)}
                className={cn(small, 'w-auto sm:max-w-none')}
              >
                Подключить
              </DialogPrimaryButton>
            )
          )}
        </div>
      </div>
      {editing && (
        <form
          id={id}
          onSubmit={submit}
          className="flex flex-col gap-3 border-t border-border bg-bg-2 px-4 py-3.5"
        >
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
                Токен API Cloudflare
              </label>
              <PasswordField
                id={`${id}-token`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="Вставьте токен"
                className="h-10 w-full"
              />
            </div>
          )}
          <div className="flex items-center gap-3 max-sm:flex-col max-sm:items-stretch">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
              {provider === 'cloudflare'
                ? 'Нужен именно токен API, глобальный ключ Cloudflare не подойдёт.'
                : 'Панель проверит доступ и загрузит домены.'}
            </p>
            <DialogSecondaryButton onClick={() => setEditing(false)} className={footButton}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton type="submit" disabled={mutation.isPending} className={footButton}>
              {mutation.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {connected ? 'Сохранить' : 'Подключить'}
            </DialogPrimaryButton>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="border-t border-crit/30 bg-crit-soft px-4 py-2 text-[12.5px] text-crit">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        kind="crit"
        title={`Отключить ${PROVIDER_NAME[provider]}?`}
        description="Сохранённые доступы удалятся из панели, записи этого аккаунта пропадут из раздела. Автозамена для них остановится."
        yesLabel="Отключить"
        loading={mutation.isPending}
        onConfirm={() => void run('disconnect')}
      />
    </div>
  );
}

function ConnectionsDialog({
  open,
  onOpenChange,
  zones,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  zones: Record<string, number>;
}) {
  const statuses = useQuery({
    queryKey: ['integrations'],
    queryFn: ({ signal }) => api.get('/integrations', integrationsStatusSchema, signal),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[680px]"
      >
        <DialogHead
          title="Подключения DNS"
          description="Аккаунты, через которые панель читает и меняет записи."
        />
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 py-5 max-sm:px-4">
          {PROVIDERS.map((p) => (
            <Account
              key={p}
              provider={p}
              status={statuses.data?.items.find((s) => s.provider === p)}
              zones={zones[p] ?? 0}
            />
          ))}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Доступы хранятся в панели в зашифрованном виде.
          </p>
          <DialogSecondaryButton onClick={() => onOpenChange(false)} className={footButton}>
            Закрыть
          </DialogSecondaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ZoneSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex min-h-14 items-center gap-3 border-b border-border px-[18px] py-3">
        <Skeleton className="size-[22px] rounded-[6px]" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: заглушка без данных
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-[18px] py-3 first:border-t-0 md:grid-cols-[minmax(0,1.1fr)_16px_minmax(0,1.1fr)_minmax(0,1fr)_150px_36px]"
        >
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="size-4 max-md:hidden" />
          <Skeleton className="h-3.5 w-3/5 max-md:hidden" />
          <Skeleton className="h-3.5 w-1/2 max-md:hidden" />
          <Skeleton className="h-[22px] w-10 rounded-full" />
          <Skeleton className="size-9 rounded-[10px] max-md:hidden" />
        </div>
      ))}
    </div>
  );
}
export function DnsWorkspaceSkeleton() {
  return (
    <div role="status" aria-label="Загрузка доменов и DNS-записей" className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {[64, 150, 112, 104].map((w) => (
          <Skeleton key={w} className="h-9 rounded-full" style={{ width: w }} />
        ))}
        <Skeleton className="h-9 min-w-[220px] flex-1 rounded-[10px]" />
      </div>
      <ZoneSkeleton rows={5} />
      <ZoneSkeleton rows={2} />
    </div>
  );
}

/**
 * «DNS интеграции» (витрина redesign-2026-10, DNS, вариант A): домены карточками с провайдером и счётчиками,
 * в строке — домен → нода, адрес и совпадает ли он с нодой, автозамена или «Заменить». Сверху показатели и
 * фильтры. Кнопки «Подключения», «История замен» и «Обновить» — в шапке страницы.
 */
export function DnsWorkspace() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['dns-workspace'],
    queryFn: ({ signal }) => api.get('/integrations/dns/overview', dnsWorkspaceSchema, signal),
    refetchInterval: 30000,
  });
  const history = useQuery({
    queryKey: ['dns-history'],
    queryFn: ({ signal }) => api.get('/integrations/dns/history', dnsHistorySchema, signal),
    refetchInterval: 30000,
  });
  const nodesQuery = useNodes();
  const nodes = nodesQuery.data?.nodes ?? [];
  const [filter, setFilter] = useState<Filter>('all'),
    [search, setSearch] = useState(''),
    [openId, setOpenId] = useState<string | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [connectionsOpen, setConnectionsOpen] = useState(false),
    [pending, setPending] = useState<string | null>(null),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState('');
  const data = query.data;
  const records = data?.records ?? [];
  const auto = (r: DnsRecord) =>
    Boolean(
      data?.settings.automaticRecords.includes(r.id) ||
        r.nodes.some((n) => data?.settings.automaticNodes.includes(n.uuid)),
    );
  async function setAuto(r: DnsRecord, enabled: boolean) {
    setPending(r.id);
    setError('');
    try {
      await api.put(
        '/integrations/dns/settings',
        { recordId: r.id, enabled },
        z.object({ automaticNodes: z.array(z.string()), automaticRecords: z.array(z.string()) }),
      );
      await client.invalidateQueries({ queryKey: ['dns-workspace'] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setPending(null);
    }
  }
  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await api.post('/integrations/dns/workspace/refresh', {}, dnsWorkspaceSchema);
      await query.refetch();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: records.length, linked: 0, diff: 0, free: 0 };
    for (const r of records) {
      const s = recordState(r);
      if (s === 'free') c.free++;
      else c.linked++;
      if (s === 'diff') c.diff++;
    }
    return c;
  }, [records]);
  const needle = search.trim().toLowerCase();
  const shown = records.filter((r) => {
    const s = recordState(r);
    if (filter === 'linked' && s === 'free') return false;
    if (filter === 'diff' && s !== 'diff') return false;
    if (filter === 'free' && s !== 'free') return false;
    return (
      !needle ||
      [r.name, r.content, r.type, ...r.nodes.map((n) => n.name)].join(' ').toLowerCase().includes(needle)
    );
  });
  const zones = (data?.domains ?? []).map((d) => {
    const all = records.filter((r) => r.zone === d.name && r.provider === d.provider);
    return {
      ...d,
      all,
      rows: shown
        .filter((r) => r.zone === d.name && r.provider === d.provider)
        .sort(
          (a, b) =>
            STATE_ORDER[recordState(a)] - STATE_ORDER[recordState(b)] ||
            a.name.localeCompare(b.name, 'ru') ||
            a.type.localeCompare(b.type),
        ),
    };
  });
  const zoneCount = (p: string) => (data?.domains ?? []).filter((d) => d.provider === p).length;
  const types = [...new Set(records.map((r) => r.type))];
  const matched = records.filter((r) => recordState(r) === 'match').length;
  const opened = records.find((r) => r.id === openId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <PageActions>
        <Button variant="outline" className={outline} onClick={() => setConnectionsOpen(true)}>
          <PlugIcon className="size-4" aria-hidden="true" />
          Подключения
        </Button>
        <Button variant="outline" className={outline} onClick={() => setHistoryOpen(true)}>
          <ClockIcon className="size-4" aria-hidden="true" />
          История замен
        </Button>
        <Button
          variant="outline"
          aria-label="Обновить записи"
          title="Перечитать записи у провайдеров"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="size-10 rounded-[10px] p-0"
        >
          <RefreshCwIcon className={cn('size-4', refreshing && 'animate-spin')} aria-hidden="true" />
        </Button>
      </PageActions>
      {query.isPending ? (
        <DnsWorkspaceSkeleton />
      ) : query.isError ? (
        <p
          role="alert"
          className="rounded-[12px] border border-crit/30 bg-crit-soft p-4 text-[13px] text-crit"
        >
          {apiErrorMessage(query.error)}{' '}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="cursor-pointer font-semibold underline"
          >
            Повторить
          </button>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
            <KpiCard
              label="Домены"
              value={zones.length}
              status={PROVIDERS.filter((p) => zoneCount(p))
                .map((p) => `${PROVIDER_NAME[p]} ${zoneCount(p)}`)
                .join(' · ')}
              tone={zones.length ? 'ok' : 'muted'}
            />
            <KpiCard
              label="Записи"
              value={records.length}
              status={types.length ? types.slice(0, 4).join(', ') : 'записей нет'}
              tone={records.length ? 'ok' : 'muted'}
            />
            <KpiCard
              label="С нодами"
              value={counts.linked}
              status={
                !counts.linked
                  ? 'связей пока нет'
                  : matched === counts.linked
                    ? 'адреса совпадают'
                    : `совпадают ${matched} из ${counts.linked}`
              }
              tone={counts.linked ? 'ok' : 'muted'}
            />
            <KpiCard
              label="Отличаются"
              value={counts.diff}
              status={counts.diff ? 'адрес не как у ноды' : 'всё совпадает'}
              tone={counts.diff ? 'warn' : 'ok'}
            />
          </div>
          {data?.errors.map((e) => (
            <p
              key={e}
              role="alert"
              className="rounded-[12px] border border-warn/30 bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn"
            >
              {e}
            </p>
          ))}
          {error && (
            <p
              role="alert"
              className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-2.5 text-[12.5px] text-crit"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
              <legend className="sr-only">Какие записи показать</legend>
              {FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] transition-colors',
                    filter === key
                      ? 'border-brand bg-brand-soft text-foreground'
                      : 'border-border bg-surface text-text-2 hover:text-foreground',
                  )}
                >
                  {label}
                  <b
                    className={cn(
                      'font-semibold tabular-nums',
                      key === 'diff' && counts.diff > 0 && 'text-warn',
                    )}
                  >
                    {counts[key]}
                  </b>
                </button>
              ))}
            </fieldset>
            <div className="relative min-w-[220px] flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Домен, адрес или нода"
                aria-label="Поиск записей"
                className="h-9 w-full rounded-[10px] bg-surface pl-9"
              />
            </div>
          </div>
          {!records.length ? (
            <p className="rounded-2xl border border-border bg-surface px-6 py-10 text-center text-[13px] text-text-3">
              DNS-записей не найдено. Проверьте в «Подключениях», что токену доступны нужные зоны.
            </p>
          ) : !shown.length ? (
            <p className="rounded-2xl border border-border bg-surface px-6 py-8 text-center text-[13px] text-text-3">
              {filter === 'diff' && !needle
                ? 'Расхождений нет: адреса записей совпадают с нодами.'
                : 'Под эти условия записей нет.'}
            </p>
          ) : (
            zones
              .filter((z) => z.rows.length)
              .map((z) => {
                const linked = z.all.filter((r) => r.nodes.length).length;
                const diff = z.all.filter((r) => recordState(r) === 'diff').length;
                return (
                  <section
                    key={`${z.provider}:${z.name}`}
                    aria-label={`Домен ${z.name}`}
                    className="overflow-hidden rounded-2xl border border-border bg-surface"
                  >
                    <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border px-[18px] py-3">
                      <img
                        src={providerIcon(z.provider)}
                        alt=""
                        className="size-[22px] flex-none rounded-[6px]"
                      />
                      <h2 className="font-heading text-[15px] font-semibold break-all">{z.name}</h2>
                      <Pill>{PROVIDER_NAME[z.provider] ?? z.provider}</Pill>
                      <span className="ml-auto flex flex-wrap gap-x-3.5 text-[12.5px] text-text-3 max-md:hidden">
                        <span>
                          {z.all.length} {plural(z.all.length, 'запись', 'записи', 'записей')}
                        </span>
                        <span>
                          {linked} {plural(linked, 'связана', 'связаны', 'связаны')} с нодами
                        </span>
                        {diff > 0 && (
                          <span className="text-warn">
                            {diff} {plural(diff, 'отличается', 'отличаются', 'отличаются')}
                          </span>
                        )}
                      </span>
                    </header>
                    {z.rows.map((r) => (
                      <RecordRow
                        key={r.id}
                        r={r}
                        nodes={nodes}
                        auto={auto(r)}
                        busy={pending === r.id}
                        onOpen={() => setOpenId(r.id)}
                        onAuto={(on) => void setAuto(r, on)}
                      />
                    ))}
                  </section>
                );
              })
          )}
          {data && data.unmanaged.length > 0 && (
            <p className="rounded-2xl border border-dashed border-border-2 px-[18px] py-3.5 text-[12.5px] leading-relaxed text-text-3">
              Домены Host из Remnawave, которых нет в подключённых аккаунтах:{' '}
              <span className="font-mono text-text-2">{data.unmanaged.join(', ')}</span>. Подключите аккаунт,
              где они зарегистрированы, — и их записи появятся здесь.
            </p>
          )}
        </>
      )}
      {opened && (
        <RecordDialog
          record={opened}
          nodes={nodes}
          history={history.data?.items ?? []}
          auto={auto(opened)}
          autoBusy={pending === opened.id}
          onAuto={(on) => void setAuto(opened, on)}
          onClose={() => setOpenId(null)}
        />
      )}
      <HistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} query={history} />
      <ConnectionsDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        zones={{ cloudflare: zoneCount('cloudflare'), regru: zoneCount('regru') }}
      />
    </div>
  );
}

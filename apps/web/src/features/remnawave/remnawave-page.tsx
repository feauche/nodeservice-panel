import type { RemnawaveCert, RemnawaveNode, RemnawaveStats } from '@nodeservice/shared';
import {
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
  UsersIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CountryFlag } from '@/components/country-flag';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { formatDate } from '@/features/security/security-format';
import { AddServerDialog } from '@/features/servers/add-server-dialog';
import { useServers } from '@/features/servers/servers-api';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  useConnectRemnawave,
  useDisconnectRemnawave,
  useRefreshRemnawave,
  useRemnawaveStatus,
} from './remnawave-api';

/** Общее число байт (строка — может быть огромной) в человекочитаемый вид: «18.4 ТБ». */
export function formatByteTotal(raw: string | number | null): string {
  const bytes = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Аптайм секундами → «12 д 4 ч». */
function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3_600);
  if (days > 0) return `${days} д ${hours} ч`;
  const min = Math.floor((sec % 3_600) / 60);
  return hours > 0 ? `${hours} ч ${min} мин` : `${min} мин`;
}

function Tile({ caps, value, sub }: { caps: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2 px-3.5 py-3">
      <div className="text-[10.5px] font-semibold tracking-[0.05em] text-text-3 uppercase">{caps}</div>
      <div className="mt-0.5 font-heading text-[19px] font-bold">
        {value}
        {sub && <span className="ml-1.5 text-[11.5px] font-normal text-text-3">{sub}</span>}
      </div>
    </div>
  );
}

/** Сводка (B2): пользователи, онлайн сейчас, ноды на связи, трафик всего. */
function StatsTiles({ stats }: { stats: RemnawaveStats }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Tile caps="Пользователей" value={String(stats.users.total)} />
      <Tile caps="Онлайн сейчас" value={String(stats.online.now)} />
      <Tile caps="Нод на связи" value={String(stats.nodesOnline)} sub={`из ${stats.nodesTotal}`} />
      <Tile caps="Трафик всего" value={formatByteTotal(stats.trafficBytesLifetime)} />
    </div>
  );
}

const NODE_STATUS: Record<
  'connected' | 'connecting' | 'disabled' | 'down',
  { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }
> = {
  connected: { tone: 'ok', label: 'На связи' },
  connecting: { tone: 'warn', label: 'Подключается' },
  disabled: { tone: 'muted', label: 'Отключена вручную' },
  down: { tone: 'crit', label: 'Не на связи' },
};

function nodeStatusKey(n: RemnawaveNode): keyof typeof NODE_STATUS {
  if (n.isDisabled) return 'disabled';
  if (n.isConnecting) return 'connecting';
  return n.isConnected ? 'connected' : 'down';
}

function NodeRow({ node, matched, onAdd }: { node: RemnawaveNode; matched: boolean; onAdd: () => void }) {
  const status = NODE_STATUS[nodeStatusKey(node)];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-4 py-3 first:border-t-0">
      {node.countryCode && <CountryFlag code={node.countryCode} size="sm" />}
      <span className="min-w-0 flex-1 basis-[140px] truncate text-[13px] font-semibold">{node.name}</span>
      <span className="font-mono text-[11.5px] text-text-3">{node.address}</span>
      <Pill tone={status.tone}>{status.label}</Pill>
      {node.usersOnline !== null && (
        <span className="inline-flex items-center gap-1 text-[12px] text-text-2">
          <UsersIcon className="size-3.5 text-text-3" aria-hidden="true" />
          {node.usersOnline} онлайн
        </span>
      )}
      {node.trafficUsedBytes !== null && (
        <span className="text-[12px] text-text-3">
          {formatByteTotal(node.trafficUsedBytes)}
          {node.trafficLimitBytes !== null && ` из ${formatByteTotal(node.trafficLimitBytes)}`}
        </span>
      )}
      {!matched && (
        <Button
          type="button"
          variant="outline"
          onClick={onAdd}
          className="h-7 flex-none rounded-[7px] px-2 text-[11.5px]"
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Добавить в NodeService
        </Button>
      )}
      {node.lastStatusMessage && !node.isConnected && !node.isDisabled && (
        <span className="w-full basis-full text-[11.5px] text-crit">{node.lastStatusMessage}</span>
      )}
    </li>
  );
}

/** Плашка про срок TLS-сертификата домена панели (D1) — своя проверка, не данные из API Remnawave. */
function CertBanner({ cert, domain }: { cert: RemnawaveCert; domain: string }) {
  if (cert.status === 'unknown')
    return (
      <div className="flex items-start gap-2.5 rounded-2xl border border-border bg-surface-2 px-4 py-3 text-[12.5px] text-text-2">
        <ShieldQuestionIcon className="mt-0.5 size-4 flex-none text-text-3" aria-hidden="true" />
        <div>
          <div className="font-semibold">Сертификат панели не проверен</div>
          <div className="text-text-3">{cert.note ?? 'Не удалось проверить сертификат по HTTPS.'}</div>
        </div>
      </div>
    );
  const days = cert.daysLeft ?? 0;
  const when = cert.expiresAt ? formatDate(cert.expiresAt) : '—';
  if (cert.status === 'ok')
    return (
      <div className="flex items-start gap-2.5 rounded-2xl border border-ok/30 bg-ok-soft px-4 py-3 text-[12.5px] text-ok">
        <ShieldCheckIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
        <div>
          <div className="font-semibold">Сертификат в порядке</div>
          <div className="opacity-90">
            {domain}, до {when} (ещё {days} {days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'})
          </div>
        </div>
      </div>
    );
  const crit = cert.status === 'expired';
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-[12.5px]',
        crit ? 'border-crit/40 bg-crit-soft text-crit' : 'border-warn/40 bg-warn-soft text-warn',
      )}
    >
      <ShieldAlertIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
      <div>
        <div className="font-semibold">
          {crit ? 'Сертификат панели истёк' : 'Сертификат панели скоро истечёт'}
        </div>
        <div className="opacity-90">
          {domain} —{' '}
          {crit
            ? `просрочен с ${when}`
            : `осталось ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'} (до ${when})`}
          {crit
            ? '. Часть функций Remnawave может быть недоступна.'
            : '. Продлите его на самом сервере панели.'}
        </div>
      </div>
    </div>
  );
}

/** Форма подключения (A1): владелец создаёт токен только на чтение сам в Remnawave и вставляет сюда один раз. */
function ConnectForm() {
  const connect = useConnectRemnawave();
  const [domain, setDomain] = useState('');
  const [apiKey, setApiKey] = useState('');

  const submit = async () => {
    try {
      await connect.mutateAsync({ domain: domain.trim(), apiKey: apiKey.trim() });
      toast.success('Remnawave подключена.');
      setApiKey('');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="font-heading text-[15px] font-bold">Подключение</h2>
      <p className="mt-1 max-w-[720px] text-[12.5px] text-text-3">
        Remnawave — отдельная панель, которая управляет нодами Xray. Подключаем её только для чтения: домен и
        токен API вы создаёте сами в самой Remnawave («API Tokens» → «Создать токен», там выбираете права) и
        один раз вставляете сюда. Наша панель не выполняет в Remnawave никаких действий — только читает
        данные: сама она никогда не вызывает её эндпоинты записи, что бы токен ни разрешал. Домен и токен
        хранятся зашифрованными, как остальные секреты.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rw-domain" className="text-[13px] font-medium">
            Домен панели
          </label>
          <Input
            id="rw-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="vpn-panel.example.com"
            className="h-10 rounded-[10px] bg-surface-2 font-mono text-[13px]"
          />
          <span className="text-[12px] text-text-3">
            Адрес, по которому открывается сама Remnawave, без /api и без пути.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rw-key" className="text-[13px] font-medium">
            Ключ API
          </label>
          <PasswordField
            id="rw-key"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Вставьте токен из Remnawave…"
            className="font-mono"
          />
          <span className="text-[12px] text-text-3">
            Создайте в Remnawave: «API Tokens» → «Создать токен», выберите права только на чтение. Вставляется
            один раз, дальше не показывается.
          </span>
        </div>
      </div>
      <Button
        type="button"
        disabled={connect.isPending || !domain.trim() || !apiKey.trim()}
        onClick={() => void submit()}
        className="mt-4 h-10 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
      >
        {connect.isPending ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <KeyRoundIcon className="size-4" aria-hidden="true" />
        )}
        {connect.isPending ? 'Проверяю…' : 'Проверить и сохранить'}
      </Button>
    </section>
  );
}

export function RemnawavePage() {
  const status = useRemnawaveStatus();
  const servers = useServers();
  const refresh = useRefreshRemnawave();
  const disconnect = useDisconnectRemnawave();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [addNode, setAddNode] = useState<RemnawaveNode | null>(null);

  /** Адреса уже добавленных серверов — по ним решаем, у какой ноды есть кнопка «Добавить в NodeService». */
  const knownHosts = useMemo(() => new Set((servers.data?.items ?? []).map((s) => s.host)), [servers.data]);

  const doRefresh = async () => {
    try {
      await refresh.mutateAsync();
      toast.success('Данные Remnawave обновлены.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const doDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      setConfirmOpen(false);
      toast.success('Remnawave отключена.');
    } catch (err) {
      setConfirmOpen(false);
      toast.error(apiErrorMessage(err));
    }
  };

  if (status.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[220px] rounded-2xl" />
        <Skeleton className="h-[120px] rounded-2xl" />
      </div>
    );
  }
  if (status.isError) {
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(status.error)}
      </p>
    );
  }
  const s = status.data;
  if (!s.connected) return <ConnectForm />;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid size-7 flex-none place-items-center rounded-full bg-ok-soft text-ok">
                <CheckIcon className="size-4" aria-hidden="true" />
              </span>
              <h2 className="font-heading text-[15px] font-bold">Подключено</h2>
            </div>
            <p className="mt-1 font-mono text-[13px] text-text-2">{s.domain}</p>
            {s.error ? (
              <p role="alert" className="mt-1.5 max-w-[560px] text-[12.5px] text-crit">
                Сейчас недоступна: {s.error}. Показаны данные последней успешной проверки
                {s.checkedAt ? ` (${formatDate(s.checkedAt)})` : ''}.
              </p>
            ) : (
              s.checkedAt && (
                <p className="mt-1.5 text-[12px] text-text-3">Проверено {formatDate(s.checkedAt)}</p>
              )
            )}
          </div>
          <div className="flex flex-none gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={refresh.isPending}
              onClick={() => void doRefresh()}
              className="h-9 rounded-[9px] px-3 text-[12.5px]"
            >
              <RefreshCwIcon
                className={cn('size-4', refresh.isPending && 'animate-spin')}
                aria-hidden="true"
              />
              Обновить
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              className="h-9 rounded-[9px] border-transparent bg-transparent px-3 text-[12.5px] text-crit hover:bg-crit-soft hover:text-crit"
            >
              Отключить
            </Button>
          </div>
        </div>

        {s.stats && (
          <div className="mt-4 border-t border-border pt-4">
            <StatsTiles stats={s.stats} />
            <p className="mt-2.5 text-[12px] text-text-3">
              Активные {s.stats.users.active} · выключены {s.stats.users.disabled} · лимит{' '}
              {s.stats.users.limited} · истекли {s.stats.users.expired} — за сутки {s.stats.online.lastDay}{' '}
              онлайн, за неделю {s.stats.online.lastWeek}, не заходили {s.stats.online.never}. Версия панели{' '}
              {s.stats.panelVersion}, аптайм {formatUptime(s.stats.panelUptimeSec)}.
            </p>
          </div>
        )}
      </section>

      {s.nodes.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-3 font-heading text-[14px] font-bold">Ноды</h2>
          <ul>
            {s.nodes.map((n) => (
              <NodeRow
                key={n.uuid}
                node={n}
                matched={knownHosts.has(n.address)}
                onAdd={() => setAddNode(n)}
              />
            ))}
          </ul>
        </section>
      )}

      {s.cert && <CertBanner cert={s.cert} domain={s.domain ?? ''} />}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        kind="crit"
        title="Отключить Remnawave?"
        description="Домен и токен будут удалены из панели. Данные пользователей и нод в самой Remnawave не изменятся."
        yesLabel="Да, отключить"
        loading={disconnect.isPending}
        onConfirm={doDisconnect}
      />

      <AddServerDialog
        open={addNode !== null}
        onOpenChange={(open) => !open && setAddNode(null)}
        initialName={addNode?.name}
        initialHost={addNode?.address}
      />
    </div>
  );
}

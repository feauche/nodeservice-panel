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
import { plural } from '@/lib/plural';
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
/** Онлайн на нодах — сумма подключённых по всем нодам (то, что реально идёт через серверы). */
export const nodesOnline = (nodes: readonly RemnawaveNode[]): number =>
  nodes.reduce((sum, n) => sum + (n.usersOnline ?? 0), 0);

function StatsTiles({ stats, nodes }: { stats: RemnawaveStats; nodes: readonly RemnawaveNode[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Tile caps="Пользователей" value={String(stats.users.total)} />
      <Tile
        caps="Онлайн на нодах"
        value={String(nodesOnline(nodes))}
        sub={`подписок в сети ${stats.online.now}`}
      />
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

/** Лимит трафика 0 у Remnawave означает «без лимита», а не настоящий ноль — иначе получалось бы «161 ТБ из 0 Б». */
function hasTrafficLimit(node: RemnawaveNode): boolean {
  return node.trafficLimitBytes !== null && node.trafficLimitBytes > 0;
}

/**
 * Строка колонками (не просто через gap): имя ноды разной длины иначе сдвигало бы адрес, статус,
 * онлайн и трафик у каждой ноды по-разному — на широком экране это выглядело рябью без выравнивания.
 * На телефоне колонки не нужны — там всё и так в одну ленту переносится.
 */
function NodeRow({
  node,
  serverName,
  onAdd,
}: {
  node: RemnawaveNode;
  /** Сервер панели, на котором работает нода; null — в панели его нет (или он не связался с нодой). */
  serverName: string | null;
  onAdd: () => void;
}) {
  const status = NODE_STATUS[nodeStatusKey(node)];
  return (
    <li className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-border px-4 py-3.5 first:border-t-0 sm:grid sm:grid-cols-[20px_minmax(140px,1.6fr)_140px_120px_92px_150px_190px] sm:items-center sm:gap-y-0">
      {node.countryCode ? (
        <CountryFlag code={node.countryCode} size="md" />
      ) : (
        <span aria-hidden="true" className="hidden h-[15px] w-[20px] flex-none sm:inline-block" />
      )}
      <span className="min-w-0 truncate text-[14px] font-semibold">{node.name}</span>
      <span className="min-w-0 truncate font-mono text-[12.5px] text-text-3" title={node.address}>
        {node.address}
      </span>
      <Pill tone={status.tone}>{status.label}</Pill>
      <span className="inline-flex items-center gap-1 text-[13.5px] text-text-2 sm:justify-self-end">
        {node.usersOnline !== null && (
          <>
            <UsersIcon className="size-3.5 text-text-3" aria-hidden="true" />
            <b className="font-semibold text-foreground">{node.usersOnline}</b> онлайн
          </>
        )}
      </span>
      <span className="text-[13.5px] text-text-3 sm:justify-self-end">
        {node.trafficUsedBytes !== null && (
          <>
            {formatByteTotal(node.trafficUsedBytes)}
            {hasTrafficLimit(node) && ` из ${formatByteTotal(node.trafficLimitBytes)}`}
          </>
        )}
      </span>
      {serverName === null ? (
        <Button
          type="button"
          variant="outline"
          onClick={onAdd}
          className="h-7 flex-none justify-self-end rounded-[7px] px-2 text-[12px]"
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Добавить в NodeService
        </Button>
      ) : (
        <span
          className="min-w-0 truncate text-[12.5px] text-text-3 sm:justify-self-end"
          title={`Нода работает на сервере «${serverName}». Связь меняется в его профиле: «Нода Remnawave на сервере».`}
        >
          Сервер: {serverName}
        </span>
      )}
      {node.lastStatusMessage && !node.isConnected && !node.isDisabled && (
        <span className="w-full text-[11.5px] text-crit sm:col-span-full">{node.lastStatusMessage}</span>
      )}
    </li>
  );
}

/** Плашка про срок TLS-сертификата домена панели (D1) — своя проверка, не данные из API Remnawave. */
const SHORT_DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const daysWord = (n: number) => plural(n, 'день', 'дня', 'дней');

/**
 * Сертификат панели — метка под доменом (витрина `remnawave-cert-variants.html`, A): зелёная — в порядке,
 * жёлтая — скоро истечёт, красная — истёк, серая — не проверен. Точная дата и совет — в подсказке.
 */
function CertChip({ cert, domain }: { cert: RemnawaveCert; domain: string }) {
  const days = cert.daysLeft ?? 0;
  const when = cert.expiresAt ? formatDate(cert.expiresAt) : '—';
  const short = cert.expiresAt ? SHORT_DATE.format(new Date(cert.expiresAt)).replace('.', '') : '—';
  const view =
    cert.status === 'unknown'
      ? {
          tone: 'bg-surface-3 text-text-2',
          Icon: ShieldQuestionIcon,
          text: 'Сертификат не проверен',
          title: cert.note ?? 'Не удалось проверить сертификат по HTTPS.',
        }
      : cert.status === 'ok'
        ? {
            tone: 'bg-ok-soft text-ok',
            Icon: ShieldCheckIcon,
            text: `Сертификат до ${short} · ${days} ${daysWord(days)}`,
            title: `${domain}: сертификат в порядке, до ${when}.`,
          }
        : cert.status === 'expired'
          ? {
              tone: 'bg-crit-soft text-crit',
              Icon: ShieldAlertIcon,
              text: `Сертификат истёк ${short}`,
              title: `${domain}: сертификат просрочен с ${when}. Часть функций Remnawave может быть недоступна.`,
            }
          : {
              tone: 'bg-warn-soft text-warn',
              Icon: ShieldAlertIcon,
              text: `Сертификат истекает через ${days} ${daysWord(days)}`,
              title: `${domain}: сертификат до ${when}. Продлите его на самом сервере панели.`,
            };
  const Icon = view.Icon;
  return (
    <span
      title={view.title}
      data-testid="rw-cert"
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold whitespace-nowrap',
        view.tone,
      )}
    >
      <Icon className="size-3.5 flex-none" aria-hidden="true" />
      {view.text}
    </span>
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

  /** Названия серверов панели: у связанной ноды показываем её сервер, у остальных — «Добавить в NodeService». */
  const serverNames = useMemo(
    () => new Map((servers.data?.items ?? []).map((s) => [s.id, s.name])),
    [servers.data],
  );

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
            {(s.cert || (!s.error && s.checkedAt)) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                {s.cert && <CertChip cert={s.cert} domain={s.domain ?? ''} />}
                {!s.error && s.checkedAt && (
                  <span className="text-[12px] text-text-3">Проверено {formatDate(s.checkedAt)}</span>
                )}
              </div>
            )}
            {s.error && (
              <p role="alert" className="mt-1.5 max-w-[560px] text-[12.5px] text-crit">
                Сейчас недоступна: {s.error}. Показаны данные последней успешной проверки
                {s.checkedAt ? ` (${formatDate(s.checkedAt)})` : ''}.
              </p>
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
            <StatsTiles stats={s.stats} nodes={s.nodes} />
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
                serverName={serverNames.get(n.serverIds?.[0] ?? '') ?? null}
                onAdd={() => setAddNode(n)}
              />
            ))}
          </ul>
        </section>
      )}

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

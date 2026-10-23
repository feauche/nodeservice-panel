import {
  type BsFirewallCommands,
  type BsRental,
  type BsRentalTarget,
  type BsWs,
  type BsWsExitInput,
  bsPointHistorySchema,
  bsRentalChangePreviewSchema,
  bsRentalChangeResultSchema,
  bsRentalCheckSchema,
  bsRentalsSchema,
  bsWsChangePreviewSchema,
  bsWsChangeResultSchema,
  bsWsConnectSchema,
  bsWsListSchema,
  bsWsVerifySchema,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheckIcon,
  CopyIcon,
  FileClockIcon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  NetworkIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  Settings2Icon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CountryFlag } from '@/components/country-flag';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { nodeOption } from '@/features/nodes/node-option';
import { useNodes } from '@/features/nodes/nodes-api';
import { formatAgo } from '@/features/security/security-format';
import { Pill, Segmented, Toggle } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { plural } from '@/lib/plural';
import { explainProbeError } from '@/lib/probe-error';
import { cn, randomId } from '@/lib/utils';

type Tone = 'ok' | 'warn' | 'crit' | 'muted' | 'info';
const WS_STATE: Record<string, [string, Tone]> = {
  active: ['Работает', 'ok'],
  pending: ['Готовится', 'info'],
  waiting: ['Ждёт запуска', 'info'],
  expired: ['Срок истёк', 'crit'],
  admin: ['Приостановлена', 'warn'],
  maintenance: ['Обслуживание', 'warn'],
  gone: ['Удалена', 'muted'],
  released: ['Освобождена', 'muted'],
};
const EXIT_STATE: Record<string, [string, Tone]> = {
  up: ['работает', 'ok'],
  degraded: ['с перебоями', 'warn'],
  down: ['не отвечает', 'crit'],
  disabled: ['выключен', 'muted'],
  unknown: ['неизвестно', 'muted'],
};
const RENTAL_STATE: Record<string, [string, Tone]> = {
  active: ['Активна', 'ok'],
  throttled: ['Скорость ограничена', 'warn'],
  node_down: ['Вход недоступен', 'crit'],
  pending: ['Готовится', 'info'],
  suspended: ['Приостановлена', 'warn'],
  expired: ['Срок истёк', 'crit'],
};
const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  muted: 'bg-text-3',
  info: 'bg-brand',
};
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const yearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
/** «30 октября», в другом году — «10 января 2027». */
const day = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : yearFmt.format(d);
};
const gb = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
const nodeAt = (nodes: RemnawaveNode[], ...hosts: Array<string | null | undefined>) =>
  nodes.find((n) => hosts.some((h) => h && n.address === h));

function Dot({ tone }: { tone: Tone }) {
  return <span className={cn('size-2 flex-none rounded-full', DOT[tone])} aria-hidden="true" />;
}
/**
 * Выход точки: нода (если адрес совпал с нодой Remnawave) — именем сверху, адрес — снизу. Строки списка так выглядят
 * одинаково при любой длине имени и ширине карточки.
 */
function ExitName({ node, host, port }: { node?: RemnawaveNode; host: string; port: number }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {node && (
        <span className="inline-flex items-center gap-1.5 font-medium">
          {node.countryCode && <CountryFlag code={node.countryCode} size="sm" />}
          {node.name}
        </span>
      )}
      <span className="font-mono text-[11.5px] break-all text-text-3">
        {host}:{port}
      </span>
    </span>
  );
}
/**
 * Строка выхода в карточке точки: точка состояния, нода с адресом и справа подпись с итогом. На узкой карточке правая
 * часть уходит под адрес целиком, а не сжимает его так, что адрес рвётся посередине.
 */
function ExitRow({ tone, name, children }: { tone: Tone; name: ReactNode; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border py-2 text-[12.5px] first:border-t-0">
      <Dot tone={tone} />
      <span className="min-w-[10.5rem] flex-1">{name}</span>
      <span className="ml-auto flex items-center gap-2.5">{children}</span>
    </li>
  );
}
const small = 'h-9 rounded-[10px] px-3.5 text-[12.5px]';
/**
 * Кнопки карточки точки: в строке делят место поровну, одинаковой ширины, а не «одна и две» с рваным краем; на узкой
 * карточке каждая на всю ширину.
 */
const cardActions = 'flex flex-wrap gap-2 [&>button]:flex-1 [&>button]:basis-44';
const dialogBox =
  'flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0';
const dialogFoot =
  'flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4';
const footButton = 'h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:flex-none sm:max-w-none';
function DialogHead({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 max-sm:px-4">
      <div className="min-w-0 flex-1">
        <DialogTitle className="font-heading text-[17px]">{title}</DialogTitle>
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
function Kick({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">{children}</p>
  );
}

/** Точка входа WebSocket: скорость, срок, сертификат, выходы на ваши ноды и адреса моста. */
function WsCard({
  ws,
  nodes,
  onEdit,
  onConnect,
  onHistory,
}: {
  ws: BsWs;
  nodes: RemnawaveNode[];
  onEdit: () => void;
  onConnect: () => void;
  onHistory: () => void;
}) {
  const [stateLabel, stateTone] =
    ws.state === 'active' && ws.ready === false
      ? (['Не готова', 'warn'] as [string, Tone])
      : (WS_STATE[ws.state] ?? [ws.state, 'muted']);
  return (
    <article
      aria-label={`Точка ${ws.name}`}
      className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="info">WebSocket</Pill>
        <b className="font-heading text-[15px] font-semibold">{ws.name}</b>
        {(ws.label || ws.address) && (
          <span className="min-w-0 truncate text-[12.5px] text-text-3">{ws.label || ws.address}</span>
        )}
        <span className="ml-auto">
          <Pill tone={stateTone}>{stateLabel}</Pill>
        </span>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-text-2">
        {ws.mbit != null && (
          <span>
            <span className="text-text-3">Скорость</span> <b className="font-semibold">{ws.mbit} Мбит/с</b>
          </span>
        )}
        <span>
          <span className="text-text-3">До</span> <b className="font-semibold">{day(ws.expires_at)}</b>
          {ws.autorenew?.enabled
            ? ` · автопродление${ws.autorenew.days ? ` на ${ws.autorenew.days} ${plural(ws.autorenew.days, 'день', 'дня', 'дней')}` : ''}`
            : ' · без автопродления'}
        </span>
        {ws.cert?.expires_at && (
          <span>
            <span className="text-text-3">Сертификат</span>{' '}
            <b className="font-semibold">до {day(ws.cert.expires_at)}</b>
          </span>
        )}
        {ws.traffic?.used_gb != null && (
          <span>
            <span className="text-text-3">Трафик</span>{' '}
            <b className="font-semibold">{gb(ws.traffic.used_gb)}</b>
          </span>
        )}
      </p>
      <div>
        <Kick>Выходы — ваши ноды</Kick>
        {ws.exits.length ? (
          <ul className="flex flex-col">
            {ws.exits.map((e) => {
              const [label, tone] = EXIT_STATE[e.enabled ? (e.state ?? 'unknown') : 'disabled'] ?? [
                'неизвестно',
                'muted',
              ];
              return (
                <ExitRow
                  key={`${e.host}:${e.port}`}
                  tone={tone}
                  name={<ExitName node={nodeAt(nodes, e.host, e.ip)} host={e.host} port={e.port} />}
                >
                  <span className="text-text-3">{e.backup ? 'запасной' : `вес ${e.weight ?? 1}`}</span>
                  <Pill tone={tone === 'info' ? 'muted' : tone}>{label}</Pill>
                </ExitRow>
              );
            })}
          </ul>
        ) : (
          <p className="text-[12.5px] text-text-3">Серверов пока нет — добавьте их в «Изменить выходы».</p>
        )}
      </div>
      {ws.bridges.length > 0 && (
        <p className="flex items-start gap-2 text-[12px] text-text-3">
          <InfoIcon className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
          <span>
            Порт ноды открывайте только адресам точки: {ws.bridges.length}{' '}
            {plural(ws.bridges.length, 'адрес', 'адреса', 'адресов')}
            {ws.bridges_changed_at ? `, обновлены ${formatAgo(ws.bridges_changed_at)}` : ''}. Команды — в
            «Настройках подключения».
          </span>
        </p>
      )}
      {ws.issue && (
        <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{ws.issue}</p>
      )}
      <div className={cardActions}>
        <Button variant="outline" className={small} onClick={onEdit}>
          <Settings2Icon className="size-3.5" aria-hidden="true" />
          Изменить выходы
        </Button>
        <Button variant="outline" className={small} onClick={onConnect}>
          <KeyRoundIcon className="size-3.5" aria-hidden="true" />
          Настройки подключения
        </Button>
        <Button variant="outline" className={small} onClick={onHistory}>
          <FileClockIcon className="size-3.5" aria-hidden="true" />
          История
        </Button>
      </div>
    </article>
  );
}

/** Точка аренды TCP/UDP: трафик, выходы с задержкой, применение конфигурации, проверка с точки. */
function RentalCard({
  rental: r,
  nodes,
  onCheck,
  onEdit,
  onHistory,
  checking,
}: {
  rental: BsRental;
  nodes: RemnawaveNode[];
  onCheck: () => void;
  onEdit: () => void;
  onHistory: () => void;
  checking: boolean;
}) {
  const [stateLabel, stateTone] = RENTAL_STATE[r.status] ?? [r.status, 'muted'];
  const pct =
    r.traffic.used_pct ?? (r.traffic.quota_gb ? (r.traffic.used_gb / r.traffic.quota_gb) * 100 : null);
  return (
    <article
      aria-label={`Точка ${r.label || r.endpoint}`}
      className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="muted">{r.proto.toUpperCase()}</Pill>
        <b className="font-heading text-[15px] font-semibold">{r.label || 'Точка входа'}</b>
        <span className="font-mono text-[12px] text-text-3">{r.endpoint}</span>
        <span className="ml-auto">
          <Pill tone={stateTone}>{stateLabel}</Pill>
        </span>
      </div>
      {r.expires_at && (
        <p className="text-[12.5px] text-text-2">
          <span className="text-text-3">До</span> <b className="font-semibold">{day(r.expires_at)}</b>
        </p>
      )}
      {r.traffic.unlimited ? (
        <p className="text-[12.5px] text-text-2">
          <span className="text-text-3">Трафик</span> <b className="font-semibold">{gb(r.traffic.used_gb)}</b>{' '}
          · без лимита
        </p>
      ) : (
        <div>
          <div className="mb-1 flex justify-between gap-3 text-[12.5px]">
            <span className="text-text-3">Трафик</span>
            <span>
              <b className="font-semibold">{gb(r.traffic.used_gb)}</b> из {gb(r.traffic.quota_gb ?? 0)}
              {r.traffic.left_gb != null && ` · осталось ${gb(r.traffic.left_gb)}`}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <i
              className={cn(
                'block h-full rounded-full',
                (pct ?? 0) >= 90 ? 'bg-crit' : (pct ?? 0) >= 60 ? 'bg-warn' : 'bg-ok',
              )}
              style={{ width: `${Math.min(100, pct ?? 0)}%` }}
            />
          </div>
        </div>
      )}
      <ul className="flex flex-col">
        {r.targets.map((t) => {
          const active = r.health.active === (t.backup ? 'backup' : 'primary');
          const rtt = t.backup ? r.health.backup_rtt_ms : r.health.primary_rtt_ms;
          return (
            <ExitRow
              key={`${t.host}:${t.port}:${t.backup}`}
              tone={r.health.up === false && active ? 'crit' : active ? 'ok' : 'muted'}
              name={<ExitName node={nodeAt(nodes, t.host)} host={t.host} port={t.port} />}
            >
              <span className="text-text-3 tabular-nums">{rtt != null ? `${rtt} мс` : ''}</span>
              <Pill tone={t.backup ? 'muted' : 'ok'}>
                {t.backup ? 'резервный' : `основной · вес ${t.weight}`}
              </Pill>
            </ExitRow>
          );
        })}
      </ul>
      {!r.config.in_sync && (
        <p className="text-[12px] text-warn">
          Изменение ещё применяется на сервере точки (версия {r.config.applied_version} →{' '}
          {r.config.desired_version}).
        </p>
      )}
      <div className={cardActions}>
        <Button variant="outline" className={small} disabled={!r.can_check || checking} onClick={onCheck}>
          <RadarIcon className="size-3.5" aria-hidden="true" />
          Проверить с точки
        </Button>
        <Button variant="outline" className={small} onClick={onEdit}>
          <Settings2Icon className="size-3.5" aria-hidden="true" />
          Выходные адреса
        </Button>
        <Button variant="outline" className={small} onClick={onHistory}>
          <FileClockIcon className="size-3.5" aria-hidden="true" />
          История
        </Button>
      </div>
    </article>
  );
}

/** Значение с кнопкой «Скопировать». */
function CopyRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-[12.5px] first:border-t-0 max-sm:grid-cols-[minmax(0,1fr)_auto]">
      <span className="text-text-3 max-sm:col-span-2">{label}</span>
      <span className={cn('min-w-0 break-all', mono && 'font-mono text-[12px]')}>{value}</span>
      <button
        type="button"
        aria-label={`Скопировать: ${label}`}
        onClick={(e) => {
          void copyText(value, e.currentTarget).then((ok) => {
            if (!ok) return;
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] border border-border px-2.5 text-[12px] text-text-2 transition-colors hover:bg-surface-2"
      >
        <CopyIcon className="size-3.5" aria-hidden="true" />
        {done ? 'Скопировано' : 'Копировать'}
      </button>
    </div>
  );
}
function CodeBlock({ label, code }: { label: string; code: string | null | undefined }) {
  const [done, setDone] = useState(false);
  if (!code) return null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-[12px] text-text-3">{label}</span>
        <button
          type="button"
          aria-label={`Скопировать: ${label}`}
          onClick={(e) => {
            void copyText(code, e.currentTarget).then((ok) => {
              if (!ok) return;
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            });
          }}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] border border-border px-2.5 text-[12px] text-text-2 transition-colors hover:bg-surface-2"
        >
          <CopyIcon className="size-3.5" aria-hidden="true" />
          {done ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre className="max-h-56 overflow-auto rounded-[10px] border border-border bg-bg-2 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  );
}

/** Команды проверки и отката: по инструменту (ufw, nftables, «снаружи») или одной строкой — прежний вид. */
function byTool(v: BsFirewallCommands | null | undefined): {
  common?: string | null;
  ufw?: string | null;
  nftables?: string | null;
  outside?: string | null;
} {
  return typeof v === 'string' ? { common: v } : (v ?? {});
}

/** «Настройки подключения» точки WebSocket: адрес для клиента, inbound для Xray, команды файрвола. Секреты. */
function WsConnectDialog({ ws, onClose }: { ws: BsWs; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['bschecker-ws-connect', ws.id],
    queryFn: ({ signal }) =>
      api.get(`/integrations/bschecker/ws/${ws.id}/connect`, bsWsConnectSchema, signal),
    retry: false,
    gcTime: 0,
  });
  const c = q.data;
  const h = c?.host;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[780px]')}>
        <DialogHead
          title={`Настройки подключения · ${ws.name}`}
          description="Секреты точки: путь работает как пароль, в inbound — ключ сертификата. Никому не пересылайте."
        />
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5 max-sm:px-4">
          {q.isPending ? (
            <div role="status" aria-label="Загрузка настроек подключения" className="flex flex-col gap-2.5">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-full rounded-[10px]" />
              ))}
            </div>
          ) : q.isError || !c ? (
            <p
              role="alert"
              className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
            >
              {apiErrorMessage(q.error)}
            </p>
          ) : (
            <>
              <div>
                <Kick>Подключение клиента</Kick>
                <div className="rounded-[12px] border border-border px-3.5">
                  <CopyRow
                    label="Адрес"
                    value={h?.address ? `${h.address}${h.port ? `:${h.port}` : ''}` : (c.address ?? null)}
                  />
                  <CopyRow label="Защита" value={h?.security} />
                  <CopyRow label="Транспорт" value={h?.network} />
                  <CopyRow label="SNI" value={h?.sni} />
                  <CopyRow label="Host" value={h?.host} />
                  <CopyRow label="Путь" value={h?.path} />
                  <CopyRow label="ALPN" value={Array.isArray(h?.alpn) ? h.alpn.join(',') : h?.alpn} />
                  <CopyRow label="Отпечаток" value={h?.fingerprint} />
                </div>
              </div>
              <div>
                <Kick>Inbound для Xray на вашем сервере</Kick>
                {c.inbound_ready && c.inbound ? (
                  <CodeBlock
                    label={`Порт ${c.inbound_port ?? '—'}: вставьте в конфиг Xray`}
                    code={JSON.stringify(c.inbound, null, 2)}
                  />
                ) : (
                  <p className="text-[12.5px] text-text-3">
                    Ещё не готов —{' '}
                    {c.inbound_wait === 'cert'
                      ? 'ждёт выпуска сертификата'
                      : c.inbound_wait === 'exit'
                        ? 'нужен включённый сервер в выходах'
                        : 'подождите несколько минут'}
                    .
                  </p>
                )}
              </div>
              {(c.firewall?.by_port.length ?? 0) > 0 && (
                <div className="flex flex-col gap-2.5">
                  <Kick>Открыть порт только адресам точки</Kick>
                  {c.firewall?.by_port.map((f) => {
                    const check = byTool(f.check);
                    const rollback = byTool(f.rollback);
                    return (
                      <div
                        key={f.port}
                        className="flex flex-col gap-2 rounded-[12px] border border-border p-3"
                      >
                        <b className="text-[13px] font-semibold">Порт {f.port}</b>
                        <CodeBlock label="ufw" code={f.ufw} />
                        <CodeBlock label="nftables" code={f.nftables} />
                        <CodeBlock label="Проверить" code={check.common} />
                        <CodeBlock label="Проверить · ufw" code={check.ufw} />
                        <CodeBlock label="Проверить · nftables" code={check.nftables} />
                        <CodeBlock
                          label="Проверить с другого компьютера — порт не должен отвечать"
                          code={check.outside}
                        />
                        <CodeBlock label="Откатить" code={rollback.common} />
                        <CodeBlock label="Откатить · ufw" code={rollback.ufw} />
                        <CodeBlock label="Откатить · nftables" code={rollback.nftables} />
                      </div>
                    );
                  })}
                </div>
              )}
              {c.cert?.expires_at && (
                <p className="text-[12.5px] text-text-2">
                  <span className="text-text-3">Сертификат</span> до {day(c.cert.expires_at)}
                  {c.cert.names?.length ? ` · ${c.cert.names.join(', ')}` : ''}
                </p>
              )}
            </>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Просмотр настроек записан в «Журнал».
          </p>
          <DialogSecondaryButton onClick={onClose} className={footButton}>
            Закрыть
          </DialogSecondaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Row<T> = T & { rowId: string };
const withId = <T,>(list: T[]): Array<Row<T>> => list.map((t) => ({ ...t, rowId: randomId() }));

/** Число из поля: только цифры; пусто — null. */
const digits = (v: string) => v.replace(/\D/g, '');
const intOf = (v: string): number | null => (v === '' ? null : Number(v));
const inRange = (v: string, min: number, max: number) => {
  const n = intOf(v);
  return n !== null && Number.isInteger(n) && n >= min && n <= max;
};
const fieldLabel = 'mb-1.5 block text-[12.5px] font-medium text-text-2';
/**
 * Поле числа в карточке сервера: подпись сверху, ввод цифрами без подстановок — можно стереть всё и набрать
 * заново; ошибка — под полем, после ухода из поля или попытки сохранить.
 */
function NumField({
  id,
  label,
  ariaLabel,
  value,
  onChange,
  onBlur,
  error,
  placeholder,
  disabled,
  maxLength,
}: {
  id: string;
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  error: string | null;
  placeholder?: string;
  disabled?: boolean;
  maxLength: number;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <Input
        id={id}
        aria-label={ariaLabel}
        inputMode="numeric"
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(ev) => onChange(digits(ev.target.value))}
        onBlur={onBlur}
        className={cn('h-10 rounded-[10px] bg-surface-2', error && 'border-crit')}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-[11.5px] leading-snug text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
/** Выбор ноды для выхода: подставляет её адрес и порт; «вручную» — адрес вводится сам. */
function NodePick({
  nodes,
  host,
  disabled,
  label,
  onPick,
}: {
  nodes: RemnawaveNode[];
  host: string;
  disabled: boolean;
  label: string;
  onPick: (node: RemnawaveNode | null) => void;
}) {
  return (
    <Combobox
      ariaLabel={label}
      disabled={disabled}
      value={nodes.find((n) => n.address === host)?.uuid ?? '__manual'}
      onChange={(v) => onPick(nodes.find((n) => n.uuid === v) ?? null)}
      options={[
        { value: '__manual', label: 'Адрес вручную', pinned: true },
        ...nodes.map((n) => nodeOption({ id: n.uuid, name: n.name, host: n.address })),
      ]}
      placeholder="Выберите ноду"
      searchPlaceholder="Найти ноду…"
      className="h-10 w-full"
    />
  );
}

/** Сервер точки, пока его правят: числа — строками, как их набирают. */
type ExitDraft = Omit<BsWsExitInput, 'port' | 'weight' | 'max_connections'> & {
  port: string;
  weight: string;
  limit: string;
};
type ExitErrors = Partial<Record<'host' | 'port' | 'weight' | 'limit', string>>;
/** Что не так с сервером: пустой адрес, порт вне 1–65 535 или 22, вес вне 1–100, лимит вне 1–100 000. */
function exitErrors(e: ExitDraft): ExitErrors {
  const out: ExitErrors = {};
  if (e.host.trim().length < 3) out.host = 'Укажите IP или домен сервера';
  if (!inRange(e.port, 1, 65_535) || e.port === '22') out.port = 'Порт — от 1 до 65 535, не 22';
  if (!e.backup && !inRange(e.weight, 1, 100)) out.weight = 'Вес — от 1 до 100';
  if (e.limit !== '' && !inRange(e.limit, 1, 100_000)) out.limit = 'Лимит — от 1 до 100 000 или пусто';
  return out;
}
/** Сервер для сервиса: у запасного вес не нужен — прежний, если он верный, иначе 1; пустой лимит — без лимита. */
function toExit({ rowId, port, weight, limit, ...e }: Row<ExitDraft>): BsWsExitInput {
  return {
    ...e,
    port: Number(port),
    weight: inRange(weight, 1, 100) ? Number(weight) : 1,
    max_connections: limit === '' ? null : Number(limit),
  };
}

/** Сервер точки после сохранения: состояние по данным самой точки. */
const VERIFY_STATE: Record<string, [string, Tone]> = {
  up: ['работает', 'ok'],
  degraded: ['с перебоями', 'warn'],
  down: ['не отвечает', 'crit'],
};
/** Сколько ждём итог от точки в окне: дольше — итог виден в карточке, окно не держим. */
const VERIFY_WINDOW_MS = 90_000;
const VERIFY_EVERY_MS = 4_000;
interface VerifyState {
  done: boolean;
  failing: number;
  expired: boolean;
}

/**
 * Итог проверки серверов точки после сохранения. Проверяет сама точка — с панели порт ноды недоступен (он открыт
 * только адресам точки), поэтому ложное «не отвечает» исключено. Опрос идёт, пока не будет итога или не выйдет
 * окно ожидания; «Проверить снова» открывает новое окно ожидания (оно бесплатное).
 */
function WsVerifyPanel({
  ws,
  nodes,
  after,
  changeId,
  round,
  fail,
  onState,
}: {
  ws: BsWs;
  nodes: RemnawaveNode[];
  /** Список, который только что отправили, — показывается, пока точка не ответила. */
  after: BsWsExitInput[];
  changeId: string;
  round: number;
  fail: (message: string | null) => void;
  /** Что с проверкой: итог готов (и сколько серверов не отвечает) или вышло окно ожидания. */
  onState: (state: VerifyState) => void;
}) {
  const [expired, setExpired] = useState(false);
  // Новое окно ожидания — с каждой попыткой «Проверить снова» и с каждым новым изменением.
  // biome-ignore lint/correctness/useExhaustiveDependencies: окно ожидания начинается заново с раундом
  useEffect(() => {
    setExpired(false);
    const t = setTimeout(() => setExpired(true), VERIFY_WINDOW_MS);
    return () => clearTimeout(t);
  }, [round, changeId]);
  const verify = useQuery({
    queryKey: ['bschecker-ws-verify', ws.id, changeId, round],
    queryFn: () => api.post(`/integrations/bschecker/ws/${ws.id}/verify`, { changeId }, bsWsVerifySchema),
    refetchInterval: (q) => (q.state.data?.done || expired ? false : VERIFY_EVERY_MS),
    retry: false,
    gcTime: 0,
  });
  const v = verify.data;
  const client = useQueryClient();
  const done = v?.done === true;
  const failingCount = v?.failing.length ?? 0;
  useEffect(() => {
    onState({ done, failing: failingCount, expired });
    if (done) void client.invalidateQueries({ queryKey: ['bschecker-ws'] });
  }, [done, failingCount, expired, onState, client]);
  useEffect(
    () => fail(verify.isError ? apiErrorMessage(verify.error) : null),
    [verify.isError, verify.error, fail],
  );
  const waiting = !done && !expired;
  /** «host:port» из итога точки → имя ноды, если адрес совпал с нодой Remnawave; иначе сам адрес. */
  const failName = (hostPort: string) => {
    const at = hostPort.lastIndexOf(':');
    return nodeAt(nodes, at > 0 ? hostPort.slice(0, at) : hostPort)?.name ?? hostPort;
  };
  const rows =
    v?.exits ??
    after
      .filter((e) => e.enabled)
      .map((e) => ({ host: e.host, port: e.port, backup: e.backup, state: 'unknown', hint: null }));
  return (
    <div className="flex flex-col gap-3 px-6 py-5 max-sm:px-4">
      <ul aria-label="Серверы точки после сохранения" className="flex flex-col gap-2.5">
        {rows.map((e, i) => {
          const [label, tone] =
            VERIFY_STATE[e.state] ??
            (waiting
              ? (['проверяет', 'info'] as [string, Tone])
              : (['нет данных', 'muted'] as [string, Tone]));
          return (
            <li
              key={`${e.host}:${e.port}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[12px] border border-border px-3.5 py-3"
            >
              <b className="w-[74px] flex-none text-[13px] font-semibold max-sm:w-full max-sm:text-[11px] max-sm:tracking-[0.08em] max-sm:text-text-3 max-sm:uppercase">
                Сервер {i + 1}
              </b>
              <span className="min-w-[10.5rem] flex-1">
                <ExitName node={nodeAt(nodes, e.host)} host={e.host} port={e.port} />
              </span>
              <Pill tone={tone}>
                {tone === 'info' && <Loader2Icon className="mr-1 size-3 animate-spin" aria-hidden="true" />}
                {label}
              </Pill>
              {e.state === 'down' && e.hint && <p className="w-full text-[12px] text-text-3">{e.hint}</p>}
            </li>
          );
        })}
      </ul>
      {waiting && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-[12px] border border-border bg-surface-2/60 px-3.5 py-3 text-[12.5px] text-text-2"
        >
          <Loader2Icon className="mt-0.5 size-4 flex-none animate-spin text-brand" aria-hidden="true" />
          <span>
            Сохранено. Точка проверяет серверы — обычно до минуты: она сама подключается к каждому, с панели
            этого не проверить (порт ноды открыт только адресам точки).
          </span>
        </p>
      )}
      {done && v && v.failing.length === 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-[12px] border border-ok/35 bg-ok/[0.07] px-3.5 py-3 text-[12.5px] text-text-2"
        >
          <CircleCheckIcon className="mt-0.5 size-4 flex-none text-ok" aria-hidden="true" />
          <span>
            <b className="font-semibold text-foreground">
              Точка проверила серверы — {v.total === 1 ? 'сервер работает' : `все ${v.total} работают`}.
            </b>{' '}
            Изменение записано в «Журнал».
          </span>
        </p>
      )}
      {done && v && v.failing.length > 0 && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[12px] border border-warn/35 bg-warn/[0.07] px-3.5 py-3 text-[12.5px] leading-relaxed text-text-2"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
          <span>
            <b className="font-semibold text-foreground">
              {v.failing.length >= v.total && v.total > 1
                ? 'Ни один сервер не отвечает точке.'
                : v.failing.length === 1
                  ? `Сервер ${failName(v.failing[0] ?? '')} не отвечает точке.`
                  : `Серверы не отвечают точке: ${v.failing.map(failName).join(', ')}.`}
            </b>{' '}
            {v.failing.length >= v.total
              ? 'Клиенты не смогут подключиться через точку, пока хотя бы один сервер не заработает.'
              : `Клиенты на ${v.failing.length === 1 ? 'него' : 'них'} не попадут: точка отправит их на остальные серверы.`}{' '}
            Обычно порт на ноде закрыт для адресов точки — команды в «Настройках подключения».
          </span>
        </p>
      )}
      {!done && expired && (
        <p
          role="status"
          className="rounded-[12px] border border-border bg-surface-2/60 px-3.5 py-3 text-[12.5px] text-text-2"
        >
          Точка пока не дала итог по всем серверам — это бывает до пары минут. Итог появится в карточке точки;
          можно проверить снова.
        </p>
      )}
    </div>
  );
}

/** Смена серверов точки WebSocket: целиком, с подтверждением «было → станет»; повтор — тем же ключом. */
function WsExitsEditor({ ws, nodes, onClose }: { ws: BsWs; nodes: RemnawaveNode[]; onClose: () => void }) {
  const client = useQueryClient();
  // Числа — строками, пока их правят: поле можно очистить и набрать заново; проверка — при уходе и сохранении.
  const [exits, setExits] = useState<Array<Row<ExitDraft>>>(
    withId(
      ws.exits.map((e) => ({
        host: e.host,
        port: String(e.port),
        weight: String(e.weight ?? 1),
        limit: e.max_connections == null ? '' : String(e.max_connections),
        backup: e.backup,
        enabled: e.enabled,
      })),
    ),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const shown = (rowId: string, field: keyof ExitErrors, errors: ExitErrors) =>
    tried || touched[`${rowId}:${field}`] ? (errors[field] ?? null) : null;
  const touch = (rowId: string, field: keyof ExitErrors) =>
    setTouched((t) => ({ ...t, [`${rowId}:${field}`]: true }));
  const [balancing, setBalancing] = useState<'weighted' | 'sticky'>(
    ws.balancing === 'sticky' ? 'sticky' : 'weighted',
  );
  const [health, setHealth] = useState<'fast' | 'standard' | 'tolerant'>(
    ws.health_check === 'fast' || ws.health_check === 'tolerant' ? ws.health_check : 'standard',
  );
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** После сохранения окно не закрывается: показывает итог проверки серверов точкой (витрина bs-dns-2026-10, A). */
  const [applied, setApplied] = useState<{
    id: string;
    before: BsWsExitInput[];
    after: BsWsExitInput[];
  } | null>(null);
  const [round, setRound] = useState(0);
  const [vstate, setVstate] = useState<VerifyState>({ done: false, failing: 0, expired: false });
  const [verifyError, setVerifyError] = useState<string | null>(null);
  /** Прежний список уже возвращали: второй «возврат» вернул бы тот самый список, что не отвечал, — его не предлагаем. */
  const [reverted, setReverted] = useState(false);
  const prepare = useMutation({
    mutationFn: () =>
      api.post(
        `/integrations/bschecker/ws/${ws.id}/changes`,
        { exits: exits.map(toExit), balancing, health_check: health },
        bsWsChangePreviewSchema,
      ),
    onSuccess: () => setConfirm(true),
  });
  /** Вернуть список, который был до этого изменения: ещё одно изменение, с той же проверкой после него. */
  const revert = useMutation({
    mutationFn: async () => {
      if (!applied) throw new Error('Нечего возвращать.');
      const back = await api.post(
        `/integrations/bschecker/ws/${ws.id}/changes`,
        {
          exits: applied.before,
          balancing: ws.balancing === 'sticky' ? 'sticky' : 'weighted',
          health_check:
            ws.health_check === 'fast' || ws.health_check === 'tolerant' ? ws.health_check : 'standard',
        },
        bsWsChangePreviewSchema,
      );
      const result = await api.post(
        `/integrations/bschecker/ws/changes/${back.id}/execute`,
        {},
        bsWsChangeResultSchema,
      );
      return { back, result };
    },
    onSuccess: ({ back, result }) => {
      void client.invalidateQueries({ queryKey: ['bschecker-ws'] });
      if (result.status === 'submitted') {
        setApplied({ id: back.id, before: back.before, after: back.after });
        setReverted(true);
        setVstate({ done: false, failing: 0, expired: false });
        setRound((r) => r + 1);
      } else setError('Итог возврата пока неизвестен — состояние серверов видно в карточке точки.');
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  const apply = useMutation({
    mutationFn: (id: string) =>
      api.post(`/integrations/bschecker/ws/changes/${id}/execute`, {}, bsWsChangeResultSchema),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['bschecker-ws'] }),
  });
  const uncertain = apply.data?.status === 'uncertain';
  const busy = prepare.isPending || apply.isPending || revert.isPending;
  const verifying = applied !== null;
  const locked = busy || uncertain || apply.data?.status === 'submitted';
  function update(i: number, patch: Partial<ExitDraft>) {
    setExits(exits.map((e, at) => (at === i ? { ...e, ...patch } : e)));
    prepare.reset();
    setError(null);
  }
  async function submit() {
    setError(null);
    setTried(true);
    // Неверное число не подменяем молча: показываем, что исправить, и не отправляем.
    if (exits.some((e) => Object.keys(exitErrors(e)).length)) {
      setError('Исправьте поля, отмеченные красным.');
      return;
    }
    try {
      await prepare.mutateAsync();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  async function execute() {
    if (!prepare.data) return;
    setConfirm(false);
    setError(null);
    try {
      const result = await apply.mutateAsync(prepare.data.id);
      // Изменение принято — окно переходит к проверке серверов точкой.
      if (result.status === 'submitted') {
        setApplied({ id: prepare.data.id, before: prepare.data.before, after: prepare.data.after });
        setVstate({ done: false, failing: 0, expired: false });
        setRound((r) => r + 1);
      }
    } catch (e) {
      setError(apiErrorMessage(e));
      prepare.reset();
    }
  }
  const list = (l: BsWsExitInput[]) =>
    l
      .map(
        (e) =>
          `${e.host}:${e.port} (${e.backup ? 'запасной' : `вес ${e.weight}`}${e.enabled ? '' : ', выключен'})`,
      )
      .join(', ') || 'нет';
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[860px]')}>
        <DialogHead
          title={`Серверы точки · ${ws.name}`}
          description={
            verifying
              ? 'Изменение отправлено точке — ниже итог проверки серверов.'
              : 'Список заменяется целиком: до 16 серверов, порт не 22 и не порт вашего VPN, нужен включённый основной.'
          }
        />
        {verifying && applied ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WsVerifyPanel
              ws={ws}
              nodes={nodes}
              after={applied.after}
              changeId={applied.id}
              round={round}
              fail={setVerifyError}
              onState={setVstate}
            />
            {(verifyError || error) && (
              <p
                role="alert"
                className="mx-6 mb-5 rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit max-sm:mx-4"
              >
                {error ?? verifyError}
              </p>
            )}
          </div>
        ) : (
          /* Прокручивается обёртка, а не fieldset: у fieldset прокрутка в Chromium не работает — на телефоне нижние
            поля уходили под кнопки. */
          <div className="min-h-0 flex-1 overflow-y-auto">
            <fieldset
              disabled={locked}
              className="m-0 flex min-w-0 flex-col gap-3.5 border-0 px-6 py-5 max-sm:px-4"
            >
              <div className="flex flex-wrap gap-4">
                <div>
                  <Kick>Распределение</Kick>
                  <Segmented<'weighted' | 'sticky'>
                    label="Распределение"
                    value={balancing}
                    onChange={(v) => {
                      setBalancing(v);
                      prepare.reset();
                    }}
                    items={[
                      { key: 'weighted', label: 'По весу' },
                      { key: 'sticky', label: 'Закреплять клиента' },
                    ]}
                  />
                </div>
                <div>
                  <Kick>Проверка серверов</Kick>
                  <Segmented<'fast' | 'standard' | 'tolerant'>
                    label="Проверка серверов"
                    value={health}
                    onChange={(v) => {
                      setHealth(v);
                      prepare.reset();
                    }}
                    items={[
                      { key: 'fast', label: 'Быстрая' },
                      { key: 'standard', label: 'Обычная' },
                      { key: 'tolerant', label: 'Терпеливая' },
                    ]}
                  />
                </div>
              </div>
              <p className="text-[12px] text-text-3">
                «Закреплять клиента» — клиент держится одного сервера, запасные тогда не используются.
                «Быстрая» проверка быстрее снимает упавший сервер, «Терпеливая» — реже ошибается на коротких
                перебоях.
              </p>
              <p className="text-[12px] text-text-3">
                <b className="font-medium text-text-2">Вес</b> — какую долю новых клиентов получает сервер при
                «По весу»: с весом 2 — вдвое больше, чем с весом 1; от 1 до 100.{' '}
                <b className="font-medium text-text-2">Лимит подключений</b> — сколько клиентов сервер держит
                одновременно; пусто — без лимита. <b className="font-medium text-text-2">Запасной</b> получает
                клиентов, только когда основные недоступны; вес ему не нужен.
              </p>
              {exits.map((e, i) => (
                <section
                  key={e.rowId}
                  aria-label={`Сервер ${i + 1}`}
                  className="flex flex-col gap-2.5 rounded-[12px] border border-border p-3.5"
                >
                  <div className="flex items-center gap-2">
                    <b className="flex-1 text-[13px] font-semibold">Сервер {i + 1}</b>
                    <Button
                      variant="outline"
                      className={small}
                      onClick={() => {
                        setExits(exits.filter((_, at) => at !== i));
                        prepare.reset();
                      }}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden="true" />
                      Убрать
                    </Button>
                  </div>
                  <NodePick
                    nodes={nodes}
                    host={e.host}
                    disabled={locked}
                    label={`Нода сервера ${i + 1}`}
                    onPick={(n) =>
                      update(
                        i,
                        n ? { host: n.address, port: n.port ? String(n.port) : e.port } : { host: '' },
                      )
                    }
                  />
                  {(() => {
                    const errors = exitErrors(e);
                    const hostError = shown(e.rowId, 'host', errors);
                    return (
                      <div className="grid grid-cols-[minmax(0,1fr)_112px_112px_160px] items-start gap-2.5 max-sm:grid-cols-2">
                        <div className="flex min-w-0 flex-col max-sm:col-span-2">
                          <label htmlFor={`ws-host-${e.rowId}`} className={fieldLabel}>
                            Адрес
                          </label>
                          <Input
                            id={`ws-host-${e.rowId}`}
                            aria-label={`Адрес сервера ${i + 1}`}
                            value={e.host}
                            aria-invalid={hostError ? true : undefined}
                            onChange={(ev) => update(i, { host: ev.target.value.trim() })}
                            onBlur={() => touch(e.rowId, 'host')}
                            className={cn('h-10 rounded-[10px] bg-surface-2', hostError && 'border-crit')}
                            placeholder="IP или домен"
                          />
                          {hostError && (
                            <p className="mt-1 text-[11.5px] leading-snug text-crit">{hostError}</p>
                          )}
                        </div>
                        <NumField
                          id={`ws-port-${e.rowId}`}
                          label="Порт"
                          ariaLabel={`Порт сервера ${i + 1}`}
                          maxLength={5}
                          value={e.port}
                          error={shown(e.rowId, 'port', errors)}
                          onChange={(port) => update(i, { port })}
                          onBlur={() => touch(e.rowId, 'port')}
                        />
                        <NumField
                          id={`ws-weight-${e.rowId}`}
                          label="Вес"
                          ariaLabel={`Вес сервера ${i + 1}`}
                          maxLength={3}
                          disabled={e.backup || locked}
                          value={e.backup ? '' : e.weight}
                          placeholder={e.backup ? 'не нужен' : undefined}
                          error={shown(e.rowId, 'weight', errors)}
                          onChange={(weight) => update(i, { weight })}
                          onBlur={() => touch(e.rowId, 'weight')}
                        />
                        <NumField
                          id={`ws-limit-${e.rowId}`}
                          label="Лимит подключений"
                          ariaLabel={`Лимит подключений сервера ${i + 1}`}
                          maxLength={6}
                          placeholder="без лимита"
                          value={e.limit}
                          error={shown(e.rowId, 'limit', errors)}
                          onChange={(limit) => update(i, { limit })}
                          onBlur={() => touch(e.rowId, 'limit')}
                        />
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap gap-5 text-[12.5px]">
                    <label htmlFor={`ws-backup-${e.rowId}`} className="flex items-center gap-2">
                      <Toggle
                        id={`ws-backup-${e.rowId}`}
                        checked={e.backup}
                        disabled={locked}
                        onChange={(v) => update(i, { backup: v })}
                      />
                      Запасной
                    </label>
                    <label htmlFor={`ws-enabled-${e.rowId}`} className="flex items-center gap-2">
                      <Toggle
                        id={`ws-enabled-${e.rowId}`}
                        checked={e.enabled}
                        disabled={locked}
                        onChange={(v) => update(i, { enabled: v })}
                      />
                      Включён
                    </label>
                  </div>
                </section>
              ))}
              <Button
                variant="outline"
                className={cn(small, 'self-start')}
                disabled={exits.length >= 16 || locked}
                onClick={() => {
                  setExits([
                    ...exits,
                    ...withId([
                      { host: '', port: '443', weight: '1', limit: '', backup: false, enabled: true },
                    ]),
                  ]);
                  prepare.reset();
                }}
              >
                <PlusIcon className="size-3.5" aria-hidden="true" />
                Добавить сервер
              </Button>
              {error && (
                <p
                  role="alert"
                  className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
                >
                  {error}
                </p>
              )}
              {apply.data && (
                <div
                  role="status"
                  className="rounded-[12px] border border-border bg-surface-2/60 px-3.5 py-3 text-[12.5px]"
                >
                  <b className="font-semibold">
                    {uncertain ? 'Итог изменения пока неизвестен' : 'Серверы сохранены'}
                  </b>
                  <p className="mt-0.5 text-text-3">
                    {uncertain
                      ? 'Повтор использует тот же ключ изменения — второго изменения не будет.'
                      : apply.data.applied
                        ? 'Изменение уже применено на точке.'
                        : 'Точка применит изменение за несколько секунд — состояние видно в карточке.'}
                  </p>
                  {apply.data.warnings.map((w) => (
                    <p key={w} className="mt-1 text-warn">
                      {w}
                    </p>
                  ))}
                </div>
              )}
            </fieldset>
          </div>
        )}
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            {!verifying
              ? 'Изменение записывается в «Журнал». Не больше 48 изменений в сутки на точку.'
              : vstate.done && vstate.failing > 0
                ? `Откройте порт и проверьте снова — это бесплатно.${reverted ? '' : ' Возврат прежнего списка — ещё одно изменение из 48 в сутки.'}`
                : vstate.done
                  ? 'Состояние серверов видно и в карточке точки.'
                  : 'Окно можно закрыть — итог появится и в карточке точки.'}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            {verifying && (vstate.expired || (vstate.done && vstate.failing > 0)) && (
              <DialogSecondaryButton
                disabled={busy}
                onClick={() => {
                  setVstate({ done: false, failing: 0, expired: false });
                  setRound((r) => r + 1);
                }}
                className={cn(footButton, 'w-auto px-4')}
              >
                Проверить снова
              </DialogSecondaryButton>
            )}
            {verifying && vstate.done && vstate.failing > 0 && !reverted && (
              <DialogSecondaryButton
                disabled={busy}
                onClick={() => revert.mutate()}
                className={cn(footButton, 'w-auto px-4')}
              >
                {revert.isPending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                Вернуть прежний список
              </DialogSecondaryButton>
            )}
            {verifying && vstate.done ? (
              <DialogPrimaryButton
                disabled={busy}
                onClick={onClose}
                className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
              >
                Готово
              </DialogPrimaryButton>
            ) : (
              <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
                Закрыть
              </DialogSecondaryButton>
            )}
            {!verifying && apply.data?.status !== 'submitted' && (
              <DialogPrimaryButton
                disabled={busy || !exits.length}
                onClick={() => (uncertain && prepare.data ? void execute() : void submit())}
                className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
              >
                {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                {uncertain ? 'Получить итог изменения' : 'Сохранить и проверить'}
              </DialogPrimaryButton>
            )}
          </div>
        </div>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Заменить серверы точки?"
          description={`Сейчас: ${prepare.data ? list(prepare.data.before) : '—'}. Станет: ${prepare.data ? list(prepare.data.after) : '—'}. Новые подключения пойдут на новый список. После сохранения точка сама проверит серверы.`}
          yesLabel="Заменить серверы"
          onConfirm={() => void execute()}
          loading={apply.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Выход точки TCP/UDP, пока его правят: порт и вес — строками. */
type TargetDraft = Omit<BsRentalTarget, 'port' | 'weight'> & { port: string; weight: string };
type TargetErrors = Partial<Record<'host' | 'port' | 'weight', string>>;
function targetErrors(t: TargetDraft): TargetErrors {
  const out: TargetErrors = {};
  if (t.host.trim().length < 3) out.host = 'Укажите IP или домен выхода';
  if (!inRange(t.port, 1, 65_535)) out.port = 'Порт — от 1 до 65 535';
  if (!t.backup && !inRange(t.weight, 1, 256)) out.weight = 'Вес — от 1 до 256';
  return out;
}
/** Выход для сервиса: у резервного вес не нужен — прежний, если он верный, иначе 1. */
function toTarget({ rowId, port, weight, ...t }: Row<TargetDraft>): BsRentalTarget {
  return { ...t, port: Number(port), weight: inRange(weight, 1, 256) ? Number(weight) : 1 };
}

/** Выходные адреса точки TCP/UDP: целиком, с подтверждением; отказ сервиса снова открывает правку. */
function RentalEditor({
  rental,
  nodes,
  onClose,
}: {
  rental: BsRental;
  nodes: RemnawaveNode[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  // Числа — строками, пока их правят: поле можно очистить и набрать заново; проверка — при уходе и сохранении.
  const [targets, setTargets] = useState<Array<Row<TargetDraft>>>(
    withId(rental.targets.map((t) => ({ ...t, port: String(t.port), weight: String(t.weight) }))),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const shown = (rowId: string, field: keyof TargetErrors, errors: TargetErrors) =>
    tried || touched[`${rowId}:${field}`] ? (errors[field] ?? null) : null;
  const touch = (rowId: string, field: keyof TargetErrors) =>
    setTouched((t) => ({ ...t, [`${rowId}:${field}`]: true }));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepare = useMutation({
    mutationFn: () =>
      api.post(
        `/integrations/bschecker/rentals/${rental.id}/changes`,
        { targets: targets.map(toTarget) },
        bsRentalChangePreviewSchema,
      ),
    onSuccess: () => setConfirm(true),
  });
  const apply = useMutation({
    mutationFn: (id: string) =>
      api.post(`/integrations/bschecker/rentals/changes/${id}/execute`, {}, bsRentalChangeResultSchema),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['bschecker-rentals'] }),
  });
  const uncertain = apply.data?.status === 'uncertain';
  const busy = prepare.isPending || apply.isPending;
  const locked = busy || uncertain || apply.data?.status === 'submitted';
  const tcp = rental.proto === 'tcp';
  function update(i: number, patch: Partial<TargetDraft>) {
    setTargets(targets.map((t, at) => (at === i ? { ...t, ...patch } : t)));
    prepare.reset();
    setError(null);
  }
  async function submit() {
    setError(null);
    setTried(true);
    if (targets.some((t) => Object.keys(targetErrors(t)).length)) {
      setError('Исправьте поля, отмеченные красным.');
      return;
    }
    try {
      await prepare.mutateAsync();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  async function execute() {
    if (!prepare.data) return;
    setConfirm(false);
    setError(null);
    try {
      await apply.mutateAsync(prepare.data.id);
    } catch (e) {
      setError(apiErrorMessage(e));
      prepare.reset();
    }
  }
  const list = (l: BsRentalTarget[]) =>
    l.map((t) => `${t.host}:${t.port} (${t.backup ? 'резерв' : `вес ${t.weight}`})`).join(', ');
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[800px]')}>
        <DialogHead
          title={`Выходные адреса · ${rental.label || rental.endpoint}`}
          description={`Вход ${rental.endpoint} → ваши ноды. Список заменяется целиком: ${tcp ? 'до 3 основных и 2 резервных' : '1 основной и 1 резервный'}.`}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <fieldset
            disabled={locked}
            className="m-0 flex min-w-0 flex-col gap-3 border-0 px-6 py-5 max-sm:px-4"
          >
            <p className="text-[12px] text-text-3">
              <b className="font-medium text-text-2">Вес</b> — какую долю подключений получает выход: с весом
              2 — вдвое больше, чем с весом 1; от 1 до 256.{' '}
              <b className="font-medium text-text-2">Резервный</b> получает подключения, только когда основные
              недоступны; вес ему не нужен.
            </p>
            {targets.map((t, i) => (
              <section
                key={t.rowId}
                aria-label={`Выход ${i + 1}`}
                className="flex flex-col gap-2.5 rounded-[12px] border border-border p-3.5"
              >
                <div className="flex items-center gap-2">
                  <b className="flex-1 text-[13px] font-semibold">Выход {i + 1}</b>
                  <Button
                    variant="outline"
                    className={small}
                    onClick={() => {
                      setTargets(targets.filter((_, at) => at !== i));
                      prepare.reset();
                    }}
                  >
                    <Trash2Icon className="size-3.5" aria-hidden="true" />
                    Убрать
                  </Button>
                </div>
                <NodePick
                  nodes={nodes}
                  host={t.host}
                  disabled={locked}
                  label={`Нода выхода ${i + 1}`}
                  onPick={(n) =>
                    update(i, n ? { host: n.address, port: String(n.port ?? 443) } : { host: '' })
                  }
                />
                {(() => {
                  const errors = targetErrors(t);
                  const hostError = shown(t.rowId, 'host', errors);
                  return (
                    <div className="grid grid-cols-[minmax(0,1fr)_112px_112px] items-start gap-2.5 max-sm:grid-cols-2">
                      <div className="flex min-w-0 flex-col max-sm:col-span-2">
                        <label htmlFor={`rental-host-${t.rowId}`} className={fieldLabel}>
                          Адрес
                        </label>
                        <Input
                          id={`rental-host-${t.rowId}`}
                          aria-label={`Адрес выхода ${i + 1}`}
                          value={t.host}
                          aria-invalid={hostError ? true : undefined}
                          onChange={(e) => update(i, { host: e.target.value.trim() })}
                          onBlur={() => touch(t.rowId, 'host')}
                          className={cn('h-10 rounded-[10px] bg-surface-2', hostError && 'border-crit')}
                          placeholder="IP или домен"
                        />
                        {hostError && (
                          <p className="mt-1 text-[11.5px] leading-snug text-crit">{hostError}</p>
                        )}
                      </div>
                      <NumField
                        id={`rental-port-${t.rowId}`}
                        label="Порт"
                        ariaLabel={`Порт выхода ${i + 1}`}
                        maxLength={5}
                        value={t.port}
                        error={shown(t.rowId, 'port', errors)}
                        onChange={(port) => update(i, { port })}
                        onBlur={() => touch(t.rowId, 'port')}
                      />
                      <NumField
                        id={`rental-weight-${t.rowId}`}
                        label="Вес"
                        ariaLabel={`Вес выхода ${i + 1}`}
                        maxLength={3}
                        disabled={t.backup || locked}
                        value={t.backup ? '' : t.weight}
                        placeholder={t.backup ? 'не нужен' : undefined}
                        error={shown(t.rowId, 'weight', errors)}
                        onChange={(weight) => update(i, { weight })}
                        onBlur={() => touch(t.rowId, 'weight')}
                      />
                    </div>
                  );
                })()}
                <label htmlFor={`rental-backup-${t.rowId}`} className="flex items-center gap-2 text-[12.5px]">
                  <Toggle
                    id={`rental-backup-${t.rowId}`}
                    checked={t.backup}
                    disabled={locked}
                    onChange={(v) => update(i, { backup: v })}
                  />
                  Резервный выход
                </label>
              </section>
            ))}
            <Button
              variant="outline"
              className={cn(small, 'self-start')}
              disabled={targets.length >= (tcp ? 5 : 2) || locked}
              onClick={() => {
                setTargets([...targets, ...withId([{ host: '', port: '443', weight: '1', backup: false }])]);
                prepare.reset();
              }}
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Добавить выход
            </Button>
            {error && (
              <p
                role="alert"
                className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
              >
                {error}
              </p>
            )}
            {apply.data && (
              <div
                role="status"
                className="rounded-[12px] border border-border bg-surface-2/60 px-3.5 py-3 text-[12.5px]"
              >
                <b className="font-semibold">
                  {uncertain ? 'Итог изменения пока неизвестен' : 'Адреса сохранены'}
                </b>
                <p className="mt-0.5 text-text-3">
                  {uncertain
                    ? 'Повтор использует тот же ключ изменения — второго изменения не будет.'
                    : 'Сервер точки применит их за 10–20 секунд — состояние видно в карточке.'}
                </p>
                {apply.data.warnings.map((w) => (
                  <p key={w} className="mt-1 text-warn">
                    {w}
                  </p>
                ))}
              </div>
            )}
          </fieldset>
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Изменение записывается в «Журнал».
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              Закрыть
            </DialogSecondaryButton>
            {apply.data?.status !== 'submitted' && (
              <DialogPrimaryButton
                disabled={busy || !targets.length}
                onClick={() => (uncertain && prepare.data ? void execute() : void submit())}
                className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
              >
                {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                {uncertain ? 'Получить итог изменения' : 'Сохранить адреса'}
              </DialogPrimaryButton>
            )}
          </div>
        </div>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Заменить выходные адреса точки?"
          description={`Сейчас: ${prepare.data ? list(prepare.data.before) : '—'}. Станет: ${prepare.data ? list(prepare.data.after) : '—'}. Входящие подключения пойдут на новый список.`}
          yesLabel="Заменить адреса"
          onConfirm={() => void execute()}
          loading={apply.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}

/** «Проверить с точки»: доступны ли сохранённые выходы с сервера точки; ждём до 25 с, потом опрашиваем. */
function RentalCheckDialog({ rental, onClose }: { rental: BsRental; onClose: () => void }) {
  const check = useQuery({
    queryKey: ['bschecker-rental-check', rental.id],
    queryFn: () => api.post(`/integrations/bschecker/rentals/${rental.id}/check`, {}, bsRentalCheckSchema),
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const follow = useQuery({
    queryKey: ['bschecker-rental-check-result', rental.id, check.data?.id],
    enabled: Boolean(check.data && ['pending', 'running'].includes(check.data.status)),
    queryFn: ({ signal }) =>
      api.get(
        `/integrations/bschecker/rentals/${rental.id}/check/${check.data?.id}`,
        bsRentalCheckSchema,
        signal,
      ),
    refetchInterval: (q) => (q.state.data && ['done', 'error'].includes(q.state.data.status) ? false : 3000),
  });
  const result = follow.data ?? check.data;
  const running = !result || ['pending', 'running'].includes(result.status);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[660px]')}>
        <DialogHead
          title={`Проверка с точки · ${rental.label || rental.endpoint}`}
          description="Доступны ли сохранённые выходные адреса с сервера арендованной точки."
        />
        <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-6 py-5 max-sm:px-4">
          {(check.isError || follow.isError) && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {apiErrorMessage(check.error ?? follow.error)}
            </p>
          )}
          {running && !check.isError && (
            <p role="status" className="flex items-center gap-2 text-[13px] text-text-2">
              <Loader2Icon className="size-4 animate-spin text-brand" aria-hidden="true" />
              Проверяю с сервера точки — до полуминуты.
            </p>
          )}
          {result?.results.map((row) => (
            <div
              key={`${row.role}-${row.ip}-${row.port}-${row.backup}`}
              className="flex items-center justify-between gap-3 rounded-[12px] border border-border px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="font-mono text-[13px]">
                  {row.ip}:{row.port}
                </p>
                <p className="mt-0.5 text-[12px] text-text-3">
                  {row.backup ? 'Резервный выход' : 'Основной выход'}
                  {row.rtt_ms != null ? ` · ${row.rtt_ms} мс` : ''}
                  {row.err ? ` · ${explainProbeError(row.err)}` : ''}
                </p>
              </div>
              <Pill tone={row.ok === null ? 'muted' : row.ok ? 'ok' : 'crit'}>
                {row.ok === null ? 'нет результата' : row.ok ? 'доступен' : 'не отвечает'}
              </Pill>
            </div>
          ))}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Проверять можно раз в 20 секунд.
          </p>
          <DialogSecondaryButton onClick={onClose} className={footButton}>
            Закрыть
          </DialogSecondaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const historyFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const HISTORY_DOT: Record<string, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  acc: 'bg-brand',
  muted: 'bg-text-3',
};

/**
 * История точки. Журнала от самого сервиса у BS Checker нет, поэтому историю собирает панель из «Журнала»: изменения
 * серверов и адресов, итоги проверки точкой, просмотр настроек подключения. Падения серверов и продления сюда не
 * попадают — сервис о них не присылает.
 */
function PointHistoryDialog({
  kind,
  id,
  name,
  onClose,
}: {
  kind: 'ws' | 'rentals';
  id: string;
  name: string;
  onClose: () => void;
}) {
  const history = useQuery({
    queryKey: ['bschecker-point-history', kind, id],
    queryFn: ({ signal }) =>
      api.get(`/integrations/bschecker/${kind}/${id}/history`, bsPointHistorySchema, signal),
  });
  const items = history.data?.items ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[640px]')}>
        <DialogHead
          title={`История точки · ${name}`}
          description="Изменения и проверки, сделанные через панель, — новые сверху."
        />
        <div className="min-h-[220px] flex-1 overflow-y-auto px-6 py-3 max-sm:px-4">
          {history.isPending && (
            <div role="status" aria-label="Загрузка истории точки" className="flex flex-col gap-3 py-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-[10px]" />
              ))}
            </div>
          )}
          {history.isError && (
            <p
              role="alert"
              className="my-2 rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {apiErrorMessage(history.error)}
            </p>
          )}
          {history.isSuccess && items.length === 0 && (
            <div className="flex items-start gap-3 py-5">
              <FileClockIcon className="mt-0.5 size-5 flex-none text-brand" aria-hidden="true" />
              <div>
                <p className="text-[13px] font-medium">Пока ничего не записано</p>
                <p className="mt-1 text-[12px] text-text-3">
                  История ведётся с версии 0.102.0: сюда попадают изменения серверов и адресов, итоги проверки
                  точкой и просмотр настроек подключения. Более ранние изменения остались в общем «Журнале»
                  без привязки к точке.
                </p>
              </div>
            </div>
          )}
          {items.length > 0 && (
            <ol aria-label="События точки" className="flex flex-col">
              {items.map((item, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: события не имеют своего идентификатора
                  key={`${item.at}-${i}`}
                  className="grid grid-cols-[118px_10px_minmax(0,1fr)] items-start gap-2.5 border-t border-border py-2.5 text-[13px] first:border-t-0 max-sm:grid-cols-[10px_minmax(0,1fr)]"
                >
                  <time
                    dateTime={item.at}
                    className="text-[12px] text-text-3 tabular-nums max-sm:order-3 max-sm:col-start-2"
                  >
                    {historyFmt.format(new Date(item.at))}
                  </time>
                  <span
                    className={cn(
                      'mt-[5px] size-2 rounded-full max-sm:order-1',
                      HISTORY_DOT[item.tone] ?? 'bg-text-3',
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 max-sm:order-2">
                    <b className="font-semibold">{item.title}</b>
                    <small className="mt-0.5 block text-[12px] text-text-3">
                      {item.detail ? `${item.detail} · ${item.by}` : item.by}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Хранится 90 дней. Падения серверов и продления BS Checker не присылает — их здесь нет.
          </p>
          <DialogSecondaryButton onClick={onClose} className={footButton}>
            Закрыть
          </DialogSecondaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** «Арендованные точки входа»: WebSocket (/v1/ws) и TCP/UDP (/v1/rentals) — только точки вашего аккаунта. */
export function BsRentals() {
  const nodes = useNodes().data?.nodes ?? [];
  const rentals = useQuery({
    queryKey: ['bschecker-rentals'],
    queryFn: ({ signal }) => api.get('/integrations/bschecker/rentals', bsRentalsSchema, signal),
    refetchInterval: (q) => (q.state.data?.rentals.some((r) => !r.config.in_sync) ? 15000 : false),
  });
  const ws = useQuery({
    queryKey: ['bschecker-ws'],
    queryFn: ({ signal }) => api.get('/integrations/bschecker/ws', bsWsListSchema, signal),
    refetchInterval: (q) => (q.state.data?.ws.some((w) => w.applied === false) ? 10000 : false),
  });
  const [editWs, setEditWs] = useState<BsWs | null>(null);
  const [connect, setConnect] = useState<BsWs | null>(null);
  const [editRental, setEditRental] = useState<BsRental | null>(null);
  const [checkRental, setCheckRental] = useState<BsRental | null>(null);
  const [historyFor, setHistoryFor] = useState<{ kind: 'ws' | 'rentals'; id: string; name: string } | null>(
    null,
  );
  const count = (ws.data?.ws.length ?? 0) + (rentals.data?.rentals.length ?? 0);
  const unreadable = (ws.data?.unreadable ?? 0) + (rentals.data?.unreadable ?? 0);
  const loading = ws.isPending || rentals.isPending;
  const empty = !loading && !ws.isError && !rentals.isError && count === 0;
  return (
    <section
      aria-label="Арендованные точки входа"
      className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <header className="flex min-h-14 flex-none items-center gap-3 border-b border-border px-[18px] py-2.5">
        <h2 className="font-heading text-[14.5px] font-semibold">Арендованные точки входа</h2>
        {!loading && <Pill>{count}</Pill>}
        <span className="flex-1" />
        <Button
          variant="outline"
          aria-label="Обновить точки"
          className="size-9 rounded-[10px] p-0"
          disabled={ws.isFetching || rentals.isFetching}
          onClick={() => {
            void ws.refetch();
            void rentals.refetch();
          }}
        >
          <RefreshCwIcon
            className={cn('size-4', (ws.isFetching || rentals.isFetching) && 'animate-spin')}
            aria-hidden="true"
          />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] py-3.5">
        {loading && (
          <div role="status" aria-label="Загрузка арендованных точек" className="flex flex-col gap-2.5">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-44 w-full rounded-[14px]" />
            ))}
          </div>
        )}
        {[ws, rentals].map((q, i) =>
          q.isError ? (
            <p
              key={i === 0 ? 'ws' : 'rentals'}
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {i === 0 ? 'Точки WebSocket: ' : 'Точки TCP/UDP: '}
              {apiErrorMessage(q.error)}
            </p>
          ) : null,
        )}
        {ws.data?.ws.map((w) => (
          <WsCard
            key={w.id}
            ws={w}
            nodes={nodes}
            onEdit={() => setEditWs(w)}
            onConnect={() => setConnect(w)}
            onHistory={() => setHistoryFor({ kind: 'ws', id: w.id, name: w.name })}
          />
        ))}
        {rentals.data?.rentals.map((r) => (
          <RentalCard
            key={r.id}
            rental={r}
            nodes={nodes}
            checking={checkRental?.id === r.id}
            onCheck={() => setCheckRental(r)}
            onEdit={() => setEditRental(r)}
            onHistory={() => setHistoryFor({ kind: 'rentals', id: r.id, name: r.endpoint })}
          />
        ))}
        {unreadable > 0 && (
          <p className="text-[12px] text-warn">
            Ещё {unreadable} {plural(unreadable, 'точку', 'точки', 'точек')} BS Checker прислал в непонятном
            виде — она не показана.
          </p>
        )}
        {empty && (
          <div className="flex items-start gap-3 py-4">
            <NetworkIcon className="mt-0.5 size-5 flex-none text-brand" aria-hidden="true" />
            <div>
              <p className="text-[13px] font-medium">В аккаунте нет арендованных точек</p>
              <p className="mt-1 text-[12px] text-text-3">
                Ни точек WebSocket, ни TCP/UDP. После аренды в BS Checker здесь появятся вход, срок, трафик и
                выходы на ваши ноды.
              </p>
            </div>
          </div>
        )}
      </div>
      {editWs && <WsExitsEditor ws={editWs} nodes={nodes} onClose={() => setEditWs(null)} />}
      {connect && <WsConnectDialog ws={connect} onClose={() => setConnect(null)} />}
      {editRental && <RentalEditor rental={editRental} nodes={nodes} onClose={() => setEditRental(null)} />}
      {checkRental && <RentalCheckDialog rental={checkRental} onClose={() => setCheckRental(null)} />}
      {historyFor && (
        <PointHistoryDialog
          kind={historyFor.kind}
          id={historyFor.id}
          name={historyFor.name}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </section>
  );
}

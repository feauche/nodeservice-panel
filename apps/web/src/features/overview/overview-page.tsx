import {
  AUDIT_SOURCE_LABELS,
  type AuditCategory,
  auditActionLabel,
  INCIDENT_KIND_META,
  type OverviewServerMetrics,
  type Server,
} from '@nodeservice/shared';
import { Link, type LinkProps } from '@tanstack/react-router';
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  CogIcon,
  KeyRoundIcon,
  ServerIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuditList } from '@/features/audit/audit-api';
import { formatWhen } from '@/features/audit/audit-format';
import { ResultPill } from '@/features/audit/audit-row';
import { useIncidents } from '@/features/incidents/incidents-api';
import {
  CPU_WARN_PCT,
  MEM_WARN_PCT,
  type ServerHealth,
  serverHealth,
} from '@/features/servers/server-health';
import { useServers } from '@/features/servers/servers-api';
import { apiErrorMessage } from '@/lib/api';
import { isSectionOpen } from '@/lib/stages';
import { cn } from '@/lib/utils';
import { useOverviewMetrics } from './overview-api';
import { avg, formatPct, formatTraffic, sum } from './overview-format';
import { AreaSpark, Sparkline } from './primitives';

/**
 * Состояние сервера — тот же классификатор, что на «Серверах» (server-health.ts): Обзор и карточки
 * не должны спорить друг с другом. Здесь добавляется только причина словами.
 */
type Health = ServerHealth;

function healthOf(s: Server, m: OverviewServerMetrics | undefined): { health: Health; reason: string } {
  const health = serverHealth(s, m ?? null);
  if (health === 'crit') {
    return { health, reason: s.sshOk === false ? 'SSH недоступен' : 'Агент пропал со связи' };
  }
  if (health === 'warn') {
    if (s.agentStatus === 'not_installed') return { health, reason: 'Агент не установлен' };
    if (s.agentStatus === 'installing') return { health, reason: 'Агент устанавливается' };
    if (s.agentStatus === 'pending') return { health, reason: 'Ожидает агента' };
    if (s.sshOk === null) return { health, reason: 'SSH ещё не проверялся' };
    if ((m?.cpuPct ?? 0) >= CPU_WARN_PCT) return { health, reason: `CPU ${Math.round(m?.cpuPct ?? 0)}%` };
    if ((m?.memPct ?? 0) >= MEM_WARN_PCT) return { health, reason: `Память ${Math.round(m?.memPct ?? 0)}%` };
    return { health, reason: `Диск ${Math.round(m?.diskPct ?? 0)}%` };
  }
  return { health, reason: '' };
}

const HEALTH_DOT: Record<Health | 'muted', string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  muted: 'bg-text-3',
};

const CATEGORY_ICON: Partial<Record<AuditCategory, typeof CogIcon>> = {
  auth: KeyRoundIcon,
  security: KeyRoundIcon,
  server: ServerIcon,
  settings: SlidersHorizontalIcon,
  system: CogIcon,
};

function Caps({ children }: { children: string }) {
  return <div className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">{children}</div>;
}

/** KPI-плитка из демо: капс-заголовок, крупное число, статус слева и спарклайн справа-снизу. */
function Kpi({
  caps,
  value,
  unit,
  status,
  tone = 'ok',
  spark,
}: {
  caps: string;
  value: string;
  unit?: string;
  status: string;
  tone?: Health | 'muted';
  spark: Array<number | null>;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-border bg-surface p-4">
      <Caps>{caps}</Caps>
      <div
        className={cn(
          'font-heading leading-none font-bold tracking-[-0.02em] whitespace-nowrap tabular-nums',
          value.length > 9 ? 'text-[24px]' : 'text-[30px]',
        )}
      >
        {value}
        {unit && <span className="ml-1.5 text-[13px] font-medium text-text-3">{unit}</span>}
      </div>
      <div className="mt-auto flex items-end justify-between gap-2 pt-1">
        <span className="flex items-center gap-1.5 text-[12px] text-text-2">
          <span className={cn('size-1.5 rounded-full', HEALTH_DOT[tone])} aria-hidden="true" />
          {status}
        </span>
        <Sparkline values={spark} className="h-9 w-28 flex-none opacity-80" />
      </div>
    </div>
  );
}

function Panel({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-border bg-surface', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="font-heading text-[14.5px] font-bold">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Баннер инцидентов: ссылка в раздел, пока он закрыт — просто заметная строка без ссылки. */
function IncidentsBanner({ open, crit }: { open: number; crit: number }) {
  const cls =
    'flex items-center gap-3 rounded-[12px] border border-crit/30 bg-crit-soft/60 px-4 py-3 transition-colors';
  const body = (
    <>
      <AlertTriangleIcon className="size-5 flex-none text-crit" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-[13px]">
        <b className="font-semibold text-crit">{open}</b> активных {open === 1 ? 'инцидент' : 'инцидентов'}
        {crit > 0 && <span className="text-text-2"> · {crit} критично</span>}
      </span>
    </>
  );
  if (!isSectionOpen('/incidents')) return <div className={cls}>{body}</div>;
  return (
    <Link to="/incidents" className={cn(cls, 'hover:bg-crit-soft')}>
      {body}
      <span className="flex-none text-[12.5px] font-medium text-crit">Открыть →</span>
    </Link>
  );
}

/** «Обзор» — по демо: полоса здоровья, KPI, «Требует внимания» + «Трафик парка», события, нижняя полоса. */
export function OverviewPage() {
  const servers = useServers();
  const metrics = useOverviewMetrics();
  const events = useAuditList({ page: 1, pageSize: 6 });
  const openIncidents = useIncidents('open');

  if (servers.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-full rounded-full" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[118px] rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-[240px] rounded-2xl" />
      </div>
    );
  if (servers.isError)
    return (
      <p className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
        {apiErrorMessage(servers.error)}{' '}
        <button type="button" className="cursor-pointer underline" onClick={() => void servers.refetch()}>
          Повторить
        </button>
      </p>
    );

  const items = servers.data?.items ?? [];
  const byId = new Map((metrics.data?.servers ?? []).map((m) => [m.serverId, m]));
  const fleet = metrics.data?.fleet;
  const judged = items.map((s) => ({ server: s, ...healthOf(s, byId.get(s.id)) }));
  const okCount = judged.filter((j) => j.health === 'ok').length;
  const warnCount = judged.filter((j) => j.health === 'warn').length;
  const offlineCount = judged.filter((j) => j.health === 'crit').length;
  const healthPct = items.length ? Math.round((okCount / items.length) * 100) : 100;
  // «Требует внимания» = проблемы по здоровью серверов + открытые инциденты (например, «Xray не
  // запущен» — сервер по метрикам в норме, но нода не работает).
  const healthRows = judged
    .filter((j) => j.health !== 'ok')
    .map((j) => ({
      key: `h:${j.server.id}`,
      name: j.server.name,
      reason: j.reason,
      tone: j.health as 'warn' | 'crit',
      pill: j.health === 'crit' ? 'офлайн' : 'внимание',
      link: { to: '/servers', search: { open: j.server.id } } as LinkProps,
    }));
  const incidentRows = (openIncidents.data?.items ?? [])
    // Связь (агент/SSH) уже отражена строкой здоровья — не дублируем.
    .filter(
      (inc) =>
        !(
          (inc.kind === 'agent_offline' || inc.kind === 'ssh_down') &&
          healthRows.some((h) => h.name === inc.serverName)
        ),
    )
    .map((inc) => ({
      key: `i:${inc.id}`,
      name: inc.serverName,
      reason: `${INCIDENT_KIND_META[inc.kind].label}${inc.proposal ? ' · ждёт подтверждения' : ''}`,
      tone: (inc.severity === 'crit' ? 'crit' : 'warn') as 'warn' | 'crit',
      pill: 'инцидент',
      link: { to: '/incidents/$id', params: { id: inc.id } } as LinkProps,
    }));
  const attention = [...incidentRows, ...healthRows];

  const noMetricsAtAll = items.length > 0 && items.every((s) => (byId.get(s.id)?.cpuPct ?? null) === null);
  const cpuAvg = avg(items.map((s) => byId.get(s.id)?.cpuPct ?? null));
  const memAvg = avg(items.map((s) => byId.get(s.id)?.memPct ?? null));
  const rxNow = sum(items.map((s) => byId.get(s.id)?.netRxBps ?? null));
  const txNow = sum(items.map((s) => byId.get(s.id)?.netTxBps ?? null));
  const trafficNow = rxNow === null && txNow === null ? null : (rxNow ?? 0) + (txNow ?? 0);
  const rx = formatTraffic(rxNow);
  const tx = formatTraffic(txNow);
  const conntrackNow = fleet?.conntrackSpark.filter((v): v is number => v !== null).at(-1) ?? null;

  const incCounts = openIncidents.data?.counts;
  return (
    <div className="flex flex-col gap-4">
      {incCounts && incCounts.open > 0 && <IncidentsBanner open={incCounts.open} crit={incCounts.crit} />}
      {metrics.data?.vmOk === false && (
        <p className="rounded-[10px] border border-warn/30 bg-warn-soft/50 px-3.5 py-2 text-[12.5px] text-text-2">
          Хранилище метрик недоступно — показываю без графиков.
        </p>
      )}

      {/* Полоса здоровья парка (демо: health bar + легенда) */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex h-[7px] min-w-[220px] flex-1 overflow-hidden rounded-full bg-surface-3">
            {okCount > 0 && <div className="bg-ok" style={{ width: `${(okCount / items.length) * 100}%` }} />}
            {warnCount > 0 && (
              <div className="bg-warn" style={{ width: `${(warnCount / items.length) * 100}%` }} />
            )}
            {offlineCount > 0 && (
              <div className="bg-crit" style={{ width: `${(offlineCount / items.length) * 100}%` }} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-text-2">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="size-1.5 rounded-full bg-ok" /> {okCount} в норме
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="size-1.5 rounded-full bg-warn" /> {warnCount} внимание
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="size-1.5 rounded-full bg-crit" /> {offlineCount} офлайн
            </span>
            <span className="whitespace-nowrap text-text-3">
              здоровье парка <b className="text-foreground tabular-nums">{healthPct}%</b>
            </span>
          </div>
        </div>
      )}

      {noMetricsAtAll && (
        <p className="text-[12.5px] text-text-3">Метрики появятся, когда агент выйдет на связь.</p>
      )}

      {/* KPI-плитки */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          caps="Серверов в норме"
          value={`${okCount}`}
          unit={`/ ${items.length}`}
          status={offlineCount > 0 ? 'есть офлайн' : 'стабильно'}
          tone={offlineCount > 0 ? 'crit' : 'ok'}
          spark={fleet?.cpuAvgSpark ?? []}
        />
        <Kpi
          caps="Средний CPU"
          value={cpuAvg === null ? '—' : formatPct(cpuAvg)}
          unit={cpuAvg === null ? undefined : '%'}
          status={cpuAvg === null ? 'ждёт агента' : cpuAvg > 85 ? 'высокая нагрузка' : 'в норме'}
          tone={cpuAvg === null ? 'muted' : cpuAvg > 85 ? 'warn' : 'ok'}
          spark={fleet?.cpuAvgSpark ?? []}
        />
        <Kpi
          caps="Трафик сейчас"
          value={trafficNow === null ? '—' : `↓ ${rx.value} · ↑ ${tx.value}`}
          unit={trafficNow === null ? undefined : rx.unit === tx.unit ? rx.unit : `${rx.unit} / ${tx.unit}`}
          status={trafficNow === null ? 'ждёт агента' : 'приём · отдача'}
          tone={trafficNow === null ? 'muted' : 'ok'}
          spark={fleet?.trafficRxSpark ?? []}
        />
        <Kpi
          caps="Соединений сейчас"
          value={conntrackNow === null ? '—' : Math.round(conntrackNow).toLocaleString('ru-RU')}
          unit={conntrackNow === null ? undefined : 'conntrack'}
          status={conntrackNow === null ? 'ждёт агента' : 'весь парк'}
          tone={conntrackNow === null ? 'muted' : 'ok'}
          spark={fleet?.conntrackSpark ?? []}
        />
      </div>

      {/* Требует внимания + Трафик парка */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
        <Panel
          title="Требует внимания"
          right={
            <span
              className={cn(
                'inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-[11.5px] font-semibold',
                attention.length > 0 ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok',
              )}
            >
              {attention.length}
            </span>
          }
        >
          {attention.length === 0 ? (
            <div className="grid h-[190px] place-items-center">
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
                  <CheckIcon className="size-5" aria-hidden="true" />
                </span>
                <p className="text-[13.5px] font-semibold">Всё спокойно</p>
                <p className="text-[12.5px] text-text-3">Проблем на серверах не найдено.</p>
              </div>
            </div>
          ) : (
            <ul className="flex flex-col">
              {attention.slice(0, 5).map((row) => (
                <li key={row.key} className="border-t border-border first:border-t-0">
                  <Link
                    {...row.link}
                    className="flex items-center gap-3 rounded-[10px] px-1.5 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    <span
                      className={cn('size-2 flex-none rounded-full', HEALTH_DOT[row.tone])}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold">{row.name}</span>
                      <span className="block truncate text-[12px] text-text-3">{row.reason}</span>
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap',
                        row.tone === 'crit' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn',
                      )}
                    >
                      {row.pill}
                    </span>
                    <ChevronRightIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Трафик парка"
          right={
            <Link to="/servers" className="text-[12.5px] text-brand transition-colors hover:text-foreground">
              Все серверы →
            </Link>
          }
        >
          {trafficNow === null ? (
            <div className="grid h-[190px] place-items-center">
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-text-3">
                  <ActivityIcon className="size-5" aria-hidden="true" />
                </span>
                <p className="text-[13.5px] font-semibold">Пока нет данных</p>
                <p className="text-[12.5px] text-text-3">Трафик появится, когда агент выйдет на связь.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <div className="font-heading text-[26px] leading-none font-bold tracking-[-0.02em] tabular-nums">
                  ↓ {rx.value}
                  <span className="ml-1.5 text-[13px] font-medium text-text-3">{rx.unit} приём</span>
                </div>
                <div className="font-heading text-[26px] leading-none font-bold tracking-[-0.02em] text-teal tabular-nums">
                  ↑ {tx.value}
                  <span className="ml-1.5 text-[13px] font-medium text-text-3">{tx.unit} отдача</span>
                </div>
              </div>
              <AreaSpark
                values={fleet?.trafficRxSpark ?? []}
                values2={fleet?.trafficTxSpark ?? []}
                className="mt-3 h-[150px] w-full"
              />
            </>
          )}
        </Panel>
      </div>

      {/* Последние события (вместо панели инцидентов демо — они появятся на этапе 8) */}
      <Panel
        title="Последние события"
        right={
          <Link to="/audit" className="text-[12.5px] text-brand transition-colors hover:text-foreground">
            Журнал →
          </Link>
        }
      >
        {events.data && events.data.items.length > 0 ? (
          <ul className="flex flex-col">
            {events.data.items.slice(0, 6).map((e) => {
              const Icon = CATEGORY_ICON[e.category] ?? CogIcon;
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0"
                >
                  <span
                    className="grid size-8 flex-none place-items-center rounded-full border border-border bg-surface-2 text-text-2"
                    aria-hidden="true"
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">
                      {auditActionLabel(e.action)}
                      {e.targetDisplay && (
                        <span className="font-normal text-text-3"> · {e.targetDisplay}</span>
                      )}
                    </span>
                    <span className="block truncate text-[12px] text-text-3">
                      {e.actorDisplay} · {AUDIT_SOURCE_LABELS[e.source]} · {formatWhen(e.occurredAt)}
                    </span>
                  </span>
                  <ResultPill result={e.result} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-4 text-[12.5px] text-text-3">Событий пока нет.</p>
        )}
      </Panel>

      {/* Нижняя полоса плиток (ov-strip из демо) */}
      {items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <Caps>В норме</Caps>
            <div className="mt-1.5 font-heading text-[24px] leading-none font-bold tabular-nums">
              {okCount}
              <span className="ml-1.5 text-[13px] font-medium text-text-3">из {items.length} серверов</span>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-4">
            <Caps>Средняя загрузка</Caps>
            <div className="mt-1.5 font-heading text-[24px] leading-none font-bold tabular-nums">
              {cpuAvg === null ? '—' : formatPct(cpuAvg)}
              <span className="ml-1.5 text-[13px] font-medium text-text-3">% CPU</span>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-4">
            <Caps>Память парка</Caps>
            <div className="mt-1.5 font-heading text-[24px] leading-none font-bold tabular-nums">
              {memAvg === null ? '—' : formatPct(memAvg)}
              <span className="ml-1.5 text-[13px] font-medium text-text-3">% занято</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

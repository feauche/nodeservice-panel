import {
  AUDIT_SOURCE_LABELS,
  auditActionLabel,
  type Incident,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CogIcon,
  DatabaseIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LayersIcon,
  RadarIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  WalletIcon,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useState } from 'react';
import { Card, CardLink, ChartCard, CountBadge } from '@/components/card';
import { CountryFlag } from '@/components/country-flag';
import { Caps, KpiCard, type KpiTone } from '@/components/kpi-card';
import { MetricArea } from '@/components/metric-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuditList } from '@/features/audit/audit-api';
import { formatWhen } from '@/features/audit/audit-format';
import { ResultPill } from '@/features/audit/audit-row';
import { useBillingSummary } from '@/features/billing/billing-api';
import { dueWords, money, rub } from '@/features/billing/billing-format';
import { useIncidents } from '@/features/incidents/incidents-api';
import { bytes } from '@/features/nodes/node-card';
import { NodeDialog } from '@/features/nodes/node-dialog';
import { useNodeMetrics } from '@/features/nodes/node-metrics';
import { useNodes } from '@/features/nodes/nodes-api';
import { apiErrorMessage } from '@/lib/api';
import { isSectionOpen } from '@/lib/stages';
import { mbitText } from '@/lib/units';
import { cn } from '@/lib/utils';
import {
  eventTitle,
  fmt,
  mbit,
  type NodeHealth,
  nodeHealth,
  plural,
  rates,
  shortWhen,
} from './overview-format';

const MONTH_IN = [
  'январе',
  'феврале',
  'марте',
  'апреле',
  'мае',
  'июне',
  'июле',
  'августе',
  'сентябре',
  'октябре',
  'ноябре',
  'декабре',
];

const DOT: Record<'ok' | 'warn' | 'crit' | 'muted' | 'info', string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  muted: 'bg-text-3',
  info: 'bg-brand',
};

function Dot({ tone, glow = false }: { tone: keyof typeof DOT; glow?: boolean }) {
  return (
    <span
      className={cn(
        'size-2 flex-none rounded-full',
        DOT[tone],
        glow && tone === 'crit' && 'shadow-[0_0_0_4px_var(--ns-crit-soft)]',
        glow && tone === 'warn' && 'shadow-[0_0_0_4px_var(--ns-warn-soft)]',
      )}
      aria-hidden="true"
    />
  );
}

/** Полоса здоровья парка: доли нод в норме, с вниманием и со сбоем; выключенные — только в подписи. */
function HealthBar({ counts }: { counts: Record<NodeHealth, number> }) {
  const total = counts.ok + counts.warn + counts.crit;
  if (total === 0) return null;
  const pct = Math.round((counts.ok / total) * 100);
  return (
    <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
      <div
        role="img"
        aria-label={`Здоровье парка ${pct}%`}
        className="flex h-1.5 min-w-[220px] flex-1 gap-0.5 overflow-hidden rounded-full bg-surface-3"
      >
        {(['ok', 'warn', 'crit'] as const).map((k) =>
          counts[k] > 0 ? (
            <i key={k} className={cn('block h-full', DOT[k])} style={{ flex: counts[k] }} />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] whitespace-nowrap text-text-2">
        <span className="flex items-center gap-[7px]">
          <Dot tone="ok" /> {counts.ok} в норме
        </span>
        <span className="flex items-center gap-[7px]">
          <Dot tone="warn" /> {counts.warn} внимание
        </span>
        <span className="flex items-center gap-[7px]">
          <Dot tone="crit" /> {counts.crit} со сбоем
        </span>
        {counts.maintenance > 0 && (
          <span className="flex items-center gap-[7px]">
            <Dot tone="info" /> {counts.maintenance} на обслуживании
          </span>
        )}
        {counts.off > 0 && (
          <span className="flex items-center gap-[7px]">
            <Dot tone="muted" /> {counts.off} {counts.off === 1 ? 'не используется' : 'не используются'}
          </span>
        )}
        <span className="text-text-3">
          здоровье парка <b className="font-bold text-foreground tabular-nums">{pct}%</b>
        </span>
      </div>
    </div>
  );
}

/** Плитка-сводка со значком: Remnawave и оплата. */
function SummaryTile({
  icon: Icon,
  tone = 'info',
  title,
  sub,
  to,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  tone?: 'info' | 'warn' | 'crit';
  title: ReactNode;
  sub: ReactNode;
  to: '/nodes' | '/billing';
}) {
  return (
    <Link
      to={to}
      className={cn(
        'flex min-w-0 items-center gap-3.5 rounded-2xl border bg-surface p-4 transition-colors hover:border-border-2 focus-visible:outline-2 focus-visible:outline-brand',
        tone === 'crit'
          ? 'border-crit/45 hover:border-crit/60'
          : tone === 'warn'
            ? 'border-warn/40 hover:border-warn/60'
            : 'border-border',
      )}
    >
      <span
        className={cn(
          'grid size-10 flex-none place-items-center rounded-full',
          tone === 'crit'
            ? 'bg-crit-soft text-crit'
            : tone === 'warn'
              ? 'bg-warn-soft text-warn'
              : 'bg-brand-soft text-brand',
        )}
      >
        <Icon className="size-[19px]" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <b className={cn('block text-[14px] font-semibold', tone === 'crit' && 'text-crit')}>{title}</b>
        <small className="mt-[3px] block text-[12.5px] leading-[1.45] text-text-3">{sub}</small>
      </span>
    </Link>
  );
}

/** Оплата: просрочка или ближайший срок и расходы месяца. Оплат нет — плитки нет. */
function BillingSummaryTile() {
  const open = isSectionOpen('/billing');
  const summary = useBillingSummary(open);
  const s = summary.data;
  if (!open || !s || (!s.next && s.month.spentRubMinor === 0)) return null;
  const alarm = s.overdue > 0;
  const title = alarm
    ? s.overdue === 1 && s.next
      ? `Просрочена оплата «${s.next.title}» — ${money(s.next.amountMinor, s.next.currency)}`
      : `Просрочено оплат: ${s.overdue}`
    : s.next
      ? `Ближайшая оплата: «${s.next.title}» ${dueWords(s.next.paidUntil)}`
      : 'Ближайших оплат нет';
  return (
    <SummaryTile
      icon={WalletIcon}
      tone={alarm ? 'crit' : 'info'}
      to="/billing"
      title={title}
      sub={`В ${MONTH_IN[new Date().getMonth()]} оплачено ${rub(s.month.spentRubMinor)} · ещё ≈ ${rub(s.month.expectedRubMinor)}`}
    />
  );
}

type AttentionRow = {
  key: string;
  node: RemnawaveNode | null;
  name: string;
  reason: string;
  tone: 'warn' | 'crit';
  pill: string;
  incident: string | null;
};

function AttentionItem({ row, onOpenNode }: { row: AttentionRow; onOpenNode: (uuid: string) => void }) {
  const body = (
    <>
      <Dot tone={row.tone} glow />
      <span className="min-w-0 flex-1">
        <b className="flex min-w-0 items-center gap-2 text-[14px] font-medium transition-colors group-hover:text-brand">
          {row.node?.countryCode && <CountryFlag code={row.node.countryCode} size="sm" />}
          <span className="truncate">{row.name}</span>
        </b>
        <small className="mt-0.5 block truncate text-[12.5px] text-text-3">{row.reason}</small>
      </span>
      <span
        className={cn(
          'rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap',
          row.tone === 'crit' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn',
        )}
      >
        {row.pill}
      </span>
      <ChevronRightIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
    </>
  );
  const cls =
    'group flex w-full cursor-pointer items-center gap-3.5 py-[13px] text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand';
  return row.incident ? (
    <Link to="/incidents/$id" params={{ id: row.incident }} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={() => row.node && onOpenNode(row.node.uuid)}>
      {body}
    </button>
  );
}

const EVENT_ICON: Array<[RegExp, ComponentType<{ className?: string }>, string]> = [
  [/^incident\.resolved$/, CircleCheckIcon, 'bg-ok-soft text-ok border-transparent'],
  [/^incident\./, TriangleAlertIcon, 'bg-crit-soft text-crit border-transparent'],
  [/^(integration|server\.check)/, RadarIcon, 'bg-brand-soft text-brand border-transparent'],
  [/^scenario/, GitBranchIcon, 'bg-ai-soft text-ai border-transparent'],
  [/^backup\./, DatabaseIcon, ''],
  [/^kb\./, BookOpenIcon, ''],
  [/^(auth|security)\./, KeyRoundIcon, ''],
  [/^(settings|remnawave|provider|billing)\./, SlidersHorizontalIcon, ''],
];

function eventIcon(action: string) {
  return EVENT_ICON.find(([re]) => re.test(action)) ?? [/./, CogIcon, ''];
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Загрузка обзора" className="flex flex-col gap-3">
      <Skeleton className="h-1.5 w-full rounded-full" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[132px] rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-[74px] rounded-2xl" />
        <Skeleton className="h-[74px] rounded-2xl" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-[300px] rounded-2xl" />
        <Skeleton className="h-[300px] rounded-2xl" />
      </div>
    </div>
  );
}

/** «Обзор», вкладка «Сейчас»: раскладка 0.67.0 с нынешним наполнением (витрина redesign-2026-10, вариант A). */
export function OverviewNow() {
  const nodesQuery = useNodes();
  const metrics = useNodeMetrics(60);
  const incidents = useIncidents('open');
  const audit = useAuditList({ page: 1, pageSize: 6 });
  const [selected, setSelected] = useState<string | null>(null);

  if (nodesQuery.isPending) return <OverviewSkeleton />;
  if (nodesQuery.isError)
    return (
      <p role="alert" className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
        {apiErrorMessage(nodesQuery.error)}{' '}
        <button type="button" className="cursor-pointer underline" onClick={() => void nodesQuery.refetch()}>
          Повторить
        </button>
      </p>
    );
  const status = nodesQuery.data;
  if (!status?.connected)
    return (
      <section className="rounded-2xl border border-border bg-surface p-8">
        <h2 className="font-heading text-xl">Подключите Remnawave</h2>
        <p className="mt-2 text-text-2">Ноды и метрики появятся после подключения панели.</p>
        <Link className="mt-4 inline-block text-brand" to="/nodes">
          Настроить подключение →
        </Link>
      </section>
    );

  const nodes = status.nodes;
  const open: Incident[] = (incidents.data?.items ?? []).filter((i) => i.status !== 'resolved');
  const health = new Map(nodes.map((n) => [n.uuid, nodeHealth(n, open)]));
  const counts: Record<NodeHealth, number> = { ok: 0, warn: 0, crit: 0, off: 0, maintenance: 0 };
  for (const h of health.values()) counts[h] += 1;
  const enabled = nodes.filter((n) => !n.isDisabled);
  const connected = enabled.filter((n) => n.isConnected);
  const sumOf = (pick: (n: RemnawaveNode) => number | null | undefined) => {
    const xs = connected.map(pick).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((s, v) => s + v, 0) : null;
  };
  const onlineNow = sumOf((n) => n.usersOnline);
  const rxNow = sumOf((n) => n.rxBytesPerSec);
  const txNow = sumOf((n) => n.txBytesPerSec);
  const memUsed = sumOf((n) => n.memoryUsedBytes);
  const memTotal = sumOf((n) => n.memoryTotalBytes);
  const memPct = memUsed != null && memTotal ? (memUsed / memTotal) * 100 : null;
  const perCore = connected.flatMap((n) => {
    const load = n.loadAverage?.[0];
    return load != null && n.cpuCount ? [load / n.cpuCount] : [];
  });
  const loadPerCore = perCore.length ? perCore.reduce((s, v) => s + v, 0) / perCore.length : null;
  const ramAvg = (() => {
    const xs = connected.flatMap((n) =>
      n.memoryTotalBytes && n.memoryUsedBytes != null ? [(n.memoryUsedBytes / n.memoryTotalBytes) * 100] : [],
    );
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  })();

  const fleet = metrics.data?.fleet ?? [];
  const times = fleet.map((p) => p.t);
  const typical = metrics.data?.onlineTypical ?? null;
  const r = rates(rxNow, txNow);
  const trafficMbit = fleet.map((p) => [mbit(p.rx), mbit(p.tx)] as const);
  const giga = trafficMbit.some(([a, b]) => (a ?? 0) >= 1000 || (b ?? 0) >= 1000);
  const scale = (v: number | null) => (v == null ? null : giga ? v / 1000 : v);

  const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
  const rows: AttentionRow[] = [
    ...open.map((i) => {
      const node = i.nodeUuid ? (byUuid.get(i.nodeUuid) ?? null) : null;
      const name = node?.name ?? i.serverName;
      return {
        key: `i:${i.id}`,
        node,
        name,
        reason: `${eventTitle(i.title, name)} · с ${shortWhen(i.openedAt)}`,
        tone: i.severity === 'crit' ? ('crit' as const) : ('warn' as const),
        pill: i.status === 'acknowledged' ? 'В работе' : 'Событие',
        incident: i.id,
      };
    }),
    // Нода без связи, по которой события ещё нет, — тоже сюда: открывается её окно.
    ...enabled
      .filter((n) => !n.isConnected && !n.maintenance && !open.some((i) => i.nodeUuid === n.uuid))
      .map((n) => ({
        key: `n:${n.uuid}`,
        node: n,
        name: n.name,
        reason: n.isConnecting ? 'Подключается к Remnawave' : 'Remnawave не видит ноду',
        tone: 'crit' as const,
        pill: 'Нет связи',
        incident: null,
      })),
  ];
  const rest = Math.max(0, counts.ok);
  const cert = status.cert;
  const remnaSub = status.error
    ? `Последние данные ${status.checkedAt ? formatWhen(status.checkedAt) : 'неизвестно когда'}`
    : [
        onlineNow != null ? `${fmt(onlineNow)} онлайн на нодах` : null,
        status.stats ? `${fmt(status.stats.users.total)} пользователей` : null,
        status.stats ? `${bytes(status.stats.trafficBytesLifetime)} трафика` : null,
        cert?.daysLeft != null
          ? cert.daysLeft < 0
            ? 'сертификат истёк'
            : `сертификат ещё ${cert.daysLeft} ${plural(cert.daysLeft, 'день', 'дня', 'дней')}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ');

  const selectedNode = nodes.find((n) => n.uuid === selected);
  const kpiTone: KpiTone = counts.crit > 0 ? 'crit' : counts.warn > 0 ? 'warn' : 'ok';
  const typicalTone: KpiTone =
    !typical || onlineNow == null ? 'muted' : onlineNow < typical.low * 0.85 ? 'warn' : 'ok';

  return (
    <div className="flex flex-col gap-3">
      {status.error && (
        <p className="rounded-[12px] border border-warn/30 bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn">
          Показан последний снимок: {status.error}
        </p>
      )}
      <HealthBar counts={counts} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Нод на связи"
          value={connected.length}
          unit={`/ ${enabled.length}`}
          status={
            counts.crit > 0
              ? `${counts.crit} со сбоем`
              : counts.warn > 0
                ? `${counts.warn} с предупреждением`
                : 'Все в норме'
          }
          tone={kpiTone}
          spark={fleet.map((p) => p.up)}
        />
        <KpiCard
          label="Онлайн на нодах"
          value={fmt(onlineNow)}
          status={
            typical
              ? typicalTone === 'warn'
                ? `Ниже обычного: ${fmt(typical.low)}–${fmt(typical.high)}`
                : `Обычно ${fmt(typical.low)}–${fmt(typical.high)}`
              : 'Сумма по нодам'
          }
          tone={typicalTone}
          spark={fleet.map((p) => p.online)}
        />
        <KpiCard
          label="Трафик сейчас"
          value={
            rxNow == null && txNow == null ? (
              '—'
            ) : (
              <span className="flex items-baseline gap-1.5 text-[24px]">
                <span>↓{r.rx}</span>
                <span className="text-text-3">·</span>
                <span>↑{r.tx}</span>
              </span>
            )
          }
          unit={rxNow == null && txNow == null ? undefined : r.unit}
          status="Приём · отдача"
          tone="info"
          spark={fleet.map((p) => (p.rx == null && p.tx == null ? null : (p.rx ?? 0) + (p.tx ?? 0)))}
        />
        <KpiCard
          label="Память парка"
          value={fmt(memPct, 1)}
          unit={memPct == null ? undefined : `% · ${bytes(memUsed)} из ${bytes(memTotal)}`}
          status={memPct == null ? 'Нет данных' : memPct > 85 ? 'Высокая' : 'В норме'}
          tone={memPct == null ? 'muted' : memPct > 85 ? 'warn' : 'ok'}
          spark={fleet.map((p) => p.ram)}
        />
      </div>

      <div className="grid gap-3 empty:hidden md:grid-cols-[repeat(auto-fit,minmax(320px,1fr))]">
        <SummaryTile
          icon={LayersIcon}
          tone={status.error ? 'warn' : 'info'}
          to="/nodes"
          title={
            status.error
              ? 'Remnawave: свежих данных нет'
              : `Remnawave: ${connected.length} из ${enabled.length} ${plural(enabled.length, 'ноды', 'нод', 'нод')} на связи`
          }
          sub={remnaSub}
        />
        <BillingSummaryTile />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="Требует внимания"
          count={
            <CountBadge
              n={incidents.isPending || (incidents.isError && !incidents.data) ? '—' : rows.length}
              tone={rows.some((x) => x.tone === 'crit') ? 'crit' : rows.length ? 'warn' : 'ok'}
            />
          }
          end={isSectionOpen('/incidents') ? <CardLink to="/incidents">Все события</CardLink> : undefined}
        >
          {incidents.isPending ? (
            <div role="status" aria-label="Загрузка событий" className="flex flex-col gap-2 px-4 py-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 rounded-[10px]" />
              ))}
            </div>
          ) : incidents.isError && !incidents.data ? (
            <p role="alert" className="px-4 py-6 text-[12.5px] text-crit">
              Не удалось проверить открытые события. {apiErrorMessage(incidents.error)}
            </p>
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-9 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
                <CheckIcon className="size-5" aria-hidden="true" />
              </span>
              <p className="text-[13.5px] font-semibold">Всё спокойно</p>
              <p className="text-[12.5px] text-text-3">Открытых событий нет, все ноды на связи.</p>
            </div>
          ) : (
            <ul className="px-4 pt-1.5 pb-2">
              {rows.slice(0, 5).map((row) => (
                <li key={row.key} className="border-t border-border first:border-t-0">
                  <AttentionItem row={row} onOpenNode={setSelected} />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-auto flex items-center gap-2 border-t border-border px-4 py-3 text-[12.5px] text-text-3">
            <CircleCheckIcon className="size-4 flex-none" aria-hidden="true" />
            <span>
              {rows.length > 5
                ? `Ещё ${rows.length - 5} — в разделе «События»`
                : `${rows.length ? 'Остальные' : 'Все'} ${rest} ${plural(rest, 'нода', 'ноды', 'нод')} в норме`}
            </span>
          </div>
        </Card>

        <ChartCard
          title="Трафик парка"
          end={<CardLink to="/nodes">Все ноды</CardLink>}
          foot="Последний час · наведите на график, чтобы увидеть значение"
        >
          <div className="mt-1 flex flex-wrap items-baseline gap-x-[22px] gap-y-1.5">
            <span className="flex items-baseline gap-1.5 font-heading text-[28px] font-bold tabular-nums">
              <span className="text-brand">↓</span>
              {r.rx}
              <small className="font-sans text-[12.5px] font-medium text-text-3">{r.unit} приём</small>
            </span>
            <span className="flex items-baseline gap-1.5 font-heading text-[28px] font-bold tabular-nums">
              <span className="text-teal">↑</span>
              {r.tx}
              <small className="font-sans text-[12.5px] font-medium text-text-3">{r.unit} отдача</small>
            </span>
          </div>
          <MetricArea
            loading={metrics.isPending}
            times={times}
            height={190}
            unit={giga ? ' Гбит/с' : ' Мбит/с'}
            format={(v) => mbitText(giga ? v * 1000 : v, giga)}
            series={[
              {
                key: 'rx',
                name: 'Приём',
                color: 'var(--ns-accent)',
                values: trafficMbit.map(([a]) => scale(a)),
              },
              {
                key: 'tx',
                name: 'Отдача',
                color: 'var(--ns-teal)',
                values: trafficMbit.map(([, b]) => scale(b)),
              },
            ]}
          />
        </ChartCard>
      </div>

      {metrics.isError && (
        <p role="alert" className="text-[12.5px] text-crit">
          Графики не загрузились: {apiErrorMessage(metrics.error)}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <ChartCard
          title="Онлайн на нодах"
          sub={`сумма по ${connected.length} ${plural(connected.length, 'ноде', 'нодам', 'нодам')}`}
          value={fmt(onlineNow)}
          valueSub={typical ? `обычно ${fmt(typical.low)}–${fmt(typical.high)}` : 'сейчас'}
          foot="Шаг 1 минута · одиночный пропуск замера дорисован, перерыв показан серой полосой «нет данных»"
        >
          <MetricArea
            loading={metrics.isPending}
            times={times}
            series={[
              {
                key: 'online',
                name: 'Онлайн',
                color: 'var(--ns-accent)',
                values: fleet.map((p) => p.online),
              },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Память · средняя по нодам"
          sub={memTotal ? `из ${bytes(memTotal)}` : undefined}
          value={ramAvg == null ? '—' : `${fmt(ramAvg, 1)} %`}
          valueSub="занято в среднем"
          foot="Средняя по нодам, которые прислали замер в эту минуту; выключенные не учитываются"
        >
          <MetricArea
            loading={metrics.isPending}
            times={times}
            unit=" %"
            yMin={0}
            yMax={100}
            series={[{ key: 'ram', name: 'Память', color: 'var(--ns-ok)', values: fleet.map((p) => p.ram) }]}
          />
        </ChartCard>
      </div>

      <Card title="Последние события" end={<CardLink to="/audit">Журнал</CardLink>}>
        {audit.isPending ? (
          <div role="status" aria-label="Загрузка событий" className="flex flex-col gap-2 px-4 py-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 rounded-[10px]" />
            ))}
          </div>
        ) : audit.isError ? (
          <p className="px-4 py-4 text-[12.5px] text-crit">
            Не удалось загрузить события.{' '}
            <button type="button" className="cursor-pointer underline" onClick={() => void audit.refetch()}>
              Повторить
            </button>
          </p>
        ) : audit.data && audit.data.items.length > 0 ? (
          <ul className="px-4 pt-1 pb-2">
            {audit.data.items.slice(0, 6).map((e) => {
              const [, Icon, tone] = eventIcon(e.action);
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3.5 border-t border-border py-3 first:border-t-0"
                >
                  <span
                    className={cn(
                      'grid size-9 flex-none place-items-center rounded-full border border-border bg-surface-2 text-text-2',
                      tone,
                    )}
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
                    <span className="mt-[3px] block truncate text-[12px] text-text-3">
                      {e.actorDisplay} · {AUDIT_SOURCE_LABELS[e.source]} · {formatWhen(e.occurredAt)}
                    </span>
                  </span>
                  <ResultPill result={e.result} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 py-4 text-[12.5px] text-text-3">Событий пока нет.</p>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <Caps className="mb-2">В норме</Caps>
          <div className="flex items-baseline gap-1.5 font-heading text-[24px] font-semibold tabular-nums">
            {counts.ok}
            <small className="font-sans text-[13px] font-medium text-text-3">
              из {enabled.length} {plural(enabled.length, 'ноды', 'нод', 'нод')}
            </small>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <Caps className="mb-2">Средняя нагрузка</Caps>
          <div className="flex items-baseline gap-1.5 font-heading text-[24px] font-semibold tabular-nums">
            {fmt(loadPerCore, 2)}
            <small className="font-sans text-[13px] font-medium text-text-3">на ядро</small>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <Caps className="mb-2">Память парка</Caps>
          <div className="flex items-baseline gap-1.5 font-heading text-[24px] font-semibold tabular-nums">
            {fmt(memPct, 0)}
            <small className="font-sans text-[13px] font-medium text-text-3">% занято</small>
          </div>
        </div>
      </div>

      {selectedNode && (
        <NodeDialog node={selectedNode} stale={!!status.error} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

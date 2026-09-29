import {
  FLEET_STATS_PERIOD_LABELS,
  FLEET_STATS_PERIODS,
  type FleetStats,
  type FleetStatsPeriod,
  fleetStatsSchema,
} from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { openServer } from '@/features/servers/server-modal-store';
import { Segmented } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const PERIOD_KEY = 'ns-fleet-stats-period';

function readPeriod(): FleetStatsPeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    return (FLEET_STATS_PERIODS as readonly string[]).includes(v ?? '') ? (v as FleetStatsPeriod) : 'month';
  } catch {
    return 'month';
  }
}

export function useFleetStats(period: FleetStatsPeriod) {
  return useQuery({
    queryKey: ['fleet', 'stats', period] as const,
    queryFn: ({ signal }): Promise<FleetStats> =>
      api.get(`/fleet/stats?period=${period}`, fleetStatsSchema, signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/* ---------- форматирование ---------- */

const nf = (v: number, digits = 1) => v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
export function formatBytes(b: number | null): { value: string; unit: string } {
  if (b === null) return { value: '—', unit: '' };
  if (b >= 1e12) return { value: nf(b / 1e12), unit: 'ТБ' };
  if (b >= 1e9) return { value: nf(b / 1e9), unit: 'ГБ' };
  return { value: nf(b / 1e6, 0), unit: 'МБ' };
}
export function formatBps(v: number | null): { value: string; unit: string } {
  if (v === null) return { value: '—', unit: '' };
  if (v >= 1e9) return { value: nf(v / 1e9, 2), unit: 'Гбит/с' };
  return { value: nf(v / 1e6, 0), unit: 'Мбит/с' };
}
const bytesText = (b: number | null) => {
  const f = formatBytes(b);
  return f.unit ? `${f.value} ${f.unit}` : f.value;
};
const WHEN = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string | null) =>
  iso ? WHEN.format(new Date(iso)).replace(' в ', ', ').replace('.', '') : '';
const pct = (v: number | null) => (v === null ? '—' : `${nf(v)} %`);
const rubles = (minor: number | null) =>
  minor === null
    ? '—'
    : `${(minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: minor < 10_000 ? 1 : 0 })} ₽`;

/* ---------- кирпичики ---------- */

function Caps({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">{children}</div>;
}

function Kpi({
  caps,
  value,
  unit,
  sub,
  testId,
}: {
  caps: string;
  value: string;
  unit?: string;
  sub: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-2xl border border-border bg-surface p-4"
      data-testid={testId}
    >
      <Caps>{caps}</Caps>
      <div className="font-heading text-[28px] leading-none font-bold tracking-[-0.02em] whitespace-nowrap tabular-nums">
        {value}
        {unit && <span className="ml-1.5 text-[13px] font-medium text-text-3">{unit}</span>}
      </div>
      <div className="mt-auto pt-1 text-[12px] leading-snug text-text-2">{sub}</div>
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="font-heading text-[14.5px] font-bold">{title}</h2>
        {right && <span className="text-[12px] text-text-3">{right}</span>}
      </div>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="grid h-full min-h-[160px] place-items-center rounded-[12px] border border-dashed border-border-2 px-4 text-center text-[12.5px] text-text-3">
      {children}
    </p>
  );
}

function Bars({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(1, ...values);
  const w = 1000;
  const h = 180;
  const bw = (w / values.length) * 0.62;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block h-[180px] w-full"
      role="img"
      aria-label="Трафик по дням"
    >
      {values.map((v, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: столбцы идут по порядку времени
          key={i}
          x={(i / values.length) * w + (w / values.length - bw) / 2}
          y={h - (v / max) * h}
          width={bw}
          height={(v / max) * h}
          rx={3}
          fill="var(--color-brand)"
          opacity={i === values.length - 1 ? 1 : 0.75}
        >
          <title>{`${labels[i]}: ${bytesText(v)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

function Lines({ a, b }: { a: number[]; b?: number[] }) {
  const w = 1000;
  const h = 180;
  const max = Math.max(1, ...a, ...(b ?? [])) * 1.1;
  const pts = (v: number[]) =>
    v
      .map((y, i) => `${((i / Math.max(1, v.length - 1)) * w).toFixed(1)},${(h - (y / max) * h).toFixed(1)}`)
      .join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block h-[180px] w-full"
      aria-hidden="true"
    >
      <polygon points={`0,${h} ${pts(a)} ${w},${h}`} fill="var(--color-brand)" opacity={0.16} />
      <polyline
        points={pts(a)}
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth={2.2}
        vectorEffect="non-scaling-stroke"
      />
      {b && (
        <polyline
          points={pts(b)}
          fill="none"
          stroke="var(--color-teal)"
          strokeWidth={2.2}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-2">
      {items.map(([color, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <i className="size-2.5 rounded-[3px]" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

const TH = 'px-2.5 py-2 text-left text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase';
const TD = 'border-t border-border px-2.5 py-2 text-[12.5px]';

/* ---------- страница ---------- */

/**
 * «Обзор» → «Статистика» (витрины `fleet-stats-variants.html`, A1, и `stats-switch-variants.html`, вариант 1):
 * период — маленькой строкой над итогами, дальше трафик, нагрузка, инциденты, онлайн нод и таблица серверов.
 */
export function FleetStatsView() {
  const [period, setPeriodRaw] = useState<FleetStatsPeriod>(readPeriod);
  const setPeriod = (p: FleetStatsPeriod) => {
    setPeriodRaw(p);
    try {
      localStorage.setItem(PERIOD_KEY, p);
    } catch {
      /* ignore */
    }
  };
  const q = useFleetStats(period);
  const s = q.data;
  const label = FLEET_STATS_PERIOD_LABELS[period];
  const forLabel = period === 'day' ? 'за сутки' : period === 'week' ? 'за неделю' : `за ${label}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Caps>Итоги {forLabel}</Caps>
        <span
          className="text-text-3"
          title="Сравнение — с прошлым таким же периодом. Метрики серверов хранятся 90 дней. Трафик и нагрузка — по данным агентов, доступность — по инцидентам «агент/SSH недоступен»."
        >
          <InfoIcon className="size-3.5" aria-label="Как считается" />
        </span>
        <span className="flex-1" />
        <Segmented
          label="Период статистики"
          value={period}
          onChange={setPeriod}
          items={FLEET_STATS_PERIODS.map((p) => ({ key: p, label: FLEET_STATS_PERIOD_LABELS[p] }))}
        />
      </div>

      {q.isError ? (
        <p
          role="alert"
          className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
        >
          {apiErrorMessage(q.error)}
        </p>
      ) : !s ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[118px] rounded-2xl" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-[260px] rounded-2xl" />
            <Skeleton className="h-[260px] rounded-2xl" />
          </div>
        </div>
      ) : (
        <Stats s={s} forLabel={forLabel} />
      )}
    </div>
  );
}

function Stats({ s, forLabel }: { s: FleetStats; forLabel: string }) {
  const totalBytes =
    s.traffic.rxBytes === null && s.traffic.txBytes === null
      ? null
      : (s.traffic.rxBytes ?? 0) + (s.traffic.txBytes ?? 0);
  const total = formatBytes(totalBytes);
  const change =
    totalBytes !== null && s.traffic.prevTotalBytes
      ? Math.round(((totalBytes - s.traffic.prevTotalBytes) / s.traffic.prevTotalBytes) * 100)
      : null;
  const peak = formatBps(s.traffic.peakBps);
  const avgSpeed = formatBps(s.traffic.avgBps);
  const bucketLabel = new Intl.DateTimeFormat(
    'ru-RU',
    s.period === 'day' ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  );
  const noVm = !s.vmOk;

  return (
    <>
      {noVm && (
        <p className="m-0 rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn">
          Хранилище метрик не ответило — трафик и нагрузка сейчас неизвестны. Доступность, инциденты и деньги
          посчитаны.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          testId="fs-traffic"
          caps={`Трафик ${forLabel}`}
          value={total.value}
          unit={total.unit}
          sub={
            totalBytes === null ? (
              'Нет данных'
            ) : (
              <>
                ↓ {bytesText(s.traffic.rxBytes)} · ↑ {bytesText(s.traffic.txBytes)}
                {change !== null && (
                  <span className={cn('ml-1', change >= 0 ? 'text-ok' : 'text-crit')}>
                    · {change >= 0 ? '+' : ''}
                    {change} % к прошлому
                  </span>
                )}
              </>
            )
          }
        />
        <Kpi
          testId="fs-peak"
          caps="Пик скорости"
          value={peak.value}
          unit={peak.unit}
          sub={
            s.traffic.peakAt
              ? `${when(s.traffic.peakAt)} · в среднем ${avgSpeed.value} ${avgSpeed.unit}`
              : 'Нет данных'
          }
        />
        <Kpi
          testId="fs-availability"
          caps="Доступность парка"
          value={s.availability.pct === null ? '—' : nf(s.availability.pct, 2)}
          unit={s.availability.pct === null ? undefined : '%'}
          sub={
            s.availability.incidents === 0
              ? 'Инцидентов не было'
              : `Инцидентов: ${s.availability.incidents}${s.availability.avgFixMin !== null ? ` · в среднем ${nf(s.availability.avgFixMin, 0)} мин до починки` : ''}`
          }
        />
        <Kpi
          testId="fs-cost"
          caps="Стоимость"
          value={s.cost.perTbRubMinor === null ? rubles(s.cost.spentRubMinor) : rubles(s.cost.perTbRubMinor)}
          unit={s.cost.perTbRubMinor === null ? undefined : 'за ТБ'}
          sub={
            s.cost.perTbRubMinor === null
              ? 'оплачено за период в «Биллинге»'
              : `${rubles(s.cost.spentRubMinor)} за период${s.cost.perUserRubMinor !== null ? ` · ${rubles(s.cost.perUserRubMinor)} на пользователя` : ''}`
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title={s.period === 'day' ? 'Трафик по часам' : 'Трафик по дням'}
          right={s.period === 'day' ? 'за час' : 'за сутки'}
        >
          {s.traffic.buckets.length === 0 ? (
            <Empty>Данных о трафике за период нет.</Empty>
          ) : (
            <>
              <Bars
                values={s.traffic.buckets.map((b) => b.bytes)}
                labels={s.traffic.buckets.map((b) => bucketLabel.format(new Date(b.at)))}
              />
              <Legend items={[['var(--color-brand)', 'Приём + отдача']]} />
            </>
          )}
        </Panel>
        <Panel title="Скорость парка" right="средняя за шаг">
          {s.traffic.speed.length === 0 ? (
            <Empty>Данных о скорости за период нет.</Empty>
          ) : (
            <>
              <Lines a={s.traffic.speed.map((p) => p.rx)} b={s.traffic.speed.map((p) => p.tx)} />
              <Legend
                items={[
                  ['var(--color-brand)', 'Приём'],
                  ['var(--color-teal)', 'Отдача'],
                ]}
              />
            </>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Нагрузка" right="средняя и пиковая по парку">
          <table className="w-full border-collapse" data-testid="fs-load">
            <thead>
              <tr>
                <th className={TH}>Показатель</th>
                <th className={cn(TH, 'text-right')}>Средняя</th>
                <th className={cn(TH, 'text-right')}>Пик</th>
                <th className={TH}>Где пик</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={TD}>Процессор</td>
                <td className={cn(TD, 'text-right tabular-nums')}>{pct(s.load.cpu.avg)}</td>
                <td className={cn(TD, 'text-right tabular-nums')}>{pct(s.load.cpu.peak)}</td>
                <td className={TD}>{s.load.cpu.peakServer ?? '—'}</td>
              </tr>
              <tr>
                <td className={TD}>Память</td>
                <td className={cn(TD, 'text-right tabular-nums')}>{pct(s.load.mem.avg)}</td>
                <td className={cn(TD, 'text-right tabular-nums')}>{pct(s.load.mem.peak)}</td>
                <td className={TD}>{s.load.mem.peakServer ?? '—'}</td>
              </tr>
              <tr>
                <td className={TD}>Соединения</td>
                <td className={cn(TD, 'text-right tabular-nums')}>
                  {s.load.conntrack.avg === null ? '—' : nf(s.load.conntrack.avg, 0)}
                </td>
                <td className={cn(TD, 'text-right tabular-nums')}>
                  {s.load.conntrack.peak === null ? '—' : nf(s.load.conntrack.peak, 0)}
                </td>
                <td className={TD}>весь парк</td>
              </tr>
              <tr>
                <td className={TD}>Диск</td>
                <td className={cn(TD, 'text-right tabular-nums')}>{pct(s.load.disk.avg)}</td>
                <td className={cn(TD, 'text-right tabular-nums')}>{pct(s.load.disk.peak)}</td>
                <td className={TD}>
                  {s.load.disk.peakServer ?? '—'}
                  {s.load.disk.growthPct !== null && s.load.disk.growthPct > 0.5 && (
                    <span className="ml-1.5 rounded-full bg-warn-soft px-2 py-px text-[11px] font-semibold text-warn">
                      +{nf(s.load.disk.growthPct)} % за период
                    </span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <Panel title="Инциденты" right={forLabel}>
          {s.incidentsByKind.length === 0 ? (
            <Empty>Инцидентов за период не было.</Empty>
          ) : (
            <table className="w-full border-collapse" data-testid="fs-incidents">
              <thead>
                <tr>
                  <th className={TH}>Вид</th>
                  <th className={cn(TH, 'text-right')}>Сколько</th>
                  <th className={cn(TH, 'text-right')}>Среднее время</th>
                </tr>
              </thead>
              <tbody>
                {s.incidentsByKind.map((k) => (
                  <tr key={k.kind}>
                    <td className={TD}>{k.label}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{k.count}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>
                      {k.avgMin === null ? 'ещё открыт' : `${nf(k.avgMin, 0)} мин`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Онлайн на нодах" right="по данным Remnawave">
        {s.online.points.length === 0 ? (
          <Empty>
            Панель записывает онлайн каждой ноды раз в минуту начиная с этого обновления. Первые графики
            появятся в течение суток.
          </Empty>
        ) : (
          <>
            <Lines a={s.online.points.map((p) => p.value)} />
            <p className="m-0 mt-2 text-[12px] text-text-2">
              Пик {s.online.peak !== null ? nf(s.online.peak, 0) : '—'}
              {s.online.peakAt ? ` · ${when(s.online.peakAt)}` : ''} · в среднем{' '}
              {s.online.avg !== null ? nf(s.online.avg, 0) : '—'}
            </p>
          </>
        )}
      </Panel>

      <Panel title="По серверам" right="нажмите строку — откроется сервер">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse" data-testid="fs-servers">
            <thead>
              <tr>
                <th className={TH}>Сервер</th>
                <th className={cn(TH, 'text-right')}>Трафик</th>
                <th className={TH}>Доля</th>
                <th className={cn(TH, 'text-right')}>CPU ср.</th>
                <th className={cn(TH, 'text-right')}>CPU пик</th>
                <th className={cn(TH, 'text-right')}>Память</th>
                <th className={cn(TH, 'text-right')}>На связи</th>
              </tr>
            </thead>
            <tbody>
              {s.servers.map((x) => (
                <tr
                  key={x.id}
                  className="cursor-pointer transition-colors hover:bg-surface-2"
                  onClick={() => openServer(x.id)}
                >
                  <td className={cn(TD, 'font-semibold')}>{x.name}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{bytesText(x.trafficBytes)}</td>
                  <td className={TD}>
                    <span className="block h-1.5 min-w-[70px] overflow-hidden rounded-full bg-surface-3">
                      <i
                        className="block h-full rounded-full bg-brand"
                        style={{ width: `${x.sharePct ?? 0}%` }}
                      />
                    </span>
                  </td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{pct(x.cpuAvg)}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{pct(x.cpuPeak)}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{pct(x.memAvg)}</td>
                  <td className={cn(TD, 'text-right')}>
                    {x.uptimePct === null ? (
                      '—'
                    ) : (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                          x.uptimePct >= 99.5
                            ? 'bg-ok-soft text-ok'
                            : x.uptimePct >= 98
                              ? 'bg-warn-soft text-warn'
                              : 'bg-crit-soft text-crit',
                        )}
                      >
                        {nf(x.uptimePct, 2)} %
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

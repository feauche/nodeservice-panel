import { auditActionLabel, type NodeMetricPoint } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { CountryFlag } from '@/components/country-flag';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuditList } from '@/features/audit/audit-api';
import { useBillingStats } from '@/features/billing/billing-api';
import { useOnlineSummary } from '@/features/metrics/use-online-summary';
import { bytes, mbitPerSecond, percent, ram } from '@/features/nodes/node-card';
import { NodeDialog } from '@/features/nodes/node-dialog';
import { NodeMetricChart, useNodeMetrics } from '@/features/nodes/node-metrics';
import { useNodes } from '@/features/nodes/nodes-api';
import { Segmented } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { NodeCapacity } from './node-capacity';

const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const completeSum = (xs: (number | null | undefined)[]) =>
  xs.length && xs.every((x) => x != null) ? sum(xs) : null;
const display = (n: number | null) => (n == null ? '—' : n.toLocaleString('ru-RU'));
const avg = (xs: (number | null | undefined)[]) => {
  const n = xs.filter((x): x is number => x != null);
  return n.length ? sum(n) / n.length : null;
};
export function RemnaOverview({ view }: { view: 'now' | 'stats' | 'capacity' }) {
  const query = useNodes(),
    [days, setDays] = useState('30'),
    [selected, setSelected] = useState<string | null>(null);
  const metrics = useNodeMetrics(view === 'stats' ? Math.min(Number(days), 30) * 1440 : 60, Number(days));
  const billing = useBillingStats('month');
  const onlineSummary = useOnlineSummary(Number(days), view === 'stats');
  const audit = useAuditList({ page: 1, pageSize: 6 });
  const status = query.data,
    nodes = status?.nodes ?? [],
    active = nodes.filter((n) => n.isConnected && !n.isDisabled);
  const rx = completeSum(active.map((n) => n.rxBytesPerSec)),
    tx = completeSum(active.map((n) => n.txBytesPerSec)),
    online = completeSum(active.map((n) => n.usersOnline));
  const totalMemory = completeSum(active.map((n) => n.memoryTotalBytes)),
    usedMemory = completeSum(active.map((n) => n.memoryUsedBytes));
  const history = metrics.data?.history ?? [];
  const traffic = metrics.data?.traffic;
  const trafficSum = traffic ? sum(traffic.sparklineData) : null;
  const series = (field: keyof Omit<NodeMetricPoint, 't'>, mean = false, scale = 1) => {
    const map = new Map<number, (number | null)[]>();
    for (const n of history)
      for (const p of n.points) {
        const a = map.get(p.t) ?? [];
        a.push(p[field]);
        map.set(p.t, a);
      }
    return [...map]
      .sort(([a], [b]) => a - b)
      .map(([t, values]) => {
        const value =
          values.length === history.length && values.every((v) => v != null)
            ? mean
              ? avg(values)
              : completeSum(values)
            : null;
        return { t, v: value == null ? null : value / scale };
      });
  };
  const issue = nodes.filter((n) => (!n.isConnected && !n.isDisabled) || (ram(n) ?? 0) > 85);
  if (query.isPending)
    return (
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  if (query.isError)
    return (
      <p role="alert" className="text-crit">
        {apiErrorMessage(query.error)}
      </p>
    );
  if (!status?.connected)
    return (
      <section className="rounded-2xl border border-border bg-surface p-8">
        <h2 className="font-heading text-xl">Подключите Remnawave</h2>
        <p className="mt-2 text-text-2">Ноды и метрики появятся после подключения панели.</p>
        <a className="mt-4 inline-block text-brand" href="/nodes">
          Настроить подключение →
        </a>
      </section>
    );
  const kpis =
    view === 'now'
      ? [
          ['НОД НА СВЯЗИ', `${active.length} / ${nodes.length}`, 'по данным Remnawave'],
          ['ОНЛАЙН НА НОДАХ', display(online), 'сумма по нодам'],
          [
            'ТРАФИК СЕЙЧАС',
            `${mbitPerSecond(rx == null || tx == null ? null : rx + tx)} Мбит/с`,
            `сумма приёма и отдачи ${active.length} нод`,
          ],
          [
            'ПАМЯТЬ ПАРКА',
            percent(totalMemory && usedMemory != null ? (usedMemory / totalMemory) * 100 : null),
            `${bytes(usedMemory)} / ${bytes(totalMemory)}`,
          ],
        ]
      : view === 'stats'
        ? [
            ['ТРАФИК ЗА ПЕРИОД', bytes(trafficSum), `${days} дней · UTC`],
            [
              'ПИКОВЫЙ ОНЛАЙН',
              display(onlineSummary.data?.peak ?? null),
              onlineSummary.data?.peakAt
                ? `${Math.min(Number(days), 30)} дней · ${new Date(onlineSummary.data.peakAt).toLocaleString('ru-RU')}`
                : 'Пик по сохранённым замерам ещё неизвестен',
            ],
            ['ОНЛАЙН СЕЙЧАС', display(online), 'показания нод'],
            [
              'ОПЛАЧЕНО В ЭТОМ МЕСЯЦЕ',
              billing.data ? `${(billing.data.total.spentRubMinor / 100).toLocaleString('ru-RU')} ₽` : '—',
              'только локальный биллинг',
            ],
          ]
        : [
            ['НОДЫ', String(nodes.length), `${active.length} на связи`],
            [
              'ПРОЦЕССОРЫ',
              `${display(completeSum(active.map((n) => n.cpuCount)))} ядер`,
              'ресурсы доступных нод',
            ],
            [
              'СВОБОДНАЯ ПАМЯТЬ',
              bytes(totalMemory == null || usedMemory == null ? null : Math.max(0, totalMemory - usedMemory)),
              `из ${bytes(totalMemory)}`,
            ],
            ['ОНЛАЙН', display(online), 'текущее число на нодах'],
          ];
  const selectedNode = nodes.find((n) => n.uuid === selected);
  return (
    <div className="space-y-4">
      {status.error && (
        <p className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-sm text-warn">
          Показан последний снимок: {status.error}
        </p>
      )}
      {view === 'stats' && (
        <div className="flex flex-wrap items-center justify-between gap-3 [&>div[role=radiogroup]]:h-10">
          <Link
            to="/"
            search={{ view: 'stats', detail: 'metrics' }}
            className="inline-flex h-10 items-center justify-center rounded-[10px] border border-border bg-surface-2 px-3 text-[13px] font-medium text-text-2 hover:bg-surface-3"
          >
            Разобрать график и события →
          </Link>
          <Segmented
            label="Период статистики"
            value={days}
            onChange={setDays}
            items={[
              { key: '1', label: 'Сутки' },
              { key: '7', label: 'Неделя' },
              { key: '30', label: '30 дней' },
              { key: '90', label: '90 дней' },
            ]}
          />
        </div>
      )}
      {view === 'stats' && onlineSummary.data?.partial && (
        <p className="text-[12px] text-text-3">
          Пик рассчитан по полным одновременным замерам. Неполные снимки нод исключены.
        </p>
      )}
      <div className={view === 'capacity' ? 'hidden' : 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4'}>
        {kpis.map(([label, value, hint]) => (
          <section key={label} className="rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-[11px] font-semibold tracking-wide text-text-3">{label}</h2>
            <div className="my-3 text-[28px] font-semibold tabular-nums">{value}</div>
            <p className="text-xs text-text-2">{hint}</p>
          </section>
        ))}
      </div>
      {(rx == null || tx == null || online == null || totalMemory == null || usedMemory == null) && (
        <p className="text-xs text-text-3">
          Часть нод не передала показатели. Неполные суммы показаны прочерком.
        </p>
      )}
      {metrics.isError && (
        <p role="alert" className="text-sm text-crit">
          {apiErrorMessage(metrics.error)}
        </p>
      )}
      {view === 'now' && (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-2xl border border-border bg-surface">
              <h2 className="border-b border-border p-4 text-sm font-semibold">
                Требует внимания <span className="ml-2 text-text-3">{issue.length}</span>
              </h2>
              <div className="p-4">
                {issue.length ? (
                  issue.map((n) => (
                    <button
                      type="button"
                      key={n.uuid}
                      onClick={() => setSelected(n.uuid)}
                      className="flex w-full items-center justify-between border-b border-border py-3 text-left text-sm"
                    >
                      <span>{n.name}</span>
                      <span className="text-crit">
                        {n.isConnected ? 'Высокая нагрузка RAM' : 'Нет связи'}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="flex h-48 flex-col items-center justify-center gap-2">
                    <span className="size-2 rounded-full bg-ok" />
                    <strong>Все ноды на связи</strong>
                    <span className="text-xs text-text-3">Состояние обновляется каждые 15 секунд</span>
                  </div>
                )}
              </div>
            </section>
            <NodeMetricChart
              title="Входящий трафик парка · Мбит/с"
              value={`${mbitPerSecond(rx)} Мбит/с`}
              data={series('rx', false, 125000)}
              unit=" Мбит/с"
            />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <NodeMetricChart title="Онлайн на нодах" value={display(online)} data={series('online')} />
            <NodeMetricChart
              title="Оперативная память · средняя"
              value={percent(avg(active.map(ram)))}
              data={series('ram', true)}
              percent
              color="var(--ns-ok)"
            />
          </div>
        </>
      )}
      {view === 'stats' && (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <NodeMetricChart
              title="Трафик по дням · ГБ · UTC"
              value={bytes(trafficSum)}
              data={
                traffic?.categories.map((d, i) => ({
                  t: Date.parse(d),
                  v: (traffic.sparklineData[i] ?? 0) / 1073741824,
                })) ?? []
              }
              unit=" ГБ"
            />
            <NodeMetricChart
              title="Онлайн · история NodeService"
              value={display(online)}
              data={series('online')}
            />
          </div>
          {metrics.data?.trafficError && (
            <p role="alert" className="rounded-xl bg-warn-soft p-3 text-xs text-warn">
              {metrics.data.trafficError}
            </p>
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            <NodeMetricChart
              title="Load average · средняя по нодам"
              value={String(avg(active.map((n) => n.loadAverage?.[0]))?.toFixed(2) ?? '—')}
              data={series('load', true)}
            />
            <NodeMetricChart
              title="Оперативная память · средняя"
              value={percent(avg(active.map(ram)))}
              data={series('ram', true)}
              percent
              color="var(--ns-ok)"
            />
          </div>
          <p className="text-xs text-text-3">
            История трафика загружается из Remnawave. Нагрузка и онлайн сохраняются в NodeService
            {metrics.data?.collectedSince
              ? ` с ${new Date(metrics.data.collectedSince).toLocaleString('ru-RU')}`
              : ''}
            . Локальные графики: последние {Math.min(Number(days), 30)} дней; срок хранения — 30 дней.
            Пропуски измерений не соединяются.
          </p>
        </>
      )}
      {view === 'capacity' && <NodeCapacity onSelect={setSelected} />}
      {view === 'stats' && (
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="border-b border-border p-4">
            <h2 className="text-sm font-semibold">Трафик по нодам</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[660px] text-left text-xs">
              <thead className="bg-surface-2 text-text-3">
                <tr>
                  {['Нода', 'За период', 'RAM', 'Онлайн', 'Трафик / лимит'].map((h) => (
                    <th className="px-4 py-3 font-medium" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.uuid} className="border-t border-border">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="flex items-center gap-2 text-left"
                        onClick={() => setSelected(n.uuid)}
                      >
                        {n.countryCode && <CountryFlag code={n.countryCode} />} {n.name}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {bytes(traffic?.series.find((x) => x.uuid === n.uuid)?.total ?? null)}
                    </td>
                    <td className="px-4 py-3">
                      {percent(ram(n))}
                      <div className="mt-1 h-1 w-24 overflow-hidden rounded bg-surface-3">
                        <div className="h-full bg-ok" style={{ width: `${ram(n) ?? 0}%` }} />
                      </div>
                    </td>
                    <td className="px-4 py-3">{n.usersOnline ?? '—'}</td>
                    <td className="px-4 py-3">
                      {bytes(n.trafficUsedBytes)} / {n.trafficLimitBytes ? bytes(n.trafficLimitBytes) : '∞'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {view === 'now' && (
        <section className="rounded-2xl border border-border bg-surface">
          <h2 className="border-b border-border p-4 text-sm font-semibold">Последние события</h2>
          <div className="px-4">
            {audit.data?.items.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-3 border-b border-border py-3 text-xs last:border-b-0"
              >
                <span>{auditActionLabel(e.action)}</span>
                <span className="text-text-3">{new Date(e.occurredAt).toLocaleString('ru-RU')}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {selectedNode && (
        <NodeDialog node={selectedNode} stale={!!status.error} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

import { nodeCapacitySchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
export function NodeCapacity({ onSelect }: { onSelect: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['nodes', 'capacity'],
    queryFn: ({ signal }) => api.get('/nodes/capacity', nodeCapacitySchema, signal),
    refetchInterval: 60000,
  });
  if (q.isPending)
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-text-3">
        Считаем запас по истории нагрузки…
      </div>
    );
  if (q.isError)
    return (
      <p role="alert" className="text-crit">
        {apiErrorMessage(q.error)}
      </p>
    );
  const rows = q.data.rows,
    calculated = rows.filter((r) => r.headroom != null && r.available),
    total = calculated.reduce((s, r) => s + (r.headroom ?? 0), 0);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[12.5px] text-text-3">
          История за 14 дней · обновлено{' '}
          {new Date(q.data.calculatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </span>
        <button
          type="button"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
        >
          Обновить
        </button>
      </div>
      <div className="grid overflow-hidden rounded-2xl border border-border bg-surface sm:grid-cols-3">
        {[
          [
            'Итог',
            calculated.length ? `≈ ${total.toLocaleString('ru-RU')} ещё онлайн` : 'Недостаточно данных',
            'запас по рассчитанным нодам',
          ],
          ['Рассчитано нод', `${calculated.length} / ${rows.length}`, 'процессор, память и канал'],
          ['Период', '14 дней', 'история нагрузки в NodeService'],
        ].map(([title, value, hint]) => (
          <div key={title} className="px-5 py-4 sm:border-r sm:border-border last:border-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-3">{title}</div>
            <div className="mt-2 text-xl font-semibold">{value}</div>
            <p className="mt-1 text-[12px] text-text-3">{hint}</p>
          </div>
        ))}
      </div>
      <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-heading text-[14.5px] font-bold">Показания нод</h2>
          <p className="mt-0.5 text-[12px] text-text-3">
            Безопасные пределы: CPU 80%, память 85%, канал 90%.
          </p>
        </div>
        <div className="hidden grid-cols-[minmax(160px,1.2fr)_80px_repeat(3,minmax(90px,.8fr))_minmax(180px,1.4fr)_20px] gap-3 px-4 py-3 text-[10.5px] font-semibold uppercase tracking-wide text-text-3 xl:grid">
          <span>Нода</span>
          <span>Онлайн*</span>
          <span>Процессор</span>
          <span>Память</span>
          <span>Канал</span>
          <span>Вердикт</span>
          <span />
        </div>
        {rows.map((r) => (
          <button
            key={r.uuid}
            type="button"
            onClick={() => onSelect(r.uuid)}
            className="group grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 border-t border-border px-4 py-4 text-left text-[13px] transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand xl:grid-cols-[minmax(160px,1.2fr)_80px_repeat(3,minmax(90px,.8fr))_minmax(180px,1.4fr)_20px]"
          >
            <span className="font-medium group-hover:text-brand">
              {r.name}
              <span className="mt-1 block text-xs font-normal text-text-3">
                {r.samples} замеров · {r.days} дн.
              </span>
            </span>
            <span className="tabular-nums">{r.peakOnline?.toLocaleString('ru-RU') ?? '—'}</span>
            {['CPU', 'RAM', 'Канал'].map((resource) => {
              const limit = r.limits.find((l) => l.name === resource);
              return (
                <span key={resource} className="hidden text-text-2 xl:block">
                  {limit ? `≈ ${limit.users.toLocaleString('ru-RU')}` : '—'}
                  <span className="mt-1 block text-xs text-text-3">{limit ? 'онлайн' : 'нет данных'}</span>
                </span>
              );
            })}
            <span className="text-text-2">
              {!r.available
                ? 'Недоступна'
                : r.headroom != null
                  ? `Ещё ≈ ${r.headroom.toLocaleString('ru-RU')} онлайн`
                  : 'Мало данных'}
              <span className="mt-1 block text-xs text-text-3">
                {r.missing.length
                  ? `Нужны: ${r.missing.join(', ')}`
                  : r.bottleneck
                    ? `Первый предел: ${r.bottleneck}`
                    : 'Накопление истории'}
              </span>
            </span>
            <ChevronRightIcon className="size-4 justify-self-end text-text-3 group-hover:text-brand" />
          </button>
        ))}
      </section>
      <details className="rounded-2xl border border-border bg-surface px-4 py-3 text-[12.5px] text-text-2">
        <summary className="cursor-pointer font-medium text-foreground">Как считается</summary>
        <p className="mt-2 leading-relaxed">
          * Максимум среднего онлайна за интервал. Используем парные замеры нагрузки и онлайна от 30
          пользователей. Оценка предполагает похожий профиль нагрузки; до трёх дней наблюдений она
          предварительная. Без CPU или скорости канала общий запас не рассчитывается. Load average не заменяет
          CPU %.
        </p>
      </details>
    </div>
  );
}

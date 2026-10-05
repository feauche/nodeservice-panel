import type { RemnawaveServerReadiness, Server } from '@nodeservice/shared';
import { CheckCircle2Icon, Loader2Icon, TriangleAlertIcon, XCircleIcon } from 'lucide-react';
import { useRemnawaveTopology } from '@/features/remnawave/remnawave-api';
import { cn } from '@/lib/utils';

const colors = {
  ok: 'border-ok/30 bg-ok-soft text-ok',
  warning: 'border-warn/35 bg-warn-soft text-warn',
  error: 'border-crit/35 bg-crit-soft text-crit',
  unknown: 'border-border bg-surface-3 text-text-3',
} as const;

function Readiness({ value }: { value: RemnawaveServerReadiness }) {
  const good = value.items.filter((item) => item.status === 'ok').length;
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold">Сервер готов к VPN</h3>
            <p className="mt-1 text-[11.5px] text-text-3">
              Одна проверка установки, Remnawave, маршрута и оплаты.
            </p>
          </div>
          <span
            className={cn(
              'rounded-full border px-3 py-1.5 text-[11.5px] font-semibold',
              colors[value.status],
            )}
          >
            {good} из {value.items.length} в порядке
          </span>
        </div>
      </section>
      <div className="grid gap-2 sm:grid-cols-2">
        {value.items.map((item) => {
          const Icon =
            item.status === 'ok'
              ? CheckCircle2Icon
              : item.status === 'error'
                ? XCircleIcon
                : TriangleAlertIcon;
          return (
            <article
              key={item.key}
              className="flex min-h-[104px] gap-3 rounded-xl border border-border bg-surface-2/35 p-3.5"
            >
              <span
                className={cn(
                  'grid size-8 flex-none place-items-center rounded-lg border',
                  colors[item.status],
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold">{item.label}</div>
                <p className="mt-1 text-[11.5px] leading-4.5 text-text-2">{item.detail}</p>
                {item.checkedAt && (
                  <div className="mt-1.5 text-[10px] text-text-3">
                    Проверено {new Date(item.checkedAt).toLocaleString('ru-RU')}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function VpnReadinessTab({ server }: { server: Server }) {
  const topology = useRemnawaveTopology();
  if (topology.isPending)
    return (
      <div className="flex items-center gap-2 py-10 text-[12px] text-text-3">
        <Loader2Icon className="size-4 animate-spin" />
        Собираю проверку готовности…
      </div>
    );
  const value = topology.data?.readiness.find((item) => item.serverId === server.id);
  if (!value)
    return (
      <div className="rounded-xl border border-warn/35 bg-warn-soft p-4 text-[12.5px] leading-5 text-warn">
        Не удалось собрать готовность: проверьте подключение Remnawave и обновите её данные.
      </div>
    );
  return <Readiness value={value} />;
}

import { nodeTcpHistorySchema, type TcpCheckReport, tcpCheckReportSchema } from '@nodeservice/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, ExternalLinkIcon, Loader2Icon, RadarIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { TcpResults } from './tcp-results';

const formatTime = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const names = {
  reachable: 'Доступен',
  russia_unreachable: 'Недоступен из России',
  port_unreachable: 'Не отвечает',
  unknown: 'Неполный результат',
};
const tone = (verdict: TcpCheckReport['verdict']) =>
  verdict === 'reachable' ? 'ok' : verdict === 'unknown' ? 'warn' : 'crit';

/**
 * «Доступность порта · Check-Host» в окне ноды: проверка из разных стран, итог по каждому порту последней проверки
 * и история. `runToken` — кнопка «Проверить порт» в паспорте окна: смена числа запускает проверку.
 */
export function NodeTcpCheck({ uuid, runToken = 0 }: { uuid: string; runToken?: number }) {
  const [result, setResult] = useState<TcpCheckReport | null>(null),
    [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ['node-tcp-history', uuid],
    queryFn: ({ signal }) => api.get(`/nodes/${uuid}/tcp-checks`, nodeTcpHistorySchema, signal),
  });
  const m = useMutation({
    mutationFn: () => api.post(`/nodes/${uuid}/tcp-check`, {}, tcpCheckReportSchema),
    onSuccess: (data) => {
      setResult(data);
      void history.refetch();
    },
  });
  const run = () => {
    setResult(null);
    setOpen(true);
    m.mutate();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: запуск только по нажатию кнопки в паспорте окна
  useEffect(() => {
    if (runToken > 0 && !m.isPending) run();
  }, [runToken]);
  const last = history.data?.checks[0]?.report ?? null;
  return (
    <section className="rounded-2xl border border-border bg-surface px-[18px] py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-text-2 uppercase">
            Доступность порта · Check-Host
          </h3>
          <p className="mt-[3px] text-[12px] text-text-3">
            Проверка из разных стран, в том числе из России. Бесплатно, запускаете вы.
          </p>
        </div>
        <button
          type="button"
          disabled={m.isPending}
          onClick={run}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] bg-brand-soft px-3.5 text-[12.5px] font-semibold text-brand transition-[filter] hover:brightness-110 disabled:opacity-60"
        >
          {m.isPending ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <RadarIcon className="size-4" aria-hidden="true" />
          )}
          {m.isPending ? 'Проверяю…' : 'Проверить порт'}
        </button>
      </div>
      {history.isPending ? (
        // Силуэт готового блока: пилюли портов, строка «Последняя проверка» и список последних проверок.
        <div role="status" aria-label="Загрузка проверок" className="mt-3">
          <div className="flex gap-2">
            <Skeleton className="h-[22px] w-48 rounded-full" />
            <Skeleton className="h-[22px] w-40 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3 w-56" />
          <div className="mt-3 border-t border-border pt-2.5">
            <Skeleton className="mb-2 h-3 w-32" />
            {[1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-[40%]" />
                <Skeleton className="ml-auto h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
      ) : history.isError ? (
        <p role="alert" className="mt-3 text-[12.5px] text-crit">
          {apiErrorMessage(history.error)}
        </p>
      ) : last ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {(last.ports?.length ? last.ports : [last]).map((p) => (
              <Pill key={p.target} tone={tone(p.verdict)}>
                {p.target} · {names[p.verdict]}
              </Pill>
            ))}
          </div>
          <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-text-3">
            Последняя проверка {formatTime(last.checkedAt)}
            {last.link && (
              <>
                ·
                <a
                  href={last.link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand hover:text-foreground"
                >
                  Отчёт Check-Host <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </a>
              </>
            )}
          </p>
        </>
      ) : (
        <p className="mt-3 text-[12.5px] text-text-3">Проверок этой ноды ещё не было.</p>
      )}
      {(history.data?.checks.length ?? 0) > 0 && (
        <div className="mt-3 border-t border-border pt-2.5">
          <h4 className="mb-1 text-[12px] font-semibold text-text-2">Последние проверки</h4>
          <div className="max-h-[168px] overflow-y-auto">
            {history.data?.checks.map((entry) => (
              <button
                type="button"
                key={entry.id}
                onClick={() => {
                  setResult(entry.report);
                  setOpen(true);
                }}
                className="flex w-full cursor-pointer items-center gap-3 rounded-[9px] px-2 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 text-[12px] text-text-3">
                  {formatTime(entry.report.checkedAt)}
                </span>
                <Pill tone={tone(entry.report.verdict)}>{names[entry.report.verdict]}</Pill>
                <ChevronRightIcon className="size-3.5 text-text-3" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[760px]">
          <DialogTitle className="pr-10">Проверка порта · Check-Host</DialogTitle>
          <DialogDescription>
            Порт из настроек мониторинга (по умолчанию 5492, при неответе ещё 22) и порт самой ноды. Итог
            «Доступен», если доступен хоть один. История сохраняется в панели.
          </DialogDescription>
          <div className="min-h-0 overflow-y-auto">
            {m.isPending && !result && (
              <p className="py-4 text-[13px] text-text-3" role="status">
                Жду ответы точек. Несколько портов могут занять до двух минут.
              </p>
            )}
            {m.isError && !result && (
              <p role="alert" className="py-3 text-[13px] text-crit">
                {apiErrorMessage(m.error)}
              </p>
            )}
            {result && <TcpResults report={result} />}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

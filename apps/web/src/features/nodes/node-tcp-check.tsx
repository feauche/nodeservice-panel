import { nodeTcpHistorySchema, type TcpCheckReport, tcpCheckReportSchema } from '@nodeservice/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, NetworkIcon } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RowsSkeleton } from '@/components/ui/loading-state';
import { CardButton, Pill } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { TcpResults } from './tcp-results';

const formatTime = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const names = {
  reachable: 'Доступен',
  russia_unreachable: 'Недоступен из РФ',
  port_unreachable: 'Порты не отвечают',
  unknown: 'Неполный результат',
};
export function NodeTcpCheck({ uuid }: { uuid: string }) {
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
  return (
    <section className="overflow-hidden rounded-[12px] border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="grid size-9 place-items-center rounded-[10px] bg-brand-soft text-brand">
          <NetworkIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">Доступность TCP · Check-Host</h3>
          <p className="mt-1 text-[12px] text-text-3">Российские и зарубежные точки · SSH и порт ноды</p>
        </div>
        <CardButton
          className="h-10"
          disabled={m.isPending}
          onClick={() => {
            setResult(null);
            setOpen(true);
            m.mutate();
          }}
        >
          {m.isPending ? 'Проверяю…' : 'Проверить порты'}
        </CardButton>
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-text-2">Последние проверки</h4>
          <span className="text-[11.5px] text-text-3">Результаты также в Журнале</span>
        </div>
        {history.isPending && <RowsSkeleton rows={2} label="Загрузка TCP-проверок" />}
        {history.isError && (
          <p role="alert" className="text-[12px] text-crit">
            {apiErrorMessage(history.error)}
          </p>
        )}
        {history.data?.checks.length === 0 && (
          <p className="text-[12px] text-text-3">Ручных проверок пока нет</p>
        )}
        <div className="max-h-[180px] space-y-1 overflow-y-auto">
          {history.data?.checks.map((entry) => (
            <button
              type="button"
              key={entry.id}
              onClick={() => {
                setResult(entry.report);
                setOpen(true);
              }}
              className="flex w-full cursor-pointer items-center gap-3 rounded-[9px] px-2 py-2 text-left hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 text-[12px] text-text-3">
                {formatTime(entry.report.checkedAt)}
              </span>
              <Pill
                tone={
                  entry.report.verdict === 'reachable'
                    ? 'ok'
                    : entry.report.verdict === 'unknown'
                      ? 'warn'
                      : 'crit'
                }
              >
                {names[entry.report.verdict]}
              </Pill>
              <ChevronRightIcon className="size-3.5 text-text-3" />
            </button>
          ))}
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[760px]">
          <DialogTitle className="pr-10">TCP-проверка · Check-Host</DialogTitle>
          <DialogDescription>
            Основной SSH-порт из настроек, запасной 22 при недоступном 5492 и порт ноды. История сохраняется в
            панели.
          </DialogDescription>
          <div className="min-h-0 overflow-y-auto">
            {m.isPending && !result && (
              <p className="py-4 text-[13px] text-text-3" role="status">
                Ожидаю ответы точек. Несколько портов могут занять до двух минут.
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

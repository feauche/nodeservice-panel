import {
  EGRESS_GROUP_LABELS,
  EGRESS_GROUPS,
  EGRESS_PANEL_CUT,
  type EgressReportDto,
  type EgressResponse,
  egressResponseSchema,
  type Server,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';

import { CountryFlag } from '@/components/country-flag';
import { api, apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useServers } from './servers-api';

/**
 * «Почему агент молчит» (витрина `agent-pending-variants.html`, вариант A): под фактом «Агент» — одна строка
 * с причиной, «Что проверено» раскрывает таблицу «панель / Россия / за рубежом» с «Проверить снова» и
 * текстом для хостера. Проверку делает панель: заходит на сервер (напрямую или через сервер парка, откуда
 * он доступен) и пробует подключиться к панели, в Россию и за рубеж.
 */
const egressKey = (id: string) => ['servers', id, 'egress'] as const;

/** Агент не на связи, и это не «ещё не ставили» и не «ставится прямо сейчас». */
export const agentSilent = (s: Pick<Server, 'agentStatus'>) =>
  s.agentStatus === 'pending' || s.agentStatus === 'offline';

export function useEgress(s: Server) {
  return useQuery({
    queryKey: egressKey(s.id),
    queryFn: ({ signal }): Promise<EgressResponse> =>
      api.get(`/servers/${s.id}/egress`, egressResponseSchema, signal),
    enabled: agentSilent(s),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useRunEgress(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<EgressResponse> => api.post(`/servers/${id}/egress`, {}, egressResponseSchema),
    onSuccess: (data) => qc.setQueryData(egressKey(id), data),
  });
}

/** Агенту физически некуда подключиться — статус в фактах «Нет связи с панелью». */
export const panelCut = (r: EgressReportDto | null | undefined) =>
  Boolean(r && EGRESS_PANEL_CUT.includes(r.verdict));

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Строка под фактом «Агент» в левой панели. */
export function AgentWhy({
  server,
  open,
  onToggle,
}: {
  server: Server;
  open: boolean;
  onToggle: () => void;
}) {
  const q = useEgress(server);
  const run = useRunEgress(server.id);
  if (!agentSilent(server)) return null;
  const report = q.data?.report ?? null;
  const doRun = () =>
    run.mutate(undefined, {
      onSuccess: (d) => {
        if (!d.report) toast.error('Зайти на сервер не удалось ни напрямую, ни через другие серверы парка.');
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  if (!report)
    return (
      <div className="rounded-[10px] bg-surface-2 px-2.5 py-2 text-[12px] leading-normal text-text-2">
        Агент не выходит на связь. Панель может зайти на сервер и проверить, куда он может выйти.{' '}
        <button
          type="button"
          disabled={run.isPending}
          onClick={doRun}
          className="inline-flex cursor-pointer items-center gap-1 font-medium text-brand underline decoration-dotted underline-offset-[3px] disabled:cursor-default disabled:opacity-60"
        >
          {run.isPending && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
          {run.isPending ? 'Проверяю…' : 'Выяснить почему'}
        </button>
      </div>
    );
  return (
    <div
      className={cn(
        'rounded-[10px] px-2.5 py-2 text-[12px] leading-normal text-text-2',
        report.verdict === 'ok' ? 'bg-surface-2' : 'bg-warn-soft',
      )}
      role="status"
    >
      <b className="font-semibold text-foreground">{report.headline}</b> {report.advice}{' '}
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="cursor-pointer font-medium text-brand underline decoration-dotted underline-offset-[3px]"
      >
        {open ? 'Скрыть проверку' : 'Что проверено'}
      </button>
    </div>
  );
}

/** Таблица «Что проверено»: наверху правой панели, над вкладкой. */
export function EgressDetails({ server }: { server: Server }) {
  const q = useEgress(server);
  const run = useRunEgress(server.id);
  const fleet = useServers();
  const report = q.data?.report;
  if (!report) return null;
  const flagOf = (label: string) => fleet.data?.items.find((x) => x.name === label)?.country.code ?? null;
  const copy = () => {
    void navigator.clipboard
      ?.writeText(report.hosterText)
      .then(() => toast.success('Текст для хостера скопирован.'))
      .catch(() => toast.error('Не удалось скопировать — выделите текст вручную.'));
  };
  return (
    <section
      aria-label="Что проверено"
      className="mb-4 rounded-2xl border border-border-2 bg-surface p-4 shadow-pop"
    >
      <h3 className="m-0 font-heading text-[14.5px] font-semibold">
        Что проверено · {hhmm(report.checkedAt)}
        {report.via ? `, через «${report.via}»` : ', с самого сервера'}
      </h3>
      <div className="mt-2.5 grid grid-cols-3 gap-2 max-md:grid-cols-1">
        {EGRESS_GROUPS.map((g) => {
          const rows = report.results.filter((r) => r.group === g);
          return (
            <div
              key={g}
              className="rounded-[10px] border border-border bg-surface-2 px-2.5 py-2 text-[12.5px]"
            >
              <div className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-text-3 uppercase">
                {EGRESS_GROUP_LABELS[g]}
              </div>
              {rows.map((r) => {
                const code = flagOf(r.label);
                return (
                  <div key={r.label} className="flex justify-between gap-2 py-px">
                    <span className="min-w-0 truncate">
                      {code && (
                        <CountryFlag
                          code={code}
                          size="sm"
                          decorative
                          className="mr-1.5 inline-block align-[-1px]"
                        />
                      )}
                      {r.label === 'Панель NodeService' ? 'NodeService' : r.label}
                    </span>
                    <span className={cn('flex-none', r.open ? 'text-ok' : 'text-crit')}>
                      {r.dnsFailed
                        ? 'DNS не отвечает'
                        : r.open
                          ? r.ms !== null
                            ? `${r.ms} мс`
                            : 'открыто'
                          : 'не подключается'}
                    </span>
                  </div>
                );
              })}
              {g === 'panel' && report.panelPing !== null && (
                <div className="flex justify-between gap-2 py-px">
                  <span>Пинг</span>
                  <span className={report.panelPing ? 'text-ok' : 'text-crit'}>
                    {report.panelPing ? 'проходит' : 'не проходит'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={run.isPending}
          onClick={() => run.mutate(undefined, { onError: (err) => toast.error(apiErrorMessage(err)) })}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:text-foreground disabled:cursor-default disabled:opacity-60"
        >
          <RefreshCwIcon className={cn('size-3.5', run.isPending && 'animate-spin')} aria-hidden="true" />
          {run.isPending ? 'Проверяю…' : 'Проверить снова'}
        </button>
        {!(report.verdict === 'ok') && (
          <button
            type="button"
            onClick={copy}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:text-foreground"
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
            Скопировать текст для хостера
          </button>
        )}
      </div>
    </section>
  );
}

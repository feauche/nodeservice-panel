import { INCIDENT_KIND_META, type Incident, type IncidentStatus } from '@nodeservice/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CheckIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { AskAssistant } from '@/features/assistant/ask-assistant';
import { formatWhen } from '@/features/audit/audit-format';
import type { NodeDialogTab } from '@/features/knowledge/markdown';
import { NodeDialog } from '@/features/nodes/node-dialog';
import { useNodes } from '@/features/nodes/nodes-api';
import { TcpResults } from '@/features/nodes/tcp-results';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { plural } from '@/lib/plural';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { Timeline } from './incident-blocks';
import { durationText, outcomeSentence } from './incident-format';
import {
  useAcknowledgeIncident,
  useDeleteIncident,
  useIncident,
  useIncidents,
  useResolveIncident,
} from './incidents-api';

const STATUS_PILL: Record<IncidentStatus, { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }> = {
  open: { tone: 'crit', label: 'Активно' },
  acknowledged: { tone: 'warn', label: 'В работе' },
  resolved: { tone: 'ok', label: 'Завершено' },
};
const SEV_LABEL: Record<Incident['severity'], string> = { crit: 'Критично', warn: 'Внимание', info: 'Инфо' };
/** Кнопки шапки: одна высота, одна рамка, одинаковые отступы — ряд читается как один блок. */
const BTN =
  'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50';

/**
 * Событие как страница-кейс (витрина v3, B1): шапка с действиями, слева описание и хронология,
 * справа сигналы в момент сбоя и похожие случаи.
 */
export function IncidentCasePage({ id }: { id: string }) {
  const q = useIncident(id);
  const all = useIncidents('all');
  const nodes = useNodes();

  const navigate = useNavigate();
  const ack = useAcknowledgeIncident();
  const resolve = useResolveIncident();
  const remove = useDeleteIncident();

  const [confirmResolve, setConfirmResolve] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [nodeTab, setNodeTab] = useState<NodeDialogTab | undefined>();
  const inc = q.data;
  const now = useNow(Boolean(inc && inc.status !== 'resolved'));

  if (q.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[84px] rounded-2xl" />
        <Skeleton className="h-[360px] rounded-2xl" />
      </div>
    );
  if (q.isError || !inc)
    return (
      <div className="flex flex-col items-start gap-3">
        <p
          role="alert"
          className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
        >
          {q.error ? apiErrorMessage(q.error) : 'Событие не найдено.'}
        </p>
        <Link to="/incidents" className={BTN}>
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />К событиям
        </Link>
      </div>
    );

  const meta = INCIDENT_KIND_META[inc.kind];
  const status = STATUS_PILL[inc.status];
  // Нода Remnawave этого события, если она ещё есть в подключении: её окно открывается поверх страницы.
  const node = inc.nodeUuid ? nodes.data?.nodes.find((n) => n.uuid === inc.nodeUuid) : undefined;

  const similar = (all.data?.items ?? []).filter(
    (i) =>
      i.id !== inc.id &&
      (inc.nodeUuid ? i.nodeUuid === inc.nodeUuid : inc.serverId !== null && i.serverId === inc.serverId) &&
      i.kind === inc.kind &&
      now - new Date(i.openedAt).getTime() < 7 * 86_400_000,
  );

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/incidents"
        className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-text-3 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        Все события
      </Link>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Шапка кейса: слева название и мета, справа один ряд кнопок одной высоты */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3 border-b border-border px-5 py-4">
          <span
            className={cn(
              'mt-[7px] size-2.5 flex-none self-start rounded-full',
              inc.severity === 'crit' ? 'bg-crit' : inc.severity === 'warn' ? 'bg-warn' : 'bg-brand',
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 basis-[320px]">
            <h2 className="font-heading text-[17px] leading-[1.25] font-bold tracking-[-0.02em]">
              {inc.title}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-text-3">
              <Pill tone={status.tone}>{status.label}</Pill>
              <span>
                Обнаружено {formatWhen(inc.openedAt)} · {inc.status === 'resolved' ? 'длилось' : 'длится'}{' '}
                {durationText(inc, now).replace('…', '')} · {meta.component} · {SEV_LABEL[inc.severity]}
              </span>
            </p>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <AskAssistant
              target={{
                context: { kind: 'incident', id: inc.id },
                label: `Событие: ${inc.title}`,
                question: node
                  ? `Что случилось с ${node.name} и что проверить?`
                  : 'Что означает это событие и что проверить?',
                placeholder: 'Спросите про это событие…',
              }}
              onOpenNode={(uuid, tab) => {
                if (node && uuid === node.uuid) {
                  setNodeTab(tab);
                  setNodeOpen(true);
                }
              }}
            />
            {node && (
              <button
                type="button"
                onClick={() => {
                  setNodeTab(undefined);
                  setNodeOpen(true);
                }}
                className={BTN}
              >
                <ServerIcon className="size-3.5" aria-hidden="true" />
                Нода
              </button>
            )}
            {inc.status === 'open' && (
              <button
                type="button"
                disabled={ack.isPending}
                onClick={() => void ack.mutateAsync(inc.id)}
                className={BTN}
              >
                Взять в работу
              </button>
            )}
            {inc.status !== 'resolved' && (
              <button
                type="button"
                disabled={resolve.isPending}
                onClick={() => setConfirmResolve(true)}
                className={BTN}
              >
                <CheckIcon className="size-3.5" aria-hidden="true" />
                Закрыть
              </button>
            )}
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => setConfirmDelete(true)}
              className={cn(BTN, 'hover:border-crit/40 hover:bg-crit-soft hover:text-crit')}
            >
              <Trash2Icon className="size-3.5" aria-hidden="true" />
              Удалить
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_300px]">
          {/* Основная колонка */}
          <div className="flex flex-col gap-4 px-5 py-4 md:border-r md:border-border">
            {/* Текст бывает блоками по строкам (падение онлайна: откуда проверяли, вывод) — строки сохраняем. */}
            {inc.diagnostics ? (
              <TcpResults report={inc.diagnostics.report} online={inc.diagnostics.online} />
            ) : (
              <LegacyIncidentDetail detail={inc.detail} outcome={outcomeSentence(inc)} />
            )}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Что происходило
              </h3>
              <Timeline events={inc.timeline} />
            </section>
          </div>

          {/* Правая колонка: короткие значения, цепочка списком — ничего не переносится «в кашу» */}
          <aside className="flex flex-col gap-5 border-t border-border bg-bg-2 px-5 py-4 md:border-t-0">
            <section>
              <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Сигналы в момент сбоя
              </h3>
              {inc.snapshot ? (
                <dl className="text-[12.5px]">
                  <Kv
                    k="Контейнер ноды"
                    v={nodeShort(inc.snapshot.node)}
                    crit={['stopped', 'restarting', 'docker_down'].includes(inc.snapshot.node ?? '')}
                  />
                  <Kv k="CPU" v={pct(inc.snapshot.cpu)} />
                  <Kv k="Память" v={pct(inc.snapshot.mem)} />
                  <Kv k="Диск" v={pct(inc.snapshot.disk)} />
                </dl>
              ) : (
                <p className="text-[12.5px] leading-snug text-text-3">
                  Отдельный снимок ресурсов отсутствует. Данные TCP-проверки показаны в описании, если
                  проверка выполнялась.
                </p>
              )}
            </section>
            <section>
              <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Похожие
              </h3>
              <p className="text-[12.5px] leading-snug text-text-2">
                {similar.length === 0
                  ? 'На этой ноде за 7 дней такого не было.'
                  : `На этой ноде ${similar.length + 1} ${plural(similar.length + 1, 'раз', 'раза', 'раз')} за 7 дней.`}
              </p>
            </section>
          </aside>
        </div>
      </div>

      <ConfirmDialog
        open={confirmResolve}
        onOpenChange={setConfirmResolve}
        title="Закрыть событие?"
        description="Событие будет завершено вручную. Если проблема вернётся — панель создаст новое."
        yesLabel="Закрыть"
        loading={resolve.isPending}
        onConfirm={async () => {
          try {
            await resolve.mutateAsync({ id: inc.id });
            setConfirmResolve(false);
            toast.success('Событие закрыто.');
          } catch (err) {
            setConfirmResolve(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        kind="crit"
        title="Удалить событие?"
        description={
          inc.status === 'resolved'
            ? 'Хронология события пропадёт, итог за 7 дней пересчитается. Записи Журнала остаются.'
            : 'Хронология пропадёт. Если проблема не ушла, панель заведёт новое событие.'
        }
        yesLabel="Удалить"
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(inc.id);
            setConfirmDelete(false);
            toast.success('Событие удалено.');
            void navigate({ to: '/incidents' });
          } catch (err) {
            setConfirmDelete(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
      {nodeOpen && node && (
        <NodeDialog
          node={node}
          stale={Boolean(nodes.data?.error)}
          initialTab={nodeTab}
          onClose={() => setNodeOpen(false)}
        />
      )}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)} %`);
/** Короткое состояние контейнера — длинная подпись из реестра ломает узкую колонку. */
const nodeShort = (v: 'running' | 'restarting' | 'stopped' | 'docker_down' | 'none' | null) =>
  v === 'running'
    ? 'Работает'
    : v === 'restarting'
      ? 'Перезапускается'
      : v === 'docker_down'
        ? 'Docker недоступен'
        : v === 'stopped'
          ? 'Остановлен'
          : v === 'none'
            ? 'Не найден'
            : '—';

function Kv({ k, v, crit }: { k: string; v: string; crit?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border py-[7px] first:border-t-0">
      <dt className="flex-none text-text-3">{k}</dt>
      <dd className={cn('m-0 min-w-0 truncate text-right font-semibold tabular-nums', crit && 'text-crit')}>
        {v}
      </dd>
    </div>
  );
}

function LegacyIncidentDetail({ detail, outcome }: { detail: string; outcome: string }) {
  const lines = detail.split('\n'),
    report = lines.find((l) => /^https:\/\/check-host\.net\/check-report\/[a-zA-Z0-9_-]+$/.test(l));
  if (!report)
    return (
      <p className="text-[13.5px] leading-normal whitespace-pre-line">
        {detail}
        <span className="mt-3 block text-text-3">{outcome}.</span>
      </p>
    );
  const target = lines.find((l) => /^[\d.:[\]a-fA-F]+:\d+$/.test(l));
  return (
    <section className="space-y-3">
      <div className="rounded-[12px] border border-border bg-surface-2 p-4">
        <h3 className="font-heading text-[15px] font-semibold">Результат проверки доступности</h3>
        {target && <p className="mt-2 font-mono text-[14px]">{target}</p>}
        <p className="mt-2 text-[13px] leading-5 text-text-2">
          {lines.filter((l) => l !== report && l !== target).join(' ')}
        </p>
        <a
          href={report}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex h-9 items-center rounded-[9px] border border-border bg-surface px-3 text-[12.5px] text-brand hover:bg-surface-3"
        >
          Открыть отчёт Check-Host ↗
        </a>
      </div>
      <p className="text-[12px] text-text-3">{outcome}.</p>
    </section>
  );
}

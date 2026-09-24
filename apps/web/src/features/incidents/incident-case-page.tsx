import {
  AUTOFIX_POLICY_LABELS,
  actionKeySchema,
  actionMeta,
  INCIDENT_KIND_META,
  type Incident,
  type IncidentStatus,
  NODE_STATE_LABELS,
} from '@nodeservice/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CheckIcon, Loader2Icon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { AttemptBlock, ProposalBlock, Timeline } from './incident-blocks';
import { durationText, outcomeSentence } from './incident-format';
import {
  useAcknowledgeIncident,
  useDeleteIncident,
  useIncident,
  useIncidentPolicy,
  useIncidents,
  useResolveIncident,
  useRunAction,
} from './incidents-api';
import { LevelChip } from './level-chip';

const STATUS_PILL: Record<IncidentStatus, { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }> = {
  open: { tone: 'crit', label: 'Открыт' },
  acknowledged: { tone: 'warn', label: 'В работе' },
  resolved: { tone: 'ok', label: 'Решён' },
};
const SEV_LABEL: Record<Incident['severity'], string> = { crit: 'Критично', warn: 'Внимание', info: 'Инфо' };
const BTN =
  'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50';

/**
 * Инцидент как страница-кейс (витрина v3, B1): шапка с действиями, слева хронология и попытки,
 * справа сигналы в момент сбоя, правило и похожие случаи. «Анализ» — место для ИИ.
 */
export function IncidentCasePage({ id }: { id: string }) {
  const q = useIncident(id);
  const all = useIncidents('all');
  const policy = useIncidentPolicy();
  const navigate = useNavigate();
  const ack = useAcknowledgeIncident();
  const resolve = useResolveIncident();
  const remove = useDeleteIncident();
  const run = useRunAction();
  const [confirmResolve, setConfirmResolve] = useState(false);
  const [stopNodeWatch, setStopNodeWatch] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
          {q.error ? apiErrorMessage(q.error) : 'Инцидент не найден.'}
        </p>
        <Link to="/incidents" className={BTN}>
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />К инцидентам
        </Link>
      </div>
    );

  const meta = INCIDENT_KIND_META[inc.kind];
  const status = STATUS_PILL[inc.status];
  const running = inc.attempts.find((a) => a.status === 'running');
  const canAct = inc.status !== 'resolved' && inc.serverId !== null;
  const canStopNodeWatch = inc.kind === 'node_down' && inc.serverId !== null;
  const rule = policy.data?.items.find((i) => i.kind === inc.kind);
  const similar = (all.data?.items ?? []).filter(
    (i) =>
      i.id !== inc.id &&
      i.serverId === inc.serverId &&
      i.kind === inc.kind &&
      now - new Date(i.openedAt).getTime() < 7 * 86_400_000,
  );
  const lastSimilar = similar[0];
  const lastSimilarHelped = lastSimilar
    ? [...lastSimilar.attempts].reverse().find((a) => a.status === 'helped')
    : undefined;

  const doRun = async (raw: string) => {
    const parsed = actionKeySchema.safeParse(raw);
    if (!parsed.success) {
      toast.error('Этого действия больше нет в реестре — закройте инцидент вручную.');
      return;
    }
    try {
      await run.mutateAsync({ id: inc.id, action: parsed.data });
      toast.success(`«${actionMeta(parsed.data).title}» запущено — ход выполнения ниже.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/incidents"
        className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-text-3 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        Все инциденты
      </Link>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Шапка кейса */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
          <span
            className={cn(
              'size-2.5 flex-none rounded-full',
              inc.severity === 'crit' ? 'bg-crit' : inc.severity === 'warn' ? 'bg-warn' : 'bg-brand',
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 basis-[280px]">
            <h2 className="truncate font-heading text-[17px] font-bold tracking-[-0.01em]">{inc.title}</h2>
            <p className="mt-0.5 text-[12.5px] text-text-3">
              Открыт {formatWhen(inc.openedAt)} · {inc.status === 'resolved' ? 'длился' : 'длится'}{' '}
              {durationText(inc, now).replace('…', '')} · {meta.component} · {SEV_LABEL[inc.severity]}
            </p>
          </div>
          <Pill tone={status.tone}>{status.label}</Pill>
          {canAct && inc.proposal && inc.proposal.level !== 'T3' && !running && (
            <button
              type="button"
              disabled={run.isPending}
              onClick={() => void doRun(inc.proposal?.action ?? '')}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] bg-cta px-3.5 text-[12.5px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover) disabled:opacity-50"
            >
              {run.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              )}
              Подтвердить: {actionMeta(inc.proposal.action).title.toLowerCase()}
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
              Закрыть
            </button>
          )}
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => setConfirmDelete(true)}
            aria-label="Удалить инцидент"
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium text-text-3 transition-colors hover:bg-crit-soft hover:text-crit disabled:opacity-50"
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            Удалить
          </button>
        </div>

        <div className="grid md:grid-cols-[minmax(0,1fr)_300px]">
          {/* Основная колонка */}
          <div className="flex flex-col gap-4 px-5 py-4 md:border-r md:border-border">
            <p className="text-[13.5px] leading-normal">
              {inc.detail} <span className="text-text-2">{outcomeSentence(inc, now)}.</span>
            </p>
            <section>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Что происходило
              </h3>
              <Timeline events={inc.timeline} />
            </section>
            {inc.attempts.length > 0 && (
              <section className="flex flex-col gap-3">
                <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                  Попытки починки
                </h3>
                {inc.attempts.map((a, i) => (
                  <AttemptBlock key={a.id} attempt={a} index={i + 1} />
                ))}
              </section>
            )}
            {canAct && inc.proposal && !running && (
              <ProposalBlock
                incident={inc}
                onRun={() => void doRun(inc.proposal?.action ?? '')}
                busy={run.isPending}
              />
            )}
            <div className="rounded-[12px] border border-dashed border-brand/40 bg-brand-soft/40 px-3.5 py-3 text-[12.5px] text-text-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-brand">
                <SparklesIcon className="size-3.5" aria-hidden="true" />
                Анализ
              </span>{' '}
              — здесь нейросеть объяснит причину по логам ноды и сигналам агента и предложит действие. Пока не
              подключено.
            </div>
          </div>

          {/* Правая колонка */}
          <aside className="flex flex-col gap-5 bg-bg-2 px-5 py-4">
            <section>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Сигналы в момент сбоя
              </h3>
              {inc.snapshot ? (
                <dl className="text-[12.5px]">
                  <Kv
                    k="Контейнер ноды"
                    v={inc.snapshot.node ? NODE_STATE_LABELS[inc.snapshot.node] : 'не проверялся'}
                    crit={inc.snapshot.node === 'stopped'}
                  />
                  <Kv
                    k="Агент"
                    v={agentText(inc.snapshot.agentStatus, inc.snapshot.agentVersion)}
                    crit={inc.snapshot.agentStatus === 'offline'}
                  />
                  <Kv k="CPU" v={pct(inc.snapshot.cpu)} />
                  <Kv k="Память" v={pct(inc.snapshot.mem)} />
                  <Kv k="Диск" v={pct(inc.snapshot.disk)} />
                </dl>
              ) : (
                <p className="text-[12.5px] text-text-3">
                  Снимок сигналов не сохранился: инцидент старше этой возможности.
                </p>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Правило
              </h3>
              {rule ? (
                <p className="text-[12.5px] leading-snug text-text-2">
                  {rule.chain.length === 0 ? (
                    'Панель ничего не может сделать без доступа — только уведомление.'
                  ) : (
                    <>
                      {rule.chain.map((c, i) => (
                        <span key={c.key}>
                          {i > 0 && ' → '}
                          {c.title} <LevelChip level={c.level} />
                        </span>
                      ))}
                      . Политика: {AUTOFIX_POLICY_LABELS[rule.policy].toLowerCase()}.
                    </>
                  )}{' '}
                  <Link to="/incidents/autofix" className="text-brand hover:underline">
                    Изменить
                  </Link>
                </p>
              ) : (
                <Skeleton className="h-[40px] rounded-[8px]" />
              )}
            </section>
            <section>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Похожие
              </h3>
              <p className="text-[12.5px] leading-snug text-text-2">
                {similar.length === 0
                  ? 'На этом сервере за 7 дней такого не было.'
                  : `На этом сервере ${similar.length + 1} ${plural(similar.length + 1)} за 7 дней.${
                      lastSimilarHelped
                        ? ` В прошлый раз помогло: ${actionMeta(lastSimilarHelped.action).title.toLowerCase()}.`
                        : ''
                    }`}
              </p>
            </section>
          </aside>
        </div>
      </div>

      <ConfirmDialog
        open={confirmResolve}
        onOpenChange={(o) => {
          setConfirmResolve(o);
          if (!o) setStopNodeWatch(false);
        }}
        title="Закрыть инцидент?"
        description={
          <>
            Инцидент будет отмечен как решённый вручную. Если проблема вернётся — панель заведёт новый.
            {canStopNodeWatch && (
              <label
                htmlFor="inc-stop-node-watch"
                className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-border bg-surface-2/60 px-3 py-2.5 text-left text-[12.5px] leading-snug text-text-2"
              >
                <Checkbox
                  id="inc-stop-node-watch"
                  checked={stopNodeWatch}
                  onCheckedChange={(v) => setStopNodeWatch(v === true)}
                  className="mt-0.5"
                  aria-label="Больше не следить за нодой на этом сервере"
                />
                <span>
                  <span className="font-medium text-foreground">
                    Больше не следить за нодой на этом сервере
                  </span>
                  <br />
                  Для серверов без ноды или когда нода выключена намеренно. Вернуть можно в карточке сервера.
                </span>
              </label>
            )}
          </>
        }
        yesLabel="Закрыть"
        loading={resolve.isPending}
        onConfirm={async () => {
          try {
            await resolve.mutateAsync({ id: inc.id, ...(stopNodeWatch ? { stopNodeWatch: true } : {}) });
            setConfirmResolve(false);
            setStopNodeWatch(false);
            toast.success(
              stopNodeWatch
                ? 'Инцидент закрыт, за нодой на этом сервере больше не следим.'
                : 'Инцидент закрыт.',
            );
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
        title="Удалить инцидент?"
        description={
          inc.status === 'resolved'
            ? 'Хронология и попытки починки по нему пропадут, статистика «помогло N из M» пересчитается. Записи Журнала остаются.'
            : 'Идущая попытка будет прервана, хронология пропадёт. Если проблема не ушла, панель заведёт новый инцидент.'
        }
        yesLabel="Удалить"
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(inc.id);
            setConfirmDelete(false);
            toast.success('Инцидент удалён.');
            void navigate({ to: '/incidents' });
          } catch (err) {
            setConfirmDelete(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
    </div>
  );
}

const plural = (n: number) => (n === 1 ? 'раз' : n < 5 ? 'раза' : 'раз');
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)} %`);
const agentText = (status: string | null, version: string | null) => {
  if (!status) return '—';
  const label =
    status === 'online'
      ? 'в сети'
      : status === 'offline'
        ? 'не в сети'
        : status === 'installing'
          ? 'устанавливается'
          : status === 'pending'
            ? 'ожидает'
            : 'не установлен';
  return version ? `${label} · v${version.replace(/^v/, '')}` : label;
};

function Kv({ k, v, crit }: { k: string; v: string; crit?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-t border-border py-1.5 first:border-t-0">
      <dt className="text-text-3">{k}</dt>
      <dd className={cn('m-0 font-semibold tabular-nums', crit && 'text-crit')}>{v}</dd>
    </div>
  );
}

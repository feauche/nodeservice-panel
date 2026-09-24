import {
  AUTOFIX_POLICY_LABELS,
  actionKeySchema,
  actionMeta,
  INCIDENT_KIND_META,
  type Incident,
  type IncidentStatus,
} from '@nodeservice/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CheckIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
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
/** Кнопки шапки: одна высота, одна рамка, одинаковые отступы — ряд читается как один блок. */
const BTN =
  'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50';

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
                Открыт {formatWhen(inc.openedAt)} · {inc.status === 'resolved' ? 'длился' : 'длится'}{' '}
                {durationText(inc, now).replace('…', '')} · {meta.component} · {SEV_LABEL[inc.severity]}
              </span>
            </p>
          </div>
          <div className="flex flex-none flex-wrap items-center gap-2">
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
            <div className="flex items-start gap-2.5 rounded-[12px] border border-border bg-surface-2/40 px-3.5 py-3 text-[12.5px] leading-normal text-text-2">
              <SparklesIcon className="mt-[2px] size-3.5 flex-none text-brand" aria-hidden="true" />
              <span>
                <b className="font-semibold text-foreground">Анализ.</b> Здесь нейросеть объяснит причину по
                логам ноды и сигналам агента и предложит действие. Раздел пока не подключён.
              </span>
            </div>
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
                <p className="text-[12.5px] leading-snug text-text-3">
                  Снимок сигналов не сохранился: инцидент старше этой возможности.
                </p>
              )}
            </section>
            <section>
              <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                Правило
              </h3>
              {rule ? (
                rule.chain.length === 0 ? (
                  <p className="text-[12.5px] leading-snug text-text-2">
                    Панель ничего не может сделать без доступа — только уведомление.
                  </p>
                ) : (
                  <>
                    <ol className="flex flex-col gap-1.5 text-[12.5px]">
                      {rule.chain.map((c, i) => (
                        <li key={c.key} className="flex items-center gap-2">
                          <span className="grid size-[18px] flex-none place-items-center rounded-[5px] bg-surface-3 text-[10.5px] font-bold text-text-3 tabular-nums">
                            {i + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-text-2">{c.title}</span>
                          <LevelChip level={c.level} />
                        </li>
                      ))}
                    </ol>
                    <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5 text-[12.5px]">
                      <span className="text-text-3">Политика</span>
                      <span className="font-semibold">{AUTOFIX_POLICY_LABELS[rule.policy]}</span>
                      <Link
                        to="/incidents/autofix"
                        className="ml-auto text-[12px] text-brand hover:underline"
                      >
                        Изменить
                      </Link>
                    </div>
                  </>
                )
              ) : (
                <Skeleton className="h-[64px] rounded-[8px]" />
              )}
            </section>
            <section>
              <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
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
/** Короткое состояние контейнера — длинная подпись из реестра ломает узкую колонку. */
const nodeShort = (v: 'running' | 'stopped' | 'none' | null) =>
  v === 'running' ? 'Работает' : v === 'stopped' ? 'Остановлен' : v === 'none' ? 'Не найден' : '—';
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
    <div className="flex items-baseline justify-between gap-3 border-t border-border py-[7px] first:border-t-0">
      <dt className="flex-none text-text-3">{k}</dt>
      <dd className={cn('m-0 min-w-0 truncate text-right font-semibold tabular-nums', crit && 'text-crit')}>
        {v}
      </dd>
    </div>
  );
}

import {
  ANALYSIS_CONFIDENCE_LABELS,
  ANALYSIS_EVIDENCE_LABELS,
  ANALYSIS_QUESTION_MAX,
  type IncidentAnalysis as AnalysisData,
  actionMeta,
  type Incident,
  isAnalysisStale,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  InfoIcon,
  Loader2Icon,
  RefreshCwIcon,
  SendIcon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';

import { JarvisIcon } from '@/components/jarvis-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useAssistantStatus } from '@/features/assistant/assistant-api';
import { ReachabilityCard } from '@/features/assistant/reachability-card';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useAskAnalysis, useRunAnalysis } from './analysis-api';
import { AnalysisChart, hasAnalysisChart } from './analysis-chart';
import { hhmm } from './incident-format';
import { LevelChip } from './level-chip';

const QUICK_QUESTIONS = ['Как не допустить повтора?', 'Что проверить ещё?', 'Насколько это опасно?'];

const BTN =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50';
const BTN_PRIMARY =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3.5 text-[12.5px] font-semibold whitespace-nowrap text-cta-foreground hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50';

/** Одна рамка для всех состояний: высота не прыгает, когда разбор идёт и заканчивается. */
function Shell({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <section
      data-testid={testId ?? 'analysis-block'}
      aria-label="Анализ"
      className="overflow-hidden rounded-[14px] border border-ai/40 bg-surface bg-[linear-gradient(180deg,var(--ns-ai-soft),transparent_120px)]"
    >
      {children}
    </section>
  );
}

function Head({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 pt-3 text-[12px] text-text-3">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ai">
        <JarvisIcon className="size-3.5" aria-hidden="true" />
        Анализ
      </span>
      {children}
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: 'crit' }) {
  return (
    <p
      className={cn('m-0 px-4 pt-2.5 text-[13px] leading-normal text-text-2', tone === 'crit' && 'text-crit')}
    >
      {children}
    </p>
  );
}

/**
 * «Анализ» в деле инцидента: вывод Джарвиса сверху, шаг из цепочки правил, график и доказательства,
 * вопросы по делу. Джарвис только читает и предлагает; шаг запускает администратор кнопкой.
 */
export function IncidentAnalysis({
  incident,
  canAct,
  attemptRunning,
  runBusy,
  onRun,
}: {
  incident: Incident;
  canAct: boolean;
  attemptRunning: boolean;
  runBusy: boolean;
  onRun: (action: string) => void;
}) {
  const status = useAssistantStatus();
  const start = useRunAnalysis();
  const a = incident.analysis;
  const running = a?.status === 'running';
  const now = useNow(running);

  const launch = async () => {
    try {
      await start.mutateAsync(incident.id);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  if (!a) {
    if (status.isPending)
      return (
        <Shell testId="analysis-loading">
          <Head />
          <div className="px-4 pt-3 pb-4">
            <Skeleton className="h-[64px] rounded-[10px]" />
          </div>
        </Shell>
      );
    if (!status.data?.enabled)
      return (
        <Shell>
          <Head />
          <Note>Чтобы разбирать инциденты, задайте провайдера, модель и ключ Джарвиса.</Note>
          <div className="px-4 pt-3 pb-4">
            <Link to="/settings/assistant" className={BTN}>
              Открыть «Настройки → Джарвис»
            </Link>
          </div>
        </Shell>
      );
    if (!status.data.permissions.analysis)
      return (
        <Shell>
          <Head />
          <Note>Разбор по кнопке выключен в разрешениях Джарвиса.</Note>
          <div className="px-4 pt-3 pb-4">
            <Link to="/settings/assistant" className={BTN}>
              Открыть «Настройки → Джарвис»
            </Link>
          </div>
        </Shell>
      );
    return (
      <Shell>
        <Head />
        <Note>
          Джарвис посмотрит снимок сигналов, историю метрик и попытки починки, назовёт вероятную причину и
          предложит шаг.
        </Note>
        <div className="px-4 pt-3 pb-4">
          <button
            type="button"
            onClick={() => void launch()}
            disabled={start.isPending}
            className={BTN_PRIMARY}
          >
            {start.isPending && <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />}
            Разобрать инцидент
          </button>
        </div>
      </Shell>
    );
  }

  if (running)
    return (
      <Shell>
        <Head>
          <span className="ml-auto tabular-nums">
            {Math.max(0, Math.round((now - Date.parse(a.startedAt)) / 1000))} с
          </span>
        </Head>
        <div className="flex flex-col gap-2 px-4 pt-3" aria-hidden="true">
          <Skeleton className="h-2.5 w-[88%] rounded-[5px]" />
          <Skeleton className="h-2.5 w-[64%] rounded-[5px]" />
        </div>
        <ul
          aria-live="polite"
          aria-label="Ход разбора"
          className="m-0 flex list-none flex-col gap-[7px] px-4 pt-3 pb-4 text-[12.5px]"
        >
          {a.steps.map((s, i) => {
            const current = i === a.steps.length - 1;
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: шаги только добавляются, подпись может повторяться
                key={`${i}-${s}`}
                className={cn('flex items-center gap-2', current ? 'text-foreground' : 'text-text-2')}
              >
                {current ? (
                  <Loader2Icon className="size-3.5 flex-none animate-spin text-ai" aria-hidden="true" />
                ) : (
                  <CheckIcon className="size-3.5 flex-none text-ok" aria-hidden="true" />
                )}
                {s}
              </li>
            );
          })}
        </ul>
      </Shell>
    );

  if (a.status === 'failed')
    return (
      <Shell>
        <Head />
        <Note tone="crit">{a.error ?? 'Не удалось получить ответ Джарвиса.'}</Note>
        <div className="px-4 pt-3 pb-4">
          <button type="button" onClick={() => void launch()} disabled={start.isPending} className={BTN}>
            {start.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
            )}
            Повторить разбор
          </button>
        </div>
      </Shell>
    );

  return (
    <DoneBlock
      incident={incident}
      analysis={a}
      canAct={canAct}
      attemptRunning={attemptRunning}
      runBusy={runBusy}
      onRun={onRun}
      onRestart={() => void launch()}
      restarting={start.isPending}
    />
  );
}

function DoneBlock({
  incident,
  analysis: a,
  canAct,
  attemptRunning,
  runBusy,
  onRun,
  onRestart,
  restarting,
}: {
  incident: Incident;
  analysis: AnalysisData;
  canAct: boolean;
  attemptRunning: boolean;
  runBusy: boolean;
  onRun: (action: string) => void;
  onRestart: () => void;
  restarting: boolean;
}) {
  const ask = useAskAnalysis();
  const status = useAssistantStatus();
  // Пока статус не пришёл, вопросы не прячем; выключенное разрешение убирает вопросы и повторный разбор.
  const canAsk = status.data ? status.data.permissions.analysis : true;
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  // На телефоне доказательства свёрнуты: вывод и шаг с кнопкой должны помещаться на первый экран.
  const [open, setOpen] = useState(
    () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches,
  );
  const stale = isAnalysisStale(a, {
    attempts: incident.attempts.length,
    resolved: incident.status === 'resolved',
  });
  const next = !stale && canAct && a.nextAction ? actionMeta(a.nextAction) : null;
  const hasEvidence = a.evidence.length > 0 || hasAnalysisChart(incident) || Boolean(a.reachability);

  const submit = async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2 || pending) return;
    setPending(q);
    try {
      await ask.mutateAsync({ id: incident.id, question: q });
      setQuestion('');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setPending(null);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(question);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Команда скопирована.');
    } catch {
      toast.error('Не удалось скопировать — выделите команду вручную.');
    }
  };

  return (
    <Shell>
      <Head>
        {a.confidence && (
          <Pill tone={a.confidence === 'high' ? 'ok' : a.confidence === 'medium' ? 'warn' : 'muted'}>
            {ANALYSIS_CONFIDENCE_LABELS[a.confidence]}
          </Pill>
        )}
        {stale && <Pill tone="warn">Устарел</Pill>}
      </Head>

      <p className="mx-4 mt-2 mb-0 font-heading text-[16px] leading-[1.42] font-semibold tracking-[-0.01em]">
        {a.verdict}
      </p>

      {stale && (
        <div className="mx-4 mt-2.5 flex items-start gap-2 text-[12.5px] leading-snug text-text-2">
          <InfoIcon className="mt-0.5 size-3.5 flex-none text-warn" aria-hidden="true" />
          <span>
            С момента разбора{' '}
            {incident.status === 'resolved' ? 'инцидент закрыт' : 'появились новые попытки починки'}. Разбор
            описывает прежнее состояние, разберите заново.
          </span>
        </div>
      )}

      {next && (
        <div
          data-testid="analysis-next"
          className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-[12px] border border-border-2 bg-surface-2 px-3.5 py-2.5"
        >
          <div className="min-w-0 flex-1 basis-[240px]">
            <b className="flex items-center gap-2 text-[13.5px]">
              {next.title}
              <LevelChip level={next.level} />
            </b>
            <small className="mt-0.5 block text-[12px] leading-snug text-text-2">
              {[
                next.consequence
                  ? `${next.consequence[0]?.toUpperCase()}${next.consequence.slice(1)}.`
                  : null,
                next.rollbackNote ? `Откат: ${next.rollbackNote}.` : null,
              ]
                .filter(Boolean)
                .join(' ') || 'Шаг из цепочки правил этого инцидента.'}
            </small>
          </div>
          {next.terminal ? (
            <button type="button" onClick={() => void copy(next.summary)} className={BTN}>
              <CopyIcon className="size-3.5" aria-hidden="true" />
              Копировать команду
            </button>
          ) : (
            <button
              type="button"
              disabled={runBusy || attemptRunning}
              onClick={() => onRun(next.key)}
              className={BTN_PRIMARY}
            >
              {runBusy || attemptRunning ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              )}
              {attemptRunning ? 'Выполняется' : 'Выполнить'}
            </button>
          )}
        </div>
      )}

      {hasEvidence && (
        <div className="mx-4 mt-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase hover:text-foreground"
          >
            Доказательства
            <ChevronDownIcon
              className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
          {open && (
            <div className="mt-2 flex flex-col gap-2.5">
              {hasAnalysisChart(incident) && <AnalysisChart incident={incident} />}
              {a.reachability && <ReachabilityCard result={a.reachability} />}
              {a.evidence.length > 0 && (
                <ul className="m-0 flex list-none flex-col p-0">
                  {a.evidence.map((e, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: доказательства не переупорядочиваются
                      key={i}
                      className="grid grid-cols-1 gap-x-2.5 gap-y-1 border-t border-border py-[7px] text-[13px] first:border-t-0 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-baseline"
                    >
                      <span className="inline-flex h-5 w-fit items-center justify-center rounded-[6px] bg-surface-3 px-2 text-[11px] font-semibold text-text-2">
                        {ANALYSIS_EVIDENCE_LABELS[e.source]}
                      </span>
                      <span>{e.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {a.unknown && (
        <div className="mx-4 mt-2.5 flex items-start gap-2 text-[12.5px] leading-snug text-text-2">
          <InfoIcon className="mt-0.5 size-3.5 flex-none text-text-3" aria-hidden="true" />
          <span>{a.unknown}</span>
        </div>
      )}

      {(a.thread.length > 0 || pending) && (
        <div
          role="log"
          aria-label="Вопросы по разбору"
          className="mx-4 mt-3 flex max-h-[300px] flex-col gap-2 overflow-y-auto"
        >
          {a.thread.map((t) => (
            <div key={t.at} className="flex flex-col gap-2">
              <p className="m-0 max-w-[78%] self-end rounded-[12px_12px_4px_12px] bg-brand-soft px-3 py-2 text-[13px]">
                {t.question}
              </p>
              <p className="m-0 max-w-[92%] whitespace-pre-line rounded-[12px_12px_12px_4px] border border-border bg-surface-2 px-3 py-2 text-[13px] leading-normal">
                {t.answer}
              </p>
            </div>
          ))}
          {pending && (
            <div className="flex flex-col gap-2">
              <p className="m-0 max-w-[78%] self-end rounded-[12px_12px_4px_12px] bg-brand-soft px-3 py-2 text-[13px]">
                {pending}
              </p>
              <Skeleton className="h-9 w-[60%] rounded-[12px]" />
            </div>
          )}
        </div>
      )}

      {canAsk && a.thread.length === 0 && !pending && (
        <div className="mx-4 mt-3 flex flex-wrap gap-1.5">
          {QUICK_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void submit(q)}
              className="inline-flex h-[26px] cursor-pointer items-center rounded-full border border-border bg-surface-2 px-2.5 text-[12px] text-text-2 hover:bg-surface-3 hover:text-foreground"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {!canAsk && (
        <p className="mx-4 mt-3 mb-3.5 text-[12.5px] text-text-3">
          Вопросы по разбору выключены в разрешениях Джарвиса.
        </p>
      )}
      <form onSubmit={onSubmit} hidden={!canAsk} className="mx-4 mt-3 mb-3.5 flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={ANALYSIS_QUESTION_MAX}
          disabled={pending !== null}
          aria-label="Вопрос по этому инциденту"
          placeholder="Спросите про этот инцидент…"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-border bg-surface-2 px-3 text-[13px] text-foreground outline-none placeholder:text-text-3 focus-visible:border-ai/60 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={question.trim().length < 2 || pending !== null}
          className={cn(BTN, 'h-9')}
        >
          {pending !== null ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <SendIcon className="size-3.5" aria-hidden="true" />
          )}
          Спросить
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border bg-surface-2 px-4 py-2 text-[12px] text-text-3">
        <span>
          Разбор в {a.finishedAt ? hhmm(a.finishedAt) : '—'}
          {a.model ? ` · ${a.model}` : ''}
        </span>
        {canAsk && (
          <button
            type="button"
            onClick={onRestart}
            disabled={restarting || pending !== null}
            className={cn(BTN, 'ml-auto h-7 px-2.5 text-[12px]')}
          >
            {restarting ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
            )}
            Разобрать заново
          </button>
        )}
      </div>
    </Shell>
  );
}

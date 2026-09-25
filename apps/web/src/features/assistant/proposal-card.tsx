import {
  type AssistantProposal,
  ATTEMPT_STATUS_LABELS,
  actionKeySchema,
  actionMeta,
  type IncidentAttempt,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { CheckIcon, Loader2Icon, MinusIcon, XIcon } from 'lucide-react';

import { useIncident, useRunAction } from '@/features/incidents/incidents-api';
import { LevelChip } from '@/features/incidents/level-chip';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { capFirst, cn } from '@/lib/utils';

const STEP_LABEL: Record<IncidentAttempt['steps'][number]['key'], string> = {
  precheck: 'Проверка',
  action: 'Действие',
  postcheck: 'Пост-проверка',
  rollback: 'Откат',
};

const BTN =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface px-3 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground';
const BTN_PRIMARY =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3.5 text-[12.5px] font-semibold whitespace-nowrap text-cta-foreground hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50';

function StepIcon({ status, index }: { status: string; index: number }) {
  if (status === 'ok') return <CheckIcon className="size-3.5 text-ok" aria-hidden="true" />;
  if (status === 'running')
    return <Loader2Icon className="size-3.5 animate-spin text-brand" aria-hidden="true" />;
  if (status === 'failed') return <XIcon className="size-3.5 text-crit" aria-hidden="true" />;
  if (status === 'skipped') return <MinusIcon className="size-3.5 text-text-3" aria-hidden="true" />;
  return (
    <span className="grid size-[15px] place-items-center rounded-full bg-surface-3 text-[9.5px] font-bold text-text-3">
      {index + 1}
    </span>
  );
}

/** Ход попытки в переписке: проверка, действие, пост-проверка, откат. */
function AttemptSteps({ attempt }: { attempt: IncidentAttempt }) {
  return (
    <ol
      aria-label="Ход выполнения"
      className="m-0 grid list-none grid-cols-2 overflow-hidden rounded-[10px] border border-border bg-surface p-0 sm:grid-cols-4"
    >
      {attempt.steps.map((s, i) => (
        <li
          key={s.key}
          className={cn(
            'flex min-w-0 flex-col gap-0.5 border-border px-2.5 py-2 text-[12px]',
            i > 0 && 'sm:border-l',
            i % 2 === 1 && 'max-sm:border-l',
            i >= 2 && 'max-sm:border-t',
          )}
        >
          <b className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text-2">
            <StepIcon status={s.status} index={i} />
            {STEP_LABEL[s.key]}
          </b>
          <span className="line-clamp-2 text-[11.5px] leading-snug text-text-3">
            {s.note ?? (s.status === 'pending' ? 'Ждёт очереди' : s.status === 'running' ? 'Идёт…' : '—')}
          </span>
        </li>
      ))}
    </ol>
  );
}

function statePill(attempt: IncidentAttempt | undefined, level: string, blocked: string | null) {
  if (attempt) {
    if (attempt.status === 'running') return <Pill tone="muted">Выполняется</Pill>;
    if (attempt.status === 'helped' || attempt.status === 'done')
      return <Pill tone="ok">{attempt.status === 'done' ? 'Выполнено' : 'Помогло'}</Pill>;
    if (attempt.status === 'not_helped') return <Pill tone="warn">Не помогло</Pill>;
    return <Pill tone="crit">{capFirst(ATTEMPT_STATUS_LABELS[attempt.status])}</Pill>;
  }
  if (blocked) return <Pill tone="muted">Недоступно</Pill>;
  return level === 'T2' ? (
    <Pill tone="warn">Нужно ваше подтверждение</Pill>
  ) : (
    <Pill tone="muted">Готово к запуску</Pill>
  );
}

/**
 * Предложение Джарвиса в переписке (A3): уровень, причина, что будет и что проверится; по кнопке
 * шаг запускает администратор, а ход выполнения показывается здесь же, в карточке. Название и
 * последствия берутся из реестра, поэтому карточка не может пообещать не то, что будет сделано.
 */
export function ProposalCard({ proposal, createdAt }: { proposal: AssistantProposal; createdAt: string }) {
  const meta = actionMeta(proposal.preset);
  const level = proposal.level ?? meta.level;
  const incident = useIncident(proposal.incidentId);
  const run = useRunAction();
  const inc = incident.data;

  // Попытка именно из этой карточки: тот же шаг и запуск позже сообщения.
  const mine = inc?.attempts
    .filter((a) => a.action === proposal.preset && Date.parse(a.startedAt) >= Date.parse(createdAt) - 2_000)
    .at(-1);
  const otherRunning = inc?.attempts.some((a) => a.status === 'running' && a.id !== mine?.id) ?? false;
  const blocked = mine
    ? null
    : incident.isError
      ? 'Инцидента больше нет.'
      : inc?.status === 'resolved'
        ? 'Инцидент уже закрыт.'
        : otherRunning
          ? 'На сервере уже идёт другая попытка, дождитесь её.'
          : null;

  const apply = async () => {
    const key = actionKeySchema.safeParse(proposal.preset);
    if (!key.success) {
      toast.error('Этого действия больше нет в реестре.');
      return;
    }
    try {
      await run.mutateAsync({ id: proposal.incidentId, action: key.data });
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const consequence = meta.consequence
    ? `${meta.consequence[0]?.toUpperCase()}${meta.consequence.slice(1)}.`
    : null;
  const rollback = meta.rollbackNote ? `Откат: ${meta.rollbackNote}.` : null;
  const checks = [
    meta.preconditions.length > 0 ? `Перед запуском проверим: ${meta.preconditions.join(', ')}.` : null,
    meta.postcheck && meta.postcheck !== '—' ? `После: ${meta.postcheck}.` : null,
  ].filter(Boolean);

  return (
    <div
      data-testid="proposal-card"
      className={cn(
        'mt-2.5 flex flex-col gap-2 rounded-[12px] border p-3 text-[13px]',
        level === 'T2'
          ? 'border-warn/45 bg-surface-2 bg-[linear-gradient(180deg,var(--ns-warn-soft),transparent_80%)]'
          : 'border-border-2 bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        {meta.title}
        <LevelChip level={level} />
        <span className="ml-auto">{statePill(mine, level, blocked)}</span>
      </div>
      <p className="m-0 text-[12px] leading-normal text-text-2">
        <b className="font-semibold">Почему:</b> {proposal.reason ?? proposal.description}
      </p>
      {(consequence || rollback) && (
        <p className="m-0 text-[12px] leading-normal text-text-2">
          <b className="font-semibold">Что будет:</b> {[consequence, rollback].filter(Boolean).join(' ')}
        </p>
      )}
      {mine ? (
        <AttemptSteps attempt={mine} />
      ) : (
        checks.length > 0 && <p className="m-0 text-[12px] leading-normal text-text-2">{checks.join(' ')}</p>
      )}
      {blocked && <p className="m-0 text-[12px] text-text-3">{blocked}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {!mine && !blocked && (
          <button type="button" disabled={run.isPending} onClick={() => void apply()} className={BTN_PRIMARY}>
            {run.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <CheckIcon className="size-3.5" aria-hidden="true" />
            )}
            Выполнить
          </button>
        )}
        {!incident.isError && (
          <Link to="/incidents/$id" params={{ id: proposal.incidentId }} className={BTN}>
            Открыть инцидент
          </Link>
        )}
        {mine && (
          <span className="text-[12px] text-text-3">
            {mine.status === 'running'
              ? 'Ход обновляется здесь, инцидент закроется сам, если помогло.'
              : mine.status === 'helped'
                ? 'Инцидент закрыт.'
                : 'Следующий шаг предложен в инциденте.'}
          </span>
        )}
      </div>
    </div>
  );
}

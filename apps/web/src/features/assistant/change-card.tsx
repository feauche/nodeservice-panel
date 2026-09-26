import {
  type AssistantChange,
  type AssistantChangeProposal,
  CHANGE_STATUS_LABELS,
  type ChangeRow,
} from '@nodeservice/shared';
import {
  CheckIcon,
  Loader2Icon,
  PauseIcon,
  RefreshCwIcon,
  ServerIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { LevelChip } from '@/features/incidents/level-chip';
import { formatAgo } from '@/features/security/security-format';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { type ChangeAction, useChange, useChangeAction } from './assistant-api';

const BTN =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface px-3 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50';
const BTN_PRIMARY =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3.5 text-[12.5px] font-semibold whitespace-nowrap text-cta-foreground hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50';

const NIL = '—';
const isList = (r: ChangeRow): boolean => r.added !== undefined || r.removed !== undefined;

/** Значение ячейки: список — плитками (добавленное зелёным, убранное красным и зачёркнутым), иначе текстом. */
function Cell({ row, side }: { row: ChangeRow; side: 'before' | 'after' }) {
  const text = side === 'before' ? row.before : row.after;
  const empty = text === NIL || text === '';
  if (!isList(row)) return empty ? <span className="text-text-3">не задано</span> : text;
  if (empty) return <span className="text-text-3">пусто</span>;
  const marks = new Set((side === 'before' ? row.removed : row.added) ?? []);
  return (
    <>
      {text.split(', ').map((token) => (
        <span
          key={token}
          className={cn(
            'my-px mr-1 inline-flex h-5 items-center rounded-[6px] bg-surface-3 px-1.5 text-[11.5px] font-normal text-foreground',
            marks.has(token) &&
              (side === 'after'
                ? 'bg-ok-soft font-semibold text-ok'
                : 'bg-crit-soft text-crit line-through decoration-crit/60'),
          )}
        >
          {token}
        </span>
      ))}
    </>
  );
}

/** «Что / Было / Станет»: на телефоне строки стопкой, «Было» над «Станет». */
function DiffTable({ rows, dim }: { rows: ChangeRow[]; dim: boolean }) {
  return (
    <table
      className={cn(
        'w-full border-separate border-spacing-0 overflow-hidden rounded-[9px] border border-border bg-surface text-[12.5px]',
        dim && 'opacity-55',
      )}
    >
      <thead className="max-sm:hidden">
        <tr>
          {['Что', 'Было', 'Станет'].map((h) => (
            <th
              key={h}
              scope="col"
              className="border-b border-border bg-surface-2 px-2.5 py-1.5 text-left text-[11px] font-semibold text-text-3"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="sm:[&>tr:first-child>*]:border-t-0">
        {rows.map((r) => (
          <tr
            key={r.label}
            className="max-sm:grid max-sm:grid-cols-1 max-sm:border-t max-sm:border-border max-sm:first:border-t-0"
          >
            <th
              scope="row"
              className="px-2.5 py-2 text-left align-top font-normal text-text-2 sm:w-[27%] sm:border-t sm:border-border max-sm:col-span-full max-sm:pb-0 max-sm:text-[11.5px] max-sm:text-text-3"
            >
              {r.label}
            </th>
            <td className="px-2.5 py-2 align-top break-words text-text-3 sm:border-t sm:border-border max-sm:pt-0.5 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[10.5px] max-sm:before:font-semibold max-sm:before:text-text-3 max-sm:before:content-['Было']">
              <Cell row={r} side="before" />
            </td>
            <td className="bg-ok-soft px-2.5 py-2 align-top font-semibold break-words text-foreground sm:border-t sm:border-border max-sm:pt-0.5 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[10.5px] max-sm:before:font-semibold max-sm:before:text-text-3 max-sm:before:content-['Станет']">
              <Cell row={r} side="after" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TargetChip({ target }: { target: AssistantChange['target'] }) {
  const Icon =
    target.type === 'server' ? ServerIcon : target.type === 'incident' ? TriangleAlertIcon : PauseIcon;
  return (
    <span className="inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-[6px] bg-surface-3 px-1.5 text-[11.5px] font-medium text-text-2">
      <Icon className="size-3 flex-none" aria-hidden="true" />
      <span className="truncate">{target.label}</span>
    </span>
  );
}

function StatePill({ change, applying }: { change: AssistantChange; applying: boolean }) {
  if (applying)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-brand">
        <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
        Применяется
      </span>
    );
  switch (change.status) {
    case 'proposed':
      return change.level === 'T2' ? (
        <Pill tone="warn">Нужно ваше подтверждение</Pill>
      ) : (
        <span className="inline-flex rounded-full bg-brand-soft px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-brand">
          Ждёт подтверждения
        </span>
      );
    case 'applied':
      return <Pill tone="ok">{CHANGE_STATUS_LABELS.applied}</Pill>;
    case 'stale':
      return <Pill tone="warn">{CHANGE_STATUS_LABELS.stale}</Pill>;
    case 'failed':
      return <Pill tone="crit">Ошибка</Pill>;
    default:
      return <Pill tone="muted">{CHANGE_STATUS_LABELS[change.status]}</Pill>;
  }
}

function Meta({
  tone,
  icon,
  children,
}: {
  tone?: 'ok' | 'warn' | 'crit';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 flex-[1_1_220px] items-start gap-1.5 text-[12px] leading-snug text-text-2',
        '[&>svg]:mt-[2px] [&>svg]:size-3.5 [&>svg]:flex-none',
        tone === 'ok' && '[&>svg]:text-ok',
        tone === 'warn' && '[&>svg]:text-warn',
        tone === 'crit' && '[&>svg]:text-crit',
      )}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}

const cardClass = (level: AssistantChange['level']) =>
  cn(
    'mt-2.5 flex flex-col gap-2 rounded-[12px] border p-3 text-[13px]',
    level === 'T2'
      ? 'border-warn/45 bg-surface-2 bg-[linear-gradient(180deg,var(--ns-warn-soft),transparent_80%)]'
      : 'border-border-2 bg-surface-2',
  );

/**
 * Изменение по предложению Джарвиса (J5, вариант A1): таблица «Было / Станет», причина, последствие и кнопки.
 * Состояние берётся с сервера по id, а не из сообщения, поэтому карточка переживает перезагрузку страницы.
 * Панель перед применением заново проверяет состояние и после применения проверяет результат.
 */
export function ChangeCard({ proposal }: { proposal: AssistantChangeProposal }) {
  const query = useChange(proposal.changeId);
  const act = useChangeAction();
  const change = query.data;

  if (!change) {
    return (
      <div data-testid="change-card" data-status="loading" className={cardClass(proposal.level)}>
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          {proposal.title}
          <LevelChip level={proposal.level} />
        </div>
        {query.isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <Meta tone="crit" icon={<XIcon aria-hidden="true" />}>
              Не удалось загрузить состояние изменения.
            </Meta>
            <button type="button" onClick={() => void query.refetch()} className={BTN}>
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              Повторить
            </button>
          </div>
        ) : (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-2/3 rounded-md" />
            <Skeleton className="h-16 rounded-[9px]" />
          </div>
        )}
      </div>
    );
  }

  const mine = act.isPending && act.variables?.id === change.id ? act.variables.action : null;
  const busy = mine !== null;
  const dim = ['rejected', 'reverted', 'stale', 'failed', 'expired'].includes(change.status);

  const run = async (action: ChangeAction) => {
    try {
      const next = await act.mutateAsync({ id: change.id, action });
      if (action === 'apply') {
        if (next.status === 'applied') toast.success('Изменение применено.');
        else toast.warning('Изменение не применено: подробности в карточке.');
      } else if (action === 'revert') toast.success('Изменение отменено.');
      else toast.success('Предложение отклонено.');
    } catch (err) {
      toast.error(apiErrorMessage(err));
      void query.refetch();
    }
  };

  const who = change.decidedBy ?? '—';
  const when = change.decidedAt ? formatAgo(change.decidedAt) : '';

  return (
    <div data-testid="change-card" data-status={change.status} className={cardClass(change.level)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="font-semibold">{change.title}</span>
        <LevelChip level={change.level} />
        <TargetChip target={change.target} />
        <span className="ml-auto">
          <StatePill change={change} applying={mine === 'apply'} />
        </span>
      </div>

      {change.reason && (
        <p className="m-0 text-[12px] leading-normal text-text-2">
          <b className="font-semibold text-foreground">Почему:</b> {change.reason}
        </p>
      )}

      <DiffTable rows={change.rows} dim={dim} />

      {change.status === 'stale' || change.status === 'expired' ? (
        <div className="flex items-start gap-1.5 rounded-[9px] border border-warn/40 bg-warn-soft px-2.5 py-2 text-[12px] leading-normal text-text-2">
          <TriangleAlertIcon className="mt-[2px] size-3.5 flex-none text-warn" aria-hidden="true" />
          <span>
            {change.note ??
              'Состояние изменилось, ничего не применено. Попросите Джарвиса предложить заново.'}
          </span>
        </div>
      ) : (
        change.consequence && (
          <p className="m-0 text-[12px] leading-normal text-text-2">
            <b className="font-semibold text-foreground">Что будет:</b> {change.consequence}
          </p>
        )
      )}

      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        {change.status === 'proposed' && (
          <>
            <button type="button" disabled={busy} onClick={() => void run('apply')} className={BTN_PRIMARY}>
              {mine === 'apply' ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              )}
              {mine === 'apply' ? 'Применяю…' : 'Применить'}
            </button>
            {mine === 'apply' ? (
              <Meta icon={<span aria-hidden="true" />}>Проверяю результат после записи.</Meta>
            ) : (
              <button type="button" disabled={busy} onClick={() => void run('reject')} className={BTN}>
                Отклонить
              </button>
            )}
          </>
        )}
        {change.status === 'applied' && (
          <>
            <Meta tone="ok" icon={<CheckIcon aria-hidden="true" />}>
              Применил {who}, {when}. {change.note}
            </Meta>
            {change.reversible && (
              <button type="button" disabled={busy} onClick={() => void run('revert')} className={BTN}>
                {mine === 'revert' ? (
                  <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Undo2Icon className="size-3.5" aria-hidden="true" />
                )}
                Отменить изменение
              </button>
            )}
          </>
        )}
        {change.status === 'reverted' && (
          <Meta icon={<Undo2Icon aria-hidden="true" />}>
            Отменил {who}, {when}. {change.note}
          </Meta>
        )}
        {change.status === 'rejected' && (
          <Meta icon={<XIcon aria-hidden="true" />}>
            Отклонил {who}, {when}. Ничего не менялось.
          </Meta>
        )}
        {change.status === 'failed' && (
          <Meta tone="crit" icon={<XIcon aria-hidden="true" />}>
            <b className="font-semibold text-foreground">Ошибка.</b> {change.note}
          </Meta>
        )}
      </div>
    </div>
  );
}

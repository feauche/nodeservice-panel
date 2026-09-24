import {
  AUTOFIX_POLICIES,
  AUTOFIX_POLICY_LABELS,
  type AutofixPolicy,
  type IncidentPolicyItem,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, PauseIcon, PlayIcon } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { Pill, Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useIncidentPolicy, useUpdateIncidentPolicy } from './incidents-api';
import { LevelChip } from './level-chip';

/** Группы сигналов на странице: компонент из реестра → заголовок группы. */
const GROUP_OF: Record<string, string> = {
  Нода: 'Нода',
  CPU: 'Ресурсы',
  Память: 'Ресурсы',
  Диск: 'Ресурсы',
  Связь: 'Связь',
};
const GROUP_ORDER = ['Нода', 'Ресурсы', 'Связь'];

/** Цепочка одним предложением: «Поднять контейнер → если не помогло, перезагрузка сервера вручную». */
function chainSentence(item: IncidentPolicyItem): string {
  if (item.chain.length === 0) return 'Панель ничего не может сделать без доступа — только уведомление';
  return item.chain
    .map((c, i) => {
      const t = i === 0 ? c.title : c.title.charAt(0).toLowerCase() + c.title.slice(1);
      const suffix = c.level === 'T3' ? ' вручную' : c.level === 'T2' ? ' с подтверждением' : '';
      return i === 0 ? `${t}${suffix}` : `если не помогло, ${t}${suffix}`;
    })
    .join(' → ');
}

/**
 * «Автопочинка» (витрина v3, C1): политика по сигналам. Панель сама знает цепочку шагов для каждого
 * сигнала, вы выбираете только «Само · Спросить · Наблюдать». Список не разваливается и на десятках сигналов.
 */
export function AutofixPage() {
  const policy = useIncidentPolicy();
  const update = useUpdateIncidentPolicy();
  const now = useNow(Boolean(policy.data?.pausedUntil));

  const patch = async (body: Parameters<typeof update.mutateAsync>[0], okText: string) => {
    try {
      await update.mutateAsync(body);
      toast.success(okText);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  if (policy.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-[64px] rounded-2xl" />
        <Skeleton className="h-[360px] rounded-2xl" />
      </div>
    );
  if (policy.isError)
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(policy.error)}
      </p>
    );
  const data = policy.data;
  const paused = data.pausedUntil && new Date(data.pausedUntil).getTime() > now ? data.pausedUntil : null;
  const pauseLeftMin = paused ? Math.max(1, Math.ceil((new Date(paused).getTime() - now) / 60_000)) : 0;
  const groups = GROUP_ORDER.map((g) => ({
    name: g,
    items: data.items.filter((i) => (GROUP_OF[i.component] ?? 'Ресурсы') === g),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/incidents"
          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Инциденты
        </Link>
        <span className="flex-1" />
        {paused ? (
          <Pill tone="warn">На паузе ещё {pauseLeftMin} мин</Pill>
        ) : (
          <Pill tone={data.autofixEnabled ? 'ok' : 'muted'}>
            {data.autofixEnabled ? 'Включена' : 'Выключена'}
          </Pill>
        )}
        <Toggle
          id="autofix-enabled"
          aria-label="Автопочинка"
          checked={data.autofixEnabled}
          onChange={(v) =>
            void patch({ autofixEnabled: v }, v ? 'Автопочинка включена.' : 'Автопочинка выключена.')
          }
        />
        <button
          type="button"
          disabled={update.isPending || !data.autofixEnabled}
          onClick={() =>
            void patch(
              { pauseMinutes: paused ? 0 : 60 },
              paused
                ? 'Пауза снята.'
                : 'Автопочинка на паузе на час: инциденты заводятся, шаги не выполняются.',
            )
          }
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50"
        >
          {paused ? (
            <PlayIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <PauseIcon className="size-3.5" aria-hidden="true" />
          )}
          {paused ? 'Снять паузу' : 'Приостановить на час'}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {groups.map((g) => (
          <section key={g.name} aria-label={g.name}>
            <h2 className="sticky top-0 z-10 border-t border-border bg-surface-2 px-4 py-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase first:border-t-0">
              {g.name}
            </h2>
            {g.items.map((item) => (
              <PolicyRow
                key={item.kind}
                item={item}
                disabled={update.isPending}
                onChange={(p) =>
                  void patch(
                    { policy: { [item.kind]: p } },
                    `«${item.label}»: ${AUTOFIX_POLICY_LABELS[p].toLowerCase()}.`,
                  )
                }
              />
            ))}
          </section>
        ))}
      </div>
      <p className="text-[12.5px] leading-normal text-text-3">
        «Само» доступно только для безопасных шагов (T1). Для шагов с последствиями панель всегда спросит,
        даже в режиме «Само». Повтор по одному инциденту не чаще раза в {data.cooldownMinutes} мин. Статистика
        за 30 дней.
      </p>
    </div>
  );
}

function PolicyRow({
  item,
  disabled,
  onChange,
}: {
  item: IncidentPolicyItem;
  disabled: boolean;
  onChange: (p: AutofixPolicy) => void;
}) {
  const noChain = item.chain.length === 0;
  return (
    <div
      data-testid="policy-row"
      className="grid grid-cols-1 items-center gap-3 border-t border-border px-4 py-3 md:grid-cols-[minmax(0,1fr)_300px_96px] md:gap-4"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold">
          {item.label}
          {item.chain[0] && <LevelChip level={item.chain[0].level} />}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-text-3">{chainSentence(item)}</div>
      </div>
      <fieldset
        className={cn(
          'm-0 flex gap-[2px] rounded-[9px] border border-border bg-surface-2 p-[2px]',
          noChain && 'opacity-50',
        )}
      >
        <legend className="sr-only">{item.label}: политика</legend>
        {AUTOFIX_POLICIES.map((p) => {
          const on = item.policy === p;
          const blocked = noChain || (p === 'auto' && !item.autoAvailable);
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              aria-label={`${item.label}: ${AUTOFIX_POLICY_LABELS[p]}`}
              disabled={disabled || blocked || on}
              title={
                p === 'auto' && !item.autoAvailable
                  ? 'В цепочке нет безопасного шага, который можно делать самому'
                  : undefined
              }
              onClick={() => onChange(p)}
              className={cn(
                'flex-1 cursor-pointer rounded-[7px] px-2 py-1 text-[11.5px] font-medium text-text-3 transition-colors hover:text-foreground disabled:cursor-default',
                on && 'bg-surface text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]',
                on && p === 'auto' && 'text-ok',
                on && p === 'ask' && 'text-warn',
                blocked && !on && 'opacity-40 hover:text-text-3',
              )}
            >
              {AUTOFIX_POLICY_LABELS[p]}
            </button>
          );
        })}
      </fieldset>
      <div className="text-[12px] text-text-3 tabular-nums md:text-right">
        {item.stats.runs === 0 ? (
          <span>—</span>
        ) : (
          <>
            <b className="text-foreground">
              {item.stats.helped} из {item.stats.runs}
            </b>
            <br />
            помогло
          </>
        )}
      </div>
    </div>
  );
}

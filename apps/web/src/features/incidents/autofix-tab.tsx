import { ACTION_LEVEL_LABELS, INCIDENT_KIND_META, type IncidentActionInfo } from '@nodeservice/shared';
import { toast } from 'sonner';

import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { Toggle } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useIncidentActions, useUpdateIncidentActions } from './incidents-api';
import { LevelChip } from './level-chip';

/**
 * Вкладка «Автопочинка» (витрина R3, вариант 2-2): общий тумблер и карточки действий реестра —
 * уровень, когда применяется, что проверяется до и после, откат, статистика за 30 дней.
 * T1 включаются по одному; T2 всегда ждут «Да»; T3 панель не выполняет.
 */
export function AutofixTab() {
  const actions = useIncidentActions();
  const update = useUpdateIncidentActions();

  const patch = async (body: Parameters<typeof update.mutateAsync>[0], okText: string) => {
    try {
      await update.mutateAsync(body);
      toast.success(okText);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  if (actions.isPending)
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[200px] rounded-2xl" />
        ))}
      </div>
    );
  if (actions.isError)
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(actions.error)}
      </p>
    );
  const data = actions.data;
  const enabledCount = data.items.filter((a) => a.enabled).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-surface px-5 py-4">
        <div className="min-w-0 flex-1 basis-[280px]">
          <div className="text-[14px] font-semibold">Автопочинка</div>
          <div className="mt-0.5 text-[12.5px] leading-normal text-text-3">
            Включено: панель сама выполняет T1-действия с включённым тумблером, T2 предлагает и ждёт «Да».
            Выключено: только заводит инциденты и предлагает шаги. Повтор по одному инциденту не чаще раза в{' '}
            {data.cooldownMinutes} мин.
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-text-3">
            {data.autofixEnabled ? `включена · авто-действий: ${enabledCount}` : 'выключена'}
          </span>
          <Toggle
            id="autofix-global"
            aria-label="Автопочинка"
            checked={data.autofixEnabled}
            onChange={(v) =>
              void patch({ autofixEnabled: v }, v ? 'Автопочинка включена.' : 'Автопочинка выключена.')
            }
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((a) => (
          <ActionCard
            key={a.key}
            action={a}
            globalOn={data.autofixEnabled}
            busy={update.isPending}
            onToggle={(v) =>
              void patch(
                { actions: { [a.key]: v } },
                v ? `«${a.title}»: авто включено.` : `«${a.title}»: авто выключено, будет ждать «Да».`,
              )
            }
          />
        ))}
      </div>
      <p className="px-1 text-[12px] leading-normal text-text-3">
        Если перед запуском не выполняется хоть одно условие, действие само понижается до T2 и ждёт «Да».
        Уровень зашит в реестре, из чата или настроек его не поднять.
      </p>
    </div>
  );
}

function Check({ ok, muted, children }: { ok?: boolean; muted?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px] leading-snug">
      <span
        aria-hidden="true"
        className={cn(
          'mt-[3px] grid size-4 flex-none place-items-center rounded-[5px] text-[10px] font-bold',
          muted ? 'bg-surface-3 text-text-3' : ok ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-text-3',
        )}
      >
        {muted ? '·' : '✓'}
      </span>
      <span className={cn(muted && 'text-text-3')}>{children}</span>
    </div>
  );
}

function ActionCard({
  action: a,
  globalOn,
  busy,
  onToggle,
}: {
  action: IncidentActionInfo;
  globalOn: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
}) {
  const kinds = a.kinds.map((k) => INCIDENT_KIND_META[k].label).join(', ');
  const stat = a.terminal
    ? 'панель не выполняет'
    : a.stats.runs === 0
      ? 'ещё не запускалось'
      : `помогло ${a.stats.helped} из ${a.stats.runs}${a.stats.lastAt ? ` · последний ${formatWhen(a.stats.lastAt)}` : ''}`;
  return (
    <section
      data-testid="action-card"
      className={cn(
        'flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4',
        a.enabled && globalOn && 'border-ok/40',
      )}
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-heading text-[14px] font-bold">{a.title}</h3>
        <LevelChip level={a.level} />
        {a.level === 'T1' ? (
          <Toggle
            id={`act-${a.key}`}
            aria-label={`Авто: ${a.title}`}
            checked={a.enabled}
            onChange={(v) => !busy && onToggle(v)}
          />
        ) : (
          <span className="text-[11.5px] text-text-3">{a.level === 'T2' ? 'только с «Да»' : 'вручную'}</span>
        )}
      </div>
      <div className="text-[12px] text-text-3">
        Когда: {kinds} · {ACTION_LEVEL_LABELS[a.level]}
      </div>
      <div className="rounded-[9px] bg-bg-2 px-2.5 py-1.5 font-mono text-[11.5px] break-all text-text-2">
        {a.summary}
      </div>
      {a.consequence && <div className="text-[12px] text-warn">{a.consequence}</div>}
      {!a.terminal && (
        <div className="flex flex-col gap-1.5">
          <Check ok>Перед: {a.preconditions.join(' · ')}</Check>
          <Check ok>После: {a.postcheck}</Check>
          <Check muted>Откат: {a.rollbackNote ?? 'нет'}</Check>
        </div>
      )}
      <div className="mt-auto border-t border-border pt-2.5 text-[12px] text-text-3">{stat}</div>
    </section>
  );
}

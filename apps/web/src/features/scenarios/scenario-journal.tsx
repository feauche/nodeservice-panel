import {
  type Scenario,
  type ScenarioRun,
  type ScenarioRunStep,
  scenarioActionLabels,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  HourglassIcon,
  PencilIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { dayLabel, hhmm } from '@/features/incidents/incident-format';
import { Pill } from '@/features/settings/settings-ui';
import { cn } from '@/lib/utils';
import { conditionsPhrase, lower } from './scenario-text';

/** Срабатывание и возвраты Host после него (та же нода и тот же сценарий). */
export type JournalEntry = { run: ScenarioRun; backs: ScenarioRun[] };
type Tone = 'ok' | 'warn' | 'crit' | 'teal';
export type RunOutcome = { tone: Tone; label: string; text: string };

const iso = (t: number) => new Date(t).toISOString();
/** Сегодня — «01:06», вчера — «вчера 22:14», раньше — «11 октября 22:14». */
export function when(t: number, now = Date.now()) {
  const day = dayLabel(iso(t), now);
  return day === 'Сегодня' ? hhmm(iso(t)) : `${day.startsWith('Вчера') ? 'вчера' : day} ${hhmm(iso(t))}`;
}

/**
 * Срабатывания для журнала: возврат Host — внутри срабатывания, после которого он был. Само срабатывание старше
 * загруженного списка — возврат остаётся отдельной записью.
 */
export function journalEntries(runs: ScenarioRun[]): JournalEntry[] {
  const entries: JournalEntry[] = runs.filter((r) => r.kind === 'run').map((run) => ({ run, backs: [] }));
  const lone: JournalEntry[] = [];
  for (const b of runs) {
    if (b.kind !== 'restore') continue;
    const owner = entries
      .filter((e) => e.run.ruleId === b.ruleId && e.run.nodeUuid === b.nodeUuid && e.run.t <= b.t)
      .sort((x, y) => y.run.t - x.run.t)[0];
    if (owner) owner.backs.push(b);
    else lone.push({ run: b, backs: [] });
  }
  for (const e of entries) e.backs.sort((x, y) => x.t - y.t);
  return [...entries, ...lone].sort((x, y) => y.run.t - x.run.t);
}

/** Шаг не выполнен. У записей до 0.94.0 отметки нет: красный итог — ошибка, кроме найденного «TCP недоступен». */
const stepFailed = (s: ScenarioRunStep, run: ScenarioRun) =>
  s.failed ?? (run.failed && s.tone === 'crit' && !s.text.startsWith('TCP'));
const backTone = (b: ScenarioRun) =>
  b.steps.some((s) => s.tone === 'crit') ? 'crit' : b.steps.some((s) => s.tone === 'warn') ? 'warn' : 'ok';

/** Условие и сколько оно держалось: с 0.94.0 — из записи, раньше — из заголовка или текущего сценария. */
function runCondition(run: ScenarioRun, rule?: Scenario): [string, number | null] {
  const m = /^Сработал: (.+), (\d+) мин$/.exec(run.title);
  return [
    run.condition ?? m?.[1] ?? (rule ? conditionsPhrase(rule) : 'сценарий сработал'),
    run.holdMinutes ?? (m ? Number(m[2]) : null),
  ];
}

/**
 * Итог срабатывания — плашкой в журнале и фразой в списке сценариев. Самое важное первым: шаг не выполнен,
 * Host не вернули, замечание (Telegram не отправлен), Host изменён и ждёт возврата, всё выполнено. Найденная
 * недоступность TCP добавляется к фразе.
 */
export function runOutcome({ run, backs }: JournalEntry, rule?: Scenario): RunOutcome {
  if (run.kind === 'restore') {
    const t = backTone(run);
    return t === 'crit'
      ? { tone: 'crit', label: 'Host не вернули', text: 'Host не вернули' }
      : t === 'warn'
        ? { tone: 'warn', label: 'Host не возвращали', text: 'Host остался изменённым' }
        : { tone: 'ok', label: 'Host вернули', text: 'Host вернули' };
  }
  const tcp = run.steps.find(
    (s) => (s.action === 'check_tcp' || s.text.startsWith('TCP')) && s.tone === 'crit' && !stepFailed(s, run),
  );
  const say = (o: RunOutcome): RunOutcome => ({
    ...o,
    text: [tcp ? (tcp.word ? `TCP ${tcp.word}` : tcp.text) : '', o.text].filter(Boolean).join(' · '),
  });
  const failed = run.steps.find((s) => stepFailed(s, run));
  if (failed)
    return say({
      tone: 'crit',
      label: 'Шаг не выполнен',
      text: failed.n ? `шаг ${failed.n} не выполнен` : 'шаг не выполнен',
    });
  const back = backs.map(backTone);
  if (back.includes('crit')) return say({ tone: 'crit', label: 'Host не вернули', text: 'Host не вернули' });
  if (back.includes('warn'))
    return say({ tone: 'warn', label: 'Host не возвращали', text: 'Host остался изменённым' });
  const warn = run.steps.find((s) => s.tone === 'warn' && !s.skipped && s.action !== 'check_tcp');
  if (warn)
    return say({
      tone: 'warn',
      label: 'Есть замечание',
      text:
        warn.action && warn.word ? `${lower(scenarioActionLabels[warn.action])}: ${warn.word}` : warn.text,
    });
  if (run.steps.some((s) => s.tone === 'change') && !backs.length)
    return say({
      tone: 'teal',
      label: 'Host изменён',
      text:
        rule && !rule.autoRestore
          ? 'Host изменён, возврат выключен'
          : 'Host изменён, вернётся после восстановления',
    });
  return say({ tone: 'ok', label: 'Выполнено', text: backs.length ? 'Host вернули' : 'все шаги выполнены' });
}
const OUTCOME_ICON: Record<Tone, typeof CheckIcon> = {
  ok: CircleCheckIcon,
  warn: CircleAlertIcon,
  crit: CircleAlertIcon,
  teal: PencilIcon,
};
export const OUTCOME_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  teal: 'bg-teal',
};

/** Квадрат слева от шага: номер (как у сценария в списке), крестик ошибки или значок. */
function Mark({ className, children }: { className: string; children: ReactNode }) {
  return (
    <i
      className={cn(
        'grid size-5 flex-none place-items-center rounded-[6px] text-[11px] font-extrabold not-italic',
        className,
      )}
      aria-hidden="true"
    >
      {children}
    </i>
  );
}
/** У записей до 0.94.0 номеров нет — значок по итогу шага. */
const LEGACY_MARK: Record<ScenarioRunStep['tone'], [string, typeof CheckIcon]> = {
  ok: ['bg-ok-soft text-ok', CheckIcon],
  warn: ['bg-warn-soft text-warn', CircleAlertIcon],
  crit: ['bg-crit-soft text-crit', XIcon],
  change: ['bg-teal/15 text-teal', PencilIcon],
  info: ['bg-surface-3 text-text-2', CheckIcon],
};
function StepMark({ s, failed }: { s: ScenarioRunStep; failed: boolean }) {
  if (failed)
    return (
      <Mark className="bg-crit text-white">
        <XIcon className="size-3" strokeWidth={3} />
      </Mark>
    );
  if (s.n) return <Mark className={s.skipped ? 'bg-surface-3 text-text-3' : 'bg-teal text-bg'}>{s.n}</Mark>;
  const [cls, Icon] = LEGACY_MARK[s.tone];
  return (
    <Mark className={cls}>
      <Icon className="size-3" strokeWidth={2.5} />
    </Mark>
  );
}
const WORD: Record<ScenarioRunStep['tone'], string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  change: 'text-teal',
  info: 'text-foreground',
};
/** «доступен · из РФ 3 из 3, …», «записано в «Нода не на связи»» — событие ссылкой. До 0.94.0 — текст как был. */
function Outcome({ s, failed }: { s: ScenarioRunStep; failed: boolean }) {
  if (!s.word) return <span className={cn(failed && 'text-crit')}>{s.text}</span>;
  const detail = s.detail ?? '';
  const quoted = s.incidentId ? /^(.*?)(«.+»)$/.exec(detail) : null;
  return (
    <>
      <span className={cn('font-semibold', WORD[failed ? 'crit' : s.tone])}>{s.word}</span>
      {detail && (detail.startsWith('в ') ? ' ' : ' · ')}
      {quoted && s.incidentId ? (
        <>
          {quoted[1]}
          <Link
            to="/incidents/$id"
            params={{ id: s.incidentId }}
            className="text-brand underline decoration-brand/40 underline-offset-2 transition-colors hover:decoration-brand"
          >
            {quoted[2]}
          </Link>
        </>
      ) : (
        detail
      )}
    </>
  );
}
function StepLine({
  mark,
  label,
  className,
  children,
}: {
  mark: ReactNode;
  label: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <li className={cn('grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 text-[12.5px] leading-normal', className)}>
      {mark}
      <span className="min-w-0 break-words text-text-2">
        {label && (
          <>
            <b className="font-semibold text-foreground">{label}</b> —{' '}
          </>
        )}
        {children}
      </span>
    </li>
  );
}

/**
 * Срабатывание целиком (витрина scenarios-list-2026-10/runs, вариант B): итог плашкой, шаги с теми же номерами,
 * что у сценария в списке, последней строкой — возврат Host. `latest` — последнее срабатывание этой ноды по этому
 * сценарию: только у него «Вернуть Host — ждёт».
 */
export function RunCard({
  entry,
  rule,
  showRule,
  latest,
}: {
  entry: JournalEntry;
  rule?: Scenario;
  showRule: boolean;
  latest: boolean;
}) {
  const { run, backs } = entry;
  const o = runOutcome(entry, rule);
  const Icon = OUTCOME_ICON[o.tone];
  const lone = run.kind === 'restore';
  const [condition, hold] = runCondition(run, rule);
  const sub = [showRule ? run.ruleName : '', hold ? `держалось ${hold} мин` : ''].filter(Boolean).join(' · ');
  const pending = !lone && latest && !backs.length && rule && run.steps.some((s) => s.tone === 'change');
  const returns = lone ? [run] : backs;
  return (
    <article
      aria-label={`Срабатывание: «${run.nodeName}», ${when(run.t)}`}
      className="border-t border-border px-[18px] py-3.5 [h3+&]:border-t-0"
    >
      <div className="flex items-center gap-2">
        <Pill tone={o.tone}>
          <Icon className="mr-1 size-3" aria-hidden="true" />
          {o.label}
        </Pill>
        <span className="ml-auto text-[12px] whitespace-nowrap text-text-3 tabular-nums">
          {hhmm(iso(run.t))}
        </span>
      </div>
      <h4 className="mt-2 text-[13.5px] leading-snug font-semibold">
        «{run.nodeName}» — {lone ? 'возврат Host' : condition}
      </h4>
      {sub && <p className="mt-0.5 text-[12px] text-text-3">{sub}</p>}
      <ul className="mt-2.5 flex flex-col gap-2">
        {!lone &&
          run.steps.map((s) => (
            <StepLine
              key={`${s.n ?? ''}-${s.action ?? ''}-${s.text}`}
              mark={<StepMark s={s} failed={stepFailed(s, run)} />}
              label={s.action ? scenarioActionLabels[s.action] : null}
            >
              <Outcome s={s} failed={stepFailed(s, run)} />
            </StepLine>
          ))}
        {returns.flatMap((b, bi) =>
          b.steps.map((s, i) => (
            <StepLine
              key={`${b.id}-${s.text}`}
              className={cn(!lone && bi === 0 && i === 0 && 'border-t border-dashed border-border-2 pt-2')}
              mark={
                <Mark className="bg-surface-3 text-text-2">
                  <RotateCcwIcon className="size-3" strokeWidth={2.5} />
                </Mark>
              }
              label={`Вернуть Host · ${hhmm(iso(b.t))}`}
            >
              <Outcome s={s} failed={s.tone === 'crit'} />
            </StepLine>
          )),
        )}
        {pending && (
          <StepLine
            className="border-t border-dashed border-border-2 pt-2"
            mark={
              <Mark className="bg-surface-3 text-text-2">
                <HourglassIcon className="size-3" strokeWidth={2.5} />
              </Mark>
            }
            label="Вернуть Host"
          >
            {rule.autoRestore ? (
              <>
                <span className="font-semibold text-foreground">ждёт</span> · вернётся после восстановления
                ноды
              </>
            ) : (
              <>
                <span className="font-semibold text-warn">не вернётся сам</span> · возврат выключен в сценарии
                — верните Host в Remnawave сами
              </>
            )}
          </StepLine>
        )}
      </ul>
    </article>
  );
}

/** Журнал по дням («Сегодня», «Вчера, 12 октября»), как в «Событиях». */
export function Journal({
  entries,
  rules,
  showRule,
}: {
  entries: JournalEntry[];
  rules: Scenario[];
  showRule: boolean;
}) {
  const now = Date.now();
  const groups: Array<{ label: string; items: JournalEntry[] }> = [];
  for (const e of entries) {
    const label = dayLabel(iso(e.run.t), now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }
  // Последнее срабатывание по каждой паре «сценарий + нода» — у него может быть «Вернуть Host — ждёт».
  const seen = new Set<string>();
  const latest = new Set<string>();
  for (const e of entries) {
    const key = `${e.run.ruleId}:${e.run.nodeUuid}`;
    if (e.run.kind === 'run' && !seen.has(key)) latest.add(e.run.id);
    seen.add(key);
  }
  return (
    <section aria-label="Журнал срабатываний">
      {groups.map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="px-[18px] pt-3.5 pb-0.5 text-[11px] font-bold tracking-[0.08em] text-text-3 uppercase">
            {g.label}
          </h3>
          {g.items.map((e) => (
            <RunCard
              key={e.run.id}
              entry={e}
              rule={rules.find((r) => r.id === e.run.ruleId)}
              showRule={showRule}
              latest={latest.has(e.run.id)}
            />
          ))}
        </section>
      ))}
    </section>
  );
}

export function JournalSkeleton() {
  return (
    <div role="status" aria-label="Загрузка срабатываний">
      <div className="px-[18px] pt-3.5 pb-0.5">
        <Skeleton className="h-3 w-20" />
      </div>
      {[1, 2].map((row) => (
        <div key={row} className={cn('px-[18px] py-3.5', row > 1 && 'border-t border-border')}>
          <div className="flex items-center justify-between">
            <Skeleton className="h-[22px] w-28 rounded-full" />
            <Skeleton className="h-3 w-9" />
          </div>
          <Skeleton className="mt-2.5 h-3.5 w-3/4" />
          <Skeleton className="mt-1.5 h-3 w-1/3" />
          <div className="mt-3 flex flex-col gap-2.5">
            {[1, 2, 3].map((step) => (
              <div key={step} className="flex items-center gap-2.5">
                <Skeleton className="size-5 rounded-[6px]" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

import {
  type JournalEntry,
  type RunTone,
  runOutcome,
  type Scenario,
  type ScenarioRun,
  type ScenarioRunStep,
  scenarioActionLabels,
  stepFailed,
} from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ClockIcon,
  ExternalLinkIcon,
  HourglassIcon,
  PencilIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CountryFlag } from '@/components/country-flag';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { dayLabel, hhmm } from '@/features/incidents/incident-format';
import { plural } from '@/features/overview/overview-format';
import { Pill, Segmented } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { conditionsPhrase } from './scenario-text';
import { type JournalPeriod, useScenarioJournal } from './scenarios-api';

export { type JournalEntry, journalEntries, type RunOutcome, runOutcome } from '@nodeservice/shared';

type Tone = RunTone;

const iso = (t: number) => new Date(t).toISOString();
/** Сегодня — «01:06», вчера — «вчера 22:14», раньше — «11 октября 22:14». */
export function when(t: number, now = Date.now()) {
  const day = dayLabel(iso(t), now);
  return day === 'Сегодня' ? hhmm(iso(t)) : `${day.startsWith('Вчера') ? 'вчера' : day} ${hhmm(iso(t))}`;
}

/** Условие и сколько оно держалось: с 0.94.0 — из записи, раньше — из заголовка или текущего сценария. */
function runCondition(run: ScenarioRun, rule?: Scenario): [string, number | null] {
  const m = /^Сработал: (.+), (\d+) мин$/.exec(run.title);
  return [
    run.condition ?? m?.[1] ?? (rule ? conditionsPhrase(rule) : 'сценарий сработал'),
    run.holdMinutes ?? (m ? Number(m[2]) : null),
  ];
}

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

/** Цвет шага в строке: не вышел, нашёл недоступность, замечание, не выполнялся, выполнен. */
function stepChip(s: ScenarioRunStep, run: ScenarioRun) {
  if (stepFailed(s, run)) return 'bg-crit text-white';
  if (s.skipped) return 'bg-surface-3 text-text-3';
  if (s.tone === 'crit') return 'bg-crit-soft text-crit';
  if (s.tone === 'warn') return 'bg-warn-soft text-warn';
  return 'bg-teal/15 text-teal';
}
const CELL: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit', teal: 'bg-teal' };
const TONE_WORD: Record<Tone, string> = {
  ok: 'выполнено',
  warn: 'есть замечание',
  crit: 'не вышло',
  teal: 'Host изменён',
};

/** Время по поясу панели — как сутки в журнале. */
const clock = (t: number, timeZone: string) =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone }).format(t);
const dayKey = (t: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
/** «Сегодня, 13 октября», «Вчера, 12 октября», «11 октября». */
function dayTitle(key: string, timeZone: string, now = Date.now()) {
  const at = new Date(`${key}T12:00:00Z`);
  const dm = at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  if (key === dayKey(now, timeZone)) return `Сегодня, ${dm}`;
  if (key === dayKey(now - 86_400_000, timeZone)) return `Вчера, ${dm}`;
  return key.slice(0, 4) === dayKey(now, timeZone).slice(0, 4) ? dm : `${dm} ${key.slice(0, 4)}`;
}

/**
 * Полоска последних срабатываний (витрина scenarios-2026-10b): клетка на срабатывание, цвет — итог, старые слева;
 * пустые клетки — срабатываний ещё не было.
 */
export function RunStrip({
  strip,
  slots = 20,
  size = 'md',
  timeZone,
}: {
  strip: ReadonlyArray<{ t: number; tone: Tone }>;
  slots?: number;
  size?: 'sm' | 'md';
  timeZone: string;
}) {
  const cells = [...strip].slice(0, slots).reverse();
  const empty = Math.max(0, slots - cells.length);
  return (
    <div
      role="img"
      aria-label={`Последние срабатывания: ${cells.length ? cells.map((c) => TONE_WORD[c.tone]).join(', ') : 'ещё не было'}`}
      className={cn('flex', size === 'sm' ? 'gap-[2px]' : 'gap-[3px]')}
    >
      {Array.from({ length: empty }, (_, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: пустые клетки одинаковы
          key={`empty-${i}`}
          className={cn('block rounded-[3px] bg-surface-3', size === 'sm' ? 'h-6 w-[6px]' : 'h-10 w-[18px]')}
        />
      ))}
      {cells.map((c) => (
        <i
          key={`${c.t}-${c.tone}`}
          title={`${clock(c.t, timeZone)} · ${TONE_WORD[c.tone]}`}
          className={cn('block rounded-[3px]', CELL[c.tone], size === 'sm' ? 'h-6 w-[6px]' : 'h-10 w-[18px]')}
        />
      ))}
    </div>
  );
}

/**
 * Подробности срабатывания — раскрытая строка: шаги с теми же номерами, что у сценария, последней строкой —
 * возврат Host (или «ждёт»), ссылка на событие. `latest` — последнее срабатывание этой ноды по сценарию: только у
 * него «Вернуть Host — ждёт».
 */
function RunDetails({
  entry,
  rule,
  latest,
  timeZone,
}: {
  entry: JournalEntry;
  rule?: Scenario;
  latest: boolean;
  timeZone: string;
}) {
  const { run, backs } = entry;
  const lone = run.kind === 'restore';
  const [condition, hold] = runCondition(run, rule);
  const pending = !lone && latest && !backs.length && rule && run.steps.some((s) => s.tone === 'change');
  const returns = lone ? [run] : backs;
  const incidentId = run.steps.find((s) => s.incidentId)?.incidentId;
  return (
    <div className="border-t border-border bg-bg-2/40 py-3 pr-4 pl-[70px] max-sm:pl-4">
      {!lone && (
        <p className="mb-2.5 text-[12px] text-text-3">
          Сработал: {condition}
          {hold ? ` · держалось ${hold} мин` : ''}
        </p>
      )}
      <ul className="flex flex-col gap-2">
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
              label={`Вернуть Host · ${clock(b.t, timeZone)}`}
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
                <span className="font-semibold text-warn">ещё помечен</span> · нода не восстановилась —
                вернётся сам
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
      {incidentId && (
        <Link
          to="/incidents/$id"
          params={{ id: incidentId }}
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] text-brand hover:underline"
        >
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          Открыть событие
        </Link>
      )}
    </div>
  );
}

/**
 * Строка срабатывания (витрина scenarios-2026-10b, окно A): итог точкой, время, нода, фраза-итог, шаги цветными
 * номерами и возврат Host плашкой; нажатие раскрывает шаги.
 */
function RunRow({
  entry,
  rule,
  showRule,
  showNode,
  country,
  latest,
  open,
  onToggle,
  timeZone,
  dated = false,
}: {
  entry: JournalEntry;
  rule?: Scenario;
  showRule: boolean;
  showNode: boolean;
  country: string | null;
  latest: boolean;
  open: boolean;
  onToggle: () => void;
  timeZone: string;
  /** Без разделителей по суткам — у времени и дата: «вчера 22:14». */
  dated?: boolean;
}) {
  const { run, backs } = entry;
  const o = runOutcome(entry, rule);
  const lone = run.kind === 'restore';
  const back = backs.at(-1);
  const backFailed = back?.steps.some((s) => s.tone === 'crit');
  const pending = !lone && latest && !backs.length && run.steps.some((s) => s.tone === 'change');
  const numbered = run.steps.filter((s) => s.n).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  return (
    <li className="border-t border-border first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'grid w-full cursor-pointer items-center gap-x-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-md:gap-y-1',
          dated
            ? 'grid-cols-[8px_minmax(44px,auto)_minmax(0,150px)_minmax(0,1fr)_auto_auto_16px] max-md:grid-cols-[8px_minmax(44px,auto)_minmax(0,1fr)_16px]'
            : 'grid-cols-[8px_44px_minmax(0,190px)_minmax(0,1fr)_auto_auto_16px] max-md:grid-cols-[8px_44px_minmax(0,1fr)_16px]',
        )}
      >
        <i className={cn('size-2 rounded-full', OUTCOME_DOT[o.tone])} aria-hidden="true" />
        <span className="text-[13px] whitespace-nowrap text-text-2 tabular-nums">
          {dated ? when(run.t) : clock(run.t, timeZone)}
        </span>
        <span className="flex min-w-0 flex-col">
          {showNode && (
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
              {country && <CountryFlag code={country} size="sm" />}
              <span className="truncate">{run.nodeName}</span>
            </span>
          )}
          {(showRule || !showNode) && (
            <span
              className={cn('truncate', showNode ? 'text-[11.5px] text-text-3' : 'text-[13px] font-medium')}
            >
              {showRule ? run.ruleName : lone ? 'Возврат Host' : o.label}
            </span>
          )}
        </span>
        <span className="truncate text-[12.5px] text-text-3 max-md:col-span-2 max-md:col-start-2 max-md:row-start-2">
          {/* Без ноды в строке слева уже итог словами — фразу не повторяем, если она та же. */}
          {!showNode && !showRule && o.text.toLowerCase() === o.label.toLowerCase() ? '' : o.text}
        </span>
        <span className="flex gap-1 max-md:hidden" aria-hidden="true">
          {numbered.map((s) => (
            <i
              key={`${s.n}-${s.action}`}
              title={s.action ? scenarioActionLabels[s.action] : s.text}
              className={cn(
                'grid size-[22px] place-items-center rounded-[6px] text-[11px] font-extrabold not-italic',
                stepChip(s, run),
              )}
            >
              {s.n}
            </i>
          ))}
        </span>
        <span className="max-md:hidden">
          {back ? (
            <Pill tone={backFailed ? 'crit' : 'teal'}>
              <RotateCcwIcon className="mr-1 size-3" aria-hidden="true" />
              {backFailed ? 'Host не вернули' : 'Host вернули'} · {clock(back.t, timeZone)}
            </Pill>
          ) : pending ? (
            <Pill tone="warn">
              <ClockIcon className="mr-1 size-3" aria-hidden="true" />
              Host ещё помечен
            </Pill>
          ) : null}
        </span>
        <ChevronDownIcon
          className={cn('size-4 text-text-3 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && <RunDetails entry={entry} rule={rule} latest={latest} timeZone={timeZone} />}
    </li>
  );
}

type ToneFilter = 'all' | 'ok' | 'warn' | 'crit';
const TONES_OF: Record<ToneFilter, RunTone[]> = {
  all: [],
  ok: ['ok', 'teal'],
  warn: ['warn'],
  crit: ['crit'],
};

/**
 * Срабатывания порциями (витрина scenarios-2026-10b): в окне сценария — его срабатывания с полоской и числами
 * в шапке; во вкладке «Журнал срабатываний» — все сценарии; в окне ноды — эта нода (`node`). Отбор по итогу,
 * ноде и периоду, разделители по суткам с итогом всего дня, «Показать ещё 20» и честная подпись, сколько всего.
 */
export function RunsPanel({
  rule,
  rules,
  node,
  summary,
  nodes,
  defaultPeriod = '7d',
  initialNode,
  emptyText,
}: {
  rule?: Scenario;
  rules: Scenario[];
  /** Нода закреплена (окно ноды): отбора по ноде нет, имя ноды в строках не нужно. */
  node?: string;
  /** Числа в шапке — из сводки списка; нет — шапки с полоской нет. */
  summary?: { day: number; week: number; weekWarn: number; weekCrit: number } | null;
  nodes: ReadonlyArray<{ uuid: string; name: string; countryCode: string | null }>;
  defaultPeriod?: JournalPeriod;
  /** С какой ноды начать отбор (переход из окна ноды). */
  initialNode?: string;
  emptyText?: string;
}) {
  const [tone, setTone] = useState<ToneFilter>('all');
  const [period, setPeriod] = useState<JournalPeriod>(defaultPeriod);
  const [pickedNode, setPickedNode] = useState<string>(initialNode ?? 'all');
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const nodeFilter = node ?? (pickedNode === 'all' ? undefined : pickedNode);
  const q = useScenarioJournal({
    ...(rule ? { rule: rule.id } : {}),
    ...(nodeFilter ? { node: nodeFilter } : {}),
    tone: TONES_OF[tone],
    period,
  });
  const first = q.data?.pages[0];
  const timeZone = first?.timeZone ?? 'UTC';
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = first?.counts;
  const tally = new Map((first?.days ?? []).map((d) => [d.date, d]));
  // Последнее срабатывание по каждой паре «сценарий + нода» — у него может быть «Вернуть Host — ждёт».
  const seen = new Set<string>();
  const latest = new Set<string>();
  for (const e of items) {
    const key = `${e.run.ruleId}:${e.run.nodeUuid}`;
    if (e.run.kind === 'run' && !seen.has(key)) latest.add(e.run.id);
    seen.add(key);
  }
  const groups: Array<{ day: string; items: typeof items }> = [];
  for (const e of items) {
    const last = groups.at(-1);
    if (last?.day === e.day) last.items.push(e);
    else groups.push({ day: e.day, items: [e] });
  }
  const toggle = (id: string) =>
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const choices =
    rule && rule.scope === 'selected' ? nodes.filter((n) => rule.nodes.includes(n.uuid)) : nodes;
  const total = first?.total ?? 0;
  const rest = Math.max(0, total - items.length);
  return (
    <div className="flex flex-col gap-3">
      {summary && first && (
        <section className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-border bg-surface px-[18px] py-4">
          <div>
            <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
              Последние 20 срабатываний
            </h3>
            <RunStrip strip={first.strip} timeZone={timeZone} />
            <div className="mt-1.5 flex justify-between text-[11.5px] text-text-3">
              <span>раньше</span>
              <span>сейчас</span>
            </div>
          </div>
          <dl className="flex gap-6 text-center">
            {[
              [summary.day, 'за сутки', ''],
              [summary.week, 'за 7 дней', ''],
              [summary.weekWarn, 'с замечанием', summary.weekWarn ? 'text-warn' : ''],
              [summary.weekCrit, 'не вышло', summary.weekCrit ? 'text-crit' : ''],
            ].map(([value, label, cls]) => (
              <div key={label as string}>
                <dd className={cn('font-heading text-[24px] leading-none font-semibold tabular-nums', cls)}>
                  {value}
                </dd>
                <dt className="mt-1.5 text-[11.5px] text-text-3">{label}</dt>
              </div>
            ))}
          </dl>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented<ToneFilter>
          label="Итог срабатывания"
          value={tone}
          onChange={setTone}
          items={[
            { key: 'all', label: <Counted label="Все" n={counts?.all} /> },
            {
              key: 'ok',
              label: <Counted label="Выполнено" n={counts ? counts.ok + counts.teal : undefined} />,
            },
            { key: 'warn', label: <Counted label="С замечаниями" n={counts?.warn} /> },
            ...((counts?.crit ?? 0) > 0 || tone === 'crit'
              ? [{ key: 'crit' as const, label: <Counted label="Не вышло" n={counts?.crit} /> }]
              : []),
          ]}
        />
        {!node && (
          <Select value={pickedNode} onValueChange={setPickedNode}>
            <SelectTrigger aria-label="Нода" className="h-10 w-[220px] max-sm:w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все ноды</SelectItem>
              {choices.map((n) => (
                <SelectItem key={n.uuid} value={n.uuid}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Segmented<JournalPeriod>
          label="Период"
          value={period}
          onChange={setPeriod}
          items={[
            { key: '24h', label: '24 ч' },
            { key: '7d', label: '7 дней' },
            { key: '30d', label: '30 дней' },
          ]}
        />
      </div>
      {q.isPending ? (
        <RunsSkeleton />
      ) : q.isError ? (
        <p
          role="alert"
          className="rounded-2xl border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
        >
          {apiErrorMessage(q.error)}
        </p>
      ) : !items.length ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-3">
          {tone !== 'all' || nodeFilter
            ? 'По этому отбору срабатываний нет.'
            : (emptyText ?? 'Срабатываний за этот период нет.')}
        </p>
      ) : (
        <>
          {groups.map((g) => {
            const t = tally.get(g.day);
            return (
              <section
                key={g.day}
                aria-label={dayTitle(g.day, timeZone)}
                className="overflow-hidden rounded-2xl border border-border bg-surface"
              >
                <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                  <h3 className="text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
                    {dayTitle(g.day, timeZone)}
                  </h3>
                  {t && (
                    <span className="text-[12px] text-text-3">
                      <b className="font-semibold text-text-2">{t.count}</b>{' '}
                      {plural(t.count, 'срабатывание', 'срабатывания', 'срабатываний')}
                      {t.warn > 0 && <span className="text-warn"> · {t.warn} с замечанием</span>}
                      {t.crit > 0 && <span className="text-crit"> · {t.crit} не вышло</span>}
                    </span>
                  )}
                </header>
                <ul>
                  {g.items.map((e) => (
                    <RunRow
                      key={e.run.id}
                      entry={e}
                      rule={rule ?? rules.find((r) => r.id === e.run.ruleId)}
                      showRule={!rule}
                      showNode={!node}
                      country={nodes.find((n) => n.uuid === e.run.nodeUuid)?.countryCode ?? null}
                      latest={latest.has(e.run.id)}
                      open={openIds.has(e.run.id)}
                      onToggle={() => toggle(e.run.id)}
                      timeZone={timeZone}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <div className="flex flex-col items-center gap-2">
            {q.hasNextPage && (
              <button
                type="button"
                onClick={() => void q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
                className="h-10 w-full cursor-pointer rounded-[10px] border border-border bg-surface text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-default disabled:opacity-60"
              >
                {q.isFetchingNextPage ? 'Загружаю…' : `Показать ещё ${Math.min(20, rest)}`}
              </button>
            )}
            <p className="text-[12px] text-text-3">
              Показано {items.length} из {total} · хранятся {first?.retentionDays ?? 30} дней
            </p>
          </div>
        </>
      )}
    </div>
  );
}
function Counted({ label, n }: { label: string; n: number | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {n !== undefined && (
        <i className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold text-text-2 not-italic tabular-nums">
          {n}
        </i>
      )}
    </span>
  );
}
export function RunsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Загрузка срабатываний"
      className="rounded-2xl border border-border bg-surface"
    >
      <div className="border-b border-border px-4 py-2.5">
        <Skeleton className="h-3 w-40" />
      </div>
      {[1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-5 w-24 rounded-[6px]" />
        </div>
      ))}
    </div>
  );
}

/**
 * Короткий список срабатываний без отборов и разделителей (окно ноды, вкладка «Автоматизация»): последние
 * срабатывания сценария на этой ноде; строка раскрывается до шагов, как в журнале.
 */
export function RunList({
  items,
  rule,
  timeZone,
}: {
  items: ReadonlyArray<JournalEntry & { tone: RunTone }>;
  rule: Scenario;
  timeZone: string;
}) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const first = items.find((e) => e.run.kind === 'run');
  return (
    <ul className="overflow-hidden rounded-[12px] border border-border bg-surface">
      {items.map((e) => (
        <RunRow
          key={e.run.id}
          entry={e}
          rule={rule}
          showRule={false}
          showNode={false}
          country={null}
          latest={e.run.id === first?.run.id}
          open={openIds.has(e.run.id)}
          onToggle={() =>
            setOpenIds((cur) => {
              const next = new Set(cur);
              if (next.has(e.run.id)) next.delete(e.run.id);
              else next.add(e.run.id);
              return next;
            })
          }
          timeZone={timeZone}
          dated
        />
      ))}
    </ul>
  );
}

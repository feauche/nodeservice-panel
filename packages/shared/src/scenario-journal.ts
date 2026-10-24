import { z } from 'zod';
import {
  type Scenario,
  type ScenarioRun,
  type ScenarioRunStep,
  scenarioActionLabels,
  scenarioRunSchema,
} from './scenarios.js';

/** Срабатывание и возвраты Host после него (та же нода и тот же сценарий). */
export type JournalEntry = { run: ScenarioRun; backs: ScenarioRun[] };
/** Итог срабатывания: выполнено, есть замечание, не вышло, Host изменён и ждёт возврата. */
export const RUN_TONES = ['ok', 'warn', 'crit', 'teal'] as const;
export type RunTone = (typeof RUN_TONES)[number];
export type RunOutcome = { tone: RunTone; label: string; text: string };

/** Строчная первая буква в середине фразы — только у русского слова: «TCP недоступен» и «Host» не трогаем. */
const lower = (s: string) => (/^[А-ЯЁ][а-яё]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * Срабатывания для журнала: возврат Host — внутри срабатывания, после которого он был. Само срабатывание старше
 * загруженного списка — возврат остаётся отдельной записью. Свежие первыми.
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
  return [...entries, ...lone].sort((x, y) => y.run.t - x.run.t || (y.run.id < x.run.id ? -1 : 1));
}

/** Шаг не выполнен. У записей до 0.94.0 отметки нет: красный итог — ошибка, кроме найденного «TCP недоступен». */
export const stepFailed = (s: ScenarioRunStep, run: ScenarioRun) =>
  s.failed ?? (run.failed && s.tone === 'crit' && !s.text.startsWith('TCP'));
const backTone = (b: ScenarioRun): RunTone =>
  b.steps.some((s) => s.tone === 'crit') ? 'crit' : b.steps.some((s) => s.tone === 'warn') ? 'warn' : 'ok';

/**
 * Итог срабатывания — плашкой в журнале и фразой в списке сценариев. Самое важное первым: шаг не выполнен,
 * Host не вернули, замечание (Telegram не отправлен), Host изменён и ждёт возврата, всё выполнено. Найденная
 * недоступность TCP добавляется к фразе.
 */
export function runOutcome({ run, backs }: JournalEntry, rule?: Pick<Scenario, 'autoRestore'>): RunOutcome {
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
  // Проверка VPN по ключу показала, что VPN не открывается, — к фразе, как недоступный TCP.
  const vpn = run.steps.find((s) => s.action === 'check_dpi' && s.tone === 'crit');
  const say = (o: RunOutcome): RunOutcome => ({
    ...o,
    text: [tcp ? (tcp.word ? `TCP ${tcp.word}` : tcp.text) : '', vpn ? `VPN ${vpn.word}` : '', o.text]
      .filter(Boolean)
      .join(' · '),
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

/** Сколько дней хранятся срабатывания (ScenariosStore.addRun удаляет старше). */
export const SCENARIO_RUNS_RETENTION_DAYS = 30;
/** Период журнала: последние сутки, неделя или все 30 дней. */
export const SCENARIO_JOURNAL_PERIODS = { '24h': 1, '7d': 7, '30d': 30 } as const;

/**
 * Журнал срабатываний порциями: одного сценария (`rule`) или всех, по ноде, за период, по итогам. `before` —
 * курсор следующей порции из прошлого ответа: новые срабатывания сверху её не сдвигают.
 */
export const scenarioJournalQuerySchema = z.object({
  rule: z.uuid().optional(),
  node: z.uuid().optional(),
  /** Итоги через запятую: «warn,crit»; нет — все. */
  tone: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').filter((x): x is RunTone => (RUN_TONES as readonly string[]).includes(x)) : [],
    ),
  period: z.enum(['24h', '7d', '30d']).default('30d'),
  before: z
    .string()
    .regex(/^\d{1,15}\|[\w-]{1,80}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ScenarioJournalQuery = z.input<typeof scenarioJournalQuerySchema>;

const toneSchema = z.enum(RUN_TONES);
export const scenarioJournalSchema = z.object({
  items: z.array(
    z.object({
      run: scenarioRunSchema,
      backs: z.array(scenarioRunSchema),
      tone: toneSchema,
      /** Сутки срабатывания по поясу панели: «2026-10-13» — для разделителей по дням. */
      day: z.string(),
    }),
  ),
  /** Итоги по суткам для всего отбора, а не только загруженной порции: заголовок дня считает весь день. */
  days: z.array(
    z.object({
      date: z.string(),
      count: z.number().int().nonnegative(),
      warn: z.number().int().nonnegative(),
      crit: z.number().int().nonnegative(),
    }),
  ),
  /** Сколько записей подходит под отбор целиком (порция — первые `limit`). */
  total: z.number().int().nonnegative(),
  /** Сколько за период по каждому итогу — для кнопок отбора; отбор по итогу их не меняет. */
  counts: z.object({
    all: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    crit: z.number().int().nonnegative(),
    teal: z.number().int().nonnegative(),
  }),
  /** Последние 20 срабатываний сценария без отборов — полоска в шапке, свежие первыми. */
  strip: z.array(z.object({ t: z.number(), tone: toneSchema })),
  /** Курсор следующей порции; null — дальше записей нет. */
  next: z.string().nullable(),
  retentionDays: z.number().int().positive(),
  /** Пояс панели: сутки (`day`) и время в журнале — по нему. */
  timeZone: z.string(),
});
export type ScenarioJournal = z.infer<typeof scenarioJournalSchema>;

/** Курсор записи: время и id — у срабатываний одной минуты на разных нодах время может совпасть. */
export const journalCursor = (e: JournalEntry) => `${e.run.t}|${e.run.id}`;

/**
 * Порция журнала из всех срабатываний за 30 дней: сценарий и нода — отбор, период — окно, итоги — кнопки,
 * курсор — продолжение. Полоска — последние 20 срабатываний сценария (или всех) без других отборов.
 */
export function journalPage(
  runs: ScenarioRun[],
  q: z.output<typeof scenarioJournalQuerySchema>,
  now = Date.now(),
  timeZone = 'UTC',
): ScenarioJournal {
  const dayOf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const byRule = journalEntries(runs)
    .filter((e) => !q.rule || e.run.ruleId === q.rule)
    .map((e) => ({ ...e, tone: runOutcome(e).tone, day: dayOf.format(e.run.t) }));
  const strip = byRule.slice(0, 20).map((e) => ({ t: e.run.t, tone: e.tone }));
  const since = now - SCENARIO_JOURNAL_PERIODS[q.period] * 86_400_000;
  const inPeriod = byRule.filter((e) => (!q.node || e.run.nodeUuid === q.node) && e.run.t >= since);
  const counts = { all: inPeriod.length, ok: 0, warn: 0, crit: 0, teal: 0 };
  for (const e of inPeriod) counts[e.tone] += 1;
  const matching = q.tone.length ? inPeriod.filter((e) => q.tone.includes(e.tone)) : inPeriod;
  const days = new Map<string, { date: string; count: number; warn: number; crit: number }>();
  for (const e of matching) {
    const d = days.get(e.day) ?? { date: e.day, count: 0, warn: 0, crit: 0 };
    d.count += 1;
    if (e.tone === 'warn') d.warn += 1;
    if (e.tone === 'crit') d.crit += 1;
    days.set(e.day, d);
  }
  const start = q.before ? matching.findIndex((e) => before(e, q.before as string)) : 0;
  const rest = start < 0 ? [] : matching.slice(start);
  const items = rest.slice(0, q.limit);
  const last = items.at(-1);
  return {
    items,
    days: [...days.values()],
    total: matching.length,
    counts,
    strip,
    next: rest.length > q.limit && last ? journalCursor(last) : null,
    retentionDays: SCENARIO_RUNS_RETENTION_DAYS,
    timeZone,
  };
}
/** Запись идёт после курсора в порядке «свежие первыми» (время, затем id по убыванию). */
function before(e: JournalEntry, cursor: string): boolean {
  const [t = '0', id = ''] = cursor.split('|');
  return e.run.t < Number(t) || (e.run.t === Number(t) && e.run.id < id);
}

/** Сводка страницы «Сценарии»: плитки сверху и по строке на сценарий. */
export const scenarioOverviewSchema = z.object({
  /** Пояс панели: время на полосках — по нему, как в журнале. */
  timeZone: z.string(),
  tiles: z.object({
    enabled: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** Срабатываний за сутки. */
    day: z.number().int().nonnegative(),
    /** Сутки по 2 часа — худший итог в каждом промежутке (null — срабатываний не было), старые первыми. */
    daySlots: z.array(toneSchema.nullable()),
    /** За 7 дней: всего, с замечанием, не вышло. */
    week: z.number().int().nonnegative(),
    weekWarn: z.number().int().nonnegative(),
    weekCrit: z.number().int().nonnegative(),
    /** Сколько пар «сценарий + нода» держат Host изменённым и вернут его после восстановления. */
    marked: z.number().int().nonnegative(),
  }),
  items: z.array(
    z.object({
      ruleId: z.string(),
      last: z.object({ t: z.number(), nodeName: z.string(), tone: toneSchema, text: z.string() }).nullable(),
      day: z.number().int().nonnegative(),
      /** С замечанием или не вышло — за сутки. */
      dayWarn: z.number().int().nonnegative(),
      week: z.number().int().nonnegative(),
      /** За 7 дней: с замечанием и не вышло — числа в шапке «Срабатываний». */
      weekWarn: z.number().int().nonnegative(),
      weekCrit: z.number().int().nonnegative(),
      strip: z.array(z.object({ t: z.number(), tone: toneSchema })),
    }),
  ),
});
export type ScenarioOverview = z.infer<typeof scenarioOverviewSchema>;

const TONE_RANK: Record<RunTone, number> = { ok: 0, teal: 1, warn: 2, crit: 3 };
/**
 * Сводка для списка сценариев из срабатываний за 30 дней: по каждому сценарию последнее срабатывание, числа за
 * сутки и неделю, полоска последних 20; сверху — включено, за сутки (по 2 часа), за неделю с замечаниями и сколько
 * Host помечено сейчас (`marked` — из состояний сценариев).
 */
export function scenarioOverview(
  rules: ReadonlyArray<Pick<Scenario, 'id' | 'enabled' | 'autoRestore'>>,
  runs: ScenarioRun[],
  marked: number,
  now = Date.now(),
  timeZone = 'UTC',
): ScenarioOverview {
  const DAY = 86_400_000;
  const entries = journalEntries(runs).filter((e) => e.run.kind === 'run');
  const toned = entries.map((e) => {
    const rule = rules.find((r) => r.id === e.run.ruleId);
    return { ...e, outcome: runOutcome(e, rule) };
  });
  const dayAgo = now - DAY,
    weekAgo = now - 7 * DAY;
  const daySlots: Array<RunTone | null> = Array(12).fill(null);
  let week = 0,
    weekWarn = 0,
    weekCrit = 0,
    day = 0;
  for (const e of toned) {
    if (e.run.t >= weekAgo) {
      week += 1;
      if (e.outcome.tone === 'warn') weekWarn += 1;
      if (e.outcome.tone === 'crit') weekCrit += 1;
    }
    if (e.run.t >= dayAgo && e.run.t <= now) {
      day += 1;
      const slot = Math.min(11, Math.floor((e.run.t - dayAgo) / (2 * 3_600_000)));
      const cur = daySlots[slot];
      if (cur == null || TONE_RANK[e.outcome.tone] > TONE_RANK[cur]) daySlots[slot] = e.outcome.tone;
    }
  }
  return {
    timeZone,
    tiles: {
      enabled: rules.filter((r) => r.enabled).length,
      total: rules.length,
      day,
      daySlots,
      week,
      weekWarn,
      weekCrit,
      marked,
    },
    items: rules.map((r) => {
      const mine = toned.filter((e) => e.run.ruleId === r.id);
      const first = mine[0];
      const inDay = mine.filter((e) => e.run.t >= dayAgo);
      return {
        ruleId: r.id,
        last: first
          ? {
              t: first.run.t,
              nodeName: first.run.nodeName,
              tone: first.outcome.tone,
              text: first.outcome.text,
            }
          : null,
        day: inDay.length,
        dayWarn: inDay.filter((e) => e.outcome.tone === 'warn' || e.outcome.tone === 'crit').length,
        week: mine.filter((e) => e.run.t >= weekAgo).length,
        weekWarn: mine.filter((e) => e.run.t >= weekAgo && e.outcome.tone === 'warn').length,
        weekCrit: mine.filter((e) => e.run.t >= weekAgo && e.outcome.tone === 'crit').length,
        strip: mine.slice(0, 20).map((e) => ({ t: e.run.t, tone: e.outcome.tone })),
      };
    }),
  };
}

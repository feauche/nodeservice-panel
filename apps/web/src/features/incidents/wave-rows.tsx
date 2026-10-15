import { type Incident, type IncidentSnapshot, WAVE_EXPLAIN, WAVE_KINDS } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, InfoIcon, WavesIcon } from 'lucide-react';
import { CountryFlag } from '@/components/country-flag';
import { Pill } from '@/features/settings/settings-ui';
import { cn } from '@/lib/utils';
import { durationText, hhmm, titleOnly } from './incident-format';

type Member = NonNullable<IncidentSnapshot['fleet']>['members'][number];

const isWaveKind = (kind: string) => (WAVE_KINDS as readonly string[]).includes(kind);

/** «2 ноды», «5 нод». */
export function nodesWord(n: number): string {
  const m10 = n % 10,
    m100 = n % 100;
  return m10 === 1 && m100 !== 11
    ? 'нода'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
      ? 'ноды'
      : 'нод';
}

/**
 * Открытые события с волнами (витрина wave-maintenance-2026-10, раздел 3 — C): события нод открытой волны не
 * повторяются в общем списке — они под строкой волны. Возвращает список без них и события нод по волнам.
 */
export function planWaves(open: Incident[]): { items: Incident[]; members: Map<string, Incident[]> } {
  const members = new Map<string, Incident[]>();
  const taken = new Set<string>();
  for (const w of open.filter((i) => i.kind === 'wave')) {
    const fleet = w.snapshot?.fleet;
    if (!fleet) continue;
    const mine: Incident[] = [];
    for (const m of fleet.members) {
      const own = open.filter(
        (i) =>
          i.kind !== 'wave' &&
          !taken.has(i.id) &&
          (i.id === m.incidentId || (!m.upAt && i.nodeUuid === m.nodeUuid && isWaveKind(i.kind))),
      );
      for (const i of own) taken.add(i.id);
      mine.push(...own);
    }
    members.set(w.id, mine);
  }
  return { items: open.filter((i) => !taken.has(i.id)), members };
}

/** Длительность ноды в волне: «19 мин», «1 ч 5 мин»; пока лежит — с многоточием. */
function memberDuration(m: Member, now: number): string {
  const end = m.upAt ? Date.parse(m.upAt) : now;
  const min = Math.max(0, Math.round((end - Date.parse(m.downAt ?? new Date(now).toISOString())) / 60_000));
  const text = min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
  return m.upAt ? text : `${text}…`;
}

const ROW =
  'grid grid-cols-[3px_52px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-border py-2.5 pr-3 transition-colors md:min-h-[59px] md:grid-cols-[3px_56px_170px_minmax(0,1fr)_auto_84px] md:gap-x-4 md:py-1.5';

/**
 * Волна в реестре: строка-заголовок с фиолетовой кромкой, под ней ноды с отступом. Идёт — ноды видны всегда;
 * закончилась — свёрнута в одну строку, ноды раскрываются стрелкой.
 */
export function WaveBlock({
  wave,
  members,
  now,
  height,
  expanded,
  onToggle,
}: {
  wave: Incident;
  /** События нод из открытого списка — у идущей волны; у закончившейся ноды берутся из самой волны. */
  members: Incident[];
  now: number;
  height?: number | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const fleet = wave.snapshot?.fleet;
  const list = fleet?.members ?? [];
  const active = wave.status !== 'resolved';
  const open = active || expanded;
  const down = list.filter((m) => !m.upAt).length;
  const total = fleet?.total ?? list.length;
  const what = active
    ? `${down} из ${total} ${fleet?.cause === 'country' ? 'нод страны' : 'нод'} не на связи`
    : `${list.length} из ${total} нод ${list.length === 1 ? 'была' : 'были'} не на связи`;
  return (
    <div data-testid="wave-block">
      <div
        data-testid="incident-row"
        style={height ? { minHeight: height } : undefined}
        className={cn(ROW, 'relative bg-ai/[0.05] hover:bg-ai/[0.08]')}
      >
        <span className="h-full min-h-9 w-[3px] rounded-r-[2px] bg-ai" aria-hidden="true" />
        <span className="text-[12.5px] text-text-3 tabular-nums" title={`Началась ${hhmm(wave.openedAt)}`}>
          {hhmm(list[0]?.downAt ?? wave.openedAt)}
        </span>
        <span className="hidden min-w-0 items-center gap-2 md:flex">
          {!active && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Свернуть' : 'Раскрыть'} ноды волны`}
              onClick={onToggle}
              className="relative z-10 -ml-1 grid size-6 flex-none cursor-pointer place-items-center rounded-[7px] text-text-3 hover:bg-surface-3 hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn('size-4 transition-transform', expanded && 'rotate-90')}
                aria-hidden="true"
              />
            </button>
          )}
          <span className="grid size-[26px] flex-none place-items-center rounded-[8px] bg-ai/15 text-ai">
            <WavesIcon className="size-3.5" aria-hidden="true" />
          </span>
          <span className="truncate text-[13px] font-semibold">{wave.title}</span>
          <span
            role="img"
            title={WAVE_EXPLAIN}
            aria-label="Что такое волна"
            className="relative z-10 flex-none cursor-help text-text-3"
          >
            <InfoIcon className="size-3.5" aria-hidden="true" />
          </span>
        </span>
        <Link to="/incidents/$id" params={{ id: wave.id }} className="min-w-0 after:absolute after:inset-0">
          <span className="block text-[13px] font-semibold max-md:line-clamp-2 md:truncate">{what}</span>
          <span className="block text-[12.5px] text-text-3 md:hidden">{wave.title}</span>
          <span className="block text-[12.5px] text-text-2 md:truncate">
            {list.map((m) => m.name).join(', ')}
          </span>
        </Link>
        <span className="flex items-center gap-1.5 max-md:self-start">
          <Pill tone={active ? 'crit' : 'ok'}>{active ? 'Активно' : 'Завершено'}</Pill>
        </span>
        <span className="hidden text-right text-[12.5px] text-text-3 tabular-nums md:block">
          {durationText(wave, now)}
        </span>
      </div>
      {open &&
        list.map((m, i) => {
          const inc =
            members.find((x) => x.id === m.incidentId) ?? members.find((x) => x.nodeUuid === m.nodeUuid);
          const last = i === list.length - 1;
          const to = inc?.id ?? m.incidentId;
          const row = (
            <>
              <span className="h-full min-h-8 w-[3px]" aria-hidden="true" />
              <span className="text-[12.5px] text-text-3 tabular-nums">{m.downAt ? hhmm(m.downAt) : ''}</span>
              <span className="relative hidden min-w-0 items-center gap-2 pl-6 md:flex">
                {/* Ветка дерева от строки волны к ноде. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-[-14px] left-2 w-3 rounded-bl-[6px] border-b-[1.5px] border-l-[1.5px] border-ai/45',
                    'h-[calc(50%+14px)]',
                  )}
                />
                {!last && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 bottom-[-14px] left-2 border-l-[1.5px] border-ai/45"
                  />
                )}
                {m.countryCode && <CountryFlag code={m.countryCode} size="md" />}
                <span className="truncate text-[13px] font-semibold">{m.name}</span>
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold md:truncate">
                  <span className="md:hidden">{m.name} · </span>
                  {inc ? titleOnly(inc) : 'Нода не на связи'}
                </span>
                <span className="block text-[12.5px] text-text-3 md:truncate">
                  {m.upAt ? `Снова на связи в ${hhmm(m.upAt)}` : 'Remnawave не видит ноду'}
                </span>
              </span>
              <span className="flex items-center max-md:self-start">
                <Pill tone={m.upAt ? 'ok' : 'crit'}>{m.upAt ? 'Завершено' : 'Активно'}</Pill>
              </span>
              <span className="hidden text-right text-[12.5px] text-text-3 tabular-nums md:block">
                {memberDuration(m, now)}
              </span>
            </>
          );
          return to ? (
            <Link
              key={m.nodeUuid ?? i}
              to="/incidents/$id"
              params={{ id: to }}
              data-testid="wave-member"
              className={cn(ROW, 'bg-ai/[0.025] hover:bg-surface-2 md:min-h-[52px]')}
            >
              {row}
            </Link>
          ) : (
            <div
              key={m.nodeUuid ?? i}
              data-testid="wave-member"
              className={cn(ROW, 'bg-ai/[0.025] md:min-h-[52px]')}
            >
              {row}
            </div>
          );
        })}
    </div>
  );
}

/** Блок «Что такое волна» на странице волны — чтобы было понятно без справки. */
export function WaveExplain({ inc }: { inc: Incident }) {
  const fleet = inc.snapshot?.fleet;
  return (
    <section
      aria-label="Что такое волна"
      className="flex gap-3 rounded-[14px] border border-ai/35 bg-ai/[0.06] px-4 py-3.5"
    >
      <span className="grid size-9 flex-none place-items-center rounded-[10px] bg-ai/15 text-ai">
        <WavesIcon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 text-[13px] leading-relaxed text-text-2">
        <b className="block text-[13.5px] font-semibold text-foreground">Что такое волна</b>
        {WAVE_EXPLAIN}
        {fleet?.cause === 'country' && (
          <span className="mt-1 block text-[12.5px] text-text-3">
            У этих нод не указан провайдер, поэтому они собраны по стране. Провайдер ноды задаётся в окне ноды
            на вкладке «Настройки».
          </span>
        )}
        <span className="mt-1 block text-[12.5px] text-text-3">
          У каждой ноды осталось своё событие с подробностями — к нему ведёт нажатие на ноду справа.
        </span>
      </div>
    </section>
  );
}

/** Ноды волны справа на странице волны: упавшие со временем, уцелевшие ноды той же группы, пропущенные сценарии. */
export function WaveMembers({
  inc,
  calm,
}: {
  inc: Incident;
  /** Ноды той же группы, которые не падали. */
  calm: Array<{ uuid: string; name: string; countryCode?: string | null }>;
}) {
  const fleet = inc.snapshot?.fleet;
  if (!fleet) return null;
  const skipped = fleet.skipped ?? [];
  return (
    <section>
      <h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
        Ноды {fleet.cause === 'country' ? 'страны' : 'провайдера'} · {fleet.groupLabel}
      </h3>
      <ul className="m-0 flex list-none flex-col p-0 text-[12.5px]">
        {fleet.members.map((m) => (
          <li
            key={m.nodeUuid ?? m.name}
            className="flex items-center gap-2 border-t border-border py-2 first:border-t-0"
          >
            <span
              className={cn('size-2 flex-none rounded-full', m.upAt ? 'bg-ok' : 'bg-crit')}
              aria-hidden="true"
            />
            {m.countryCode && <CountryFlag code={m.countryCode} size="sm" />}
            {m.incidentId ? (
              <Link
                to="/incidents/$id"
                params={{ id: m.incidentId }}
                className="min-w-0 truncate hover:text-brand"
              >
                {m.name}
              </Link>
            ) : (
              <span className="min-w-0 truncate">{m.name}</span>
            )}
            <span className="ml-auto flex-none text-text-3 tabular-nums">
              {m.downAt ? (m.upAt ? `${hhmm(m.downAt)}–${hhmm(m.upAt)}` : `с ${hhmm(m.downAt)}`) : ''}
            </span>
          </li>
        ))}
        {calm.map((n) => (
          <li key={n.uuid} className="flex items-center gap-2 border-t border-border py-2">
            <span className="size-2 flex-none rounded-full bg-ok" aria-hidden="true" />
            {n.countryCode && <CountryFlag code={n.countryCode} size="sm" />}
            <span className="min-w-0 truncate text-text-2">{n.name}</span>
            <span className="ml-auto flex-none text-text-3">работала</span>
          </li>
        ))}
      </ul>
      {skipped.length > 0 && (
        <p className="mt-2.5 text-[12px] leading-snug text-text-3">
          Сценарии с исключением «нода в волне» пропустили {skipped.length}{' '}
          {skipped.length === 1 ? 'срабатывание' : skipped.length < 5 ? 'срабатывания' : 'срабатываний'}:{' '}
          {[...new Set(skipped.map((s) => `«${s.ruleName}»`))].join(', ')}.
        </p>
      )}
    </section>
  );
}

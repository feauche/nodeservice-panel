import { TERMINAL_SEARCH_MAX, type TerminalPeriod, type TerminalSessionInfo } from '@nodeservice/shared';
import { ChevronDownIcon, ChevronUpIcon, HistoryIcon, SearchIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/features/audit/audit-format';
import { useTerminalSession, useTerminalSessions } from '@/features/terminal/terminal-api';
import { plural } from '@/lib/plural';
import { stripAnsi } from '@/lib/strip-ansi';
import { cn } from '@/lib/utils';

const PERIODS: Array<{ key: TerminalPeriod; label: string }> = [
  { key: 'all', label: 'Всё время' },
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
];
/** Сколько совпадений подсвечивать в записи: дальше браузеру тяжело, а смысла нет. */
const HIGHLIGHT_MAX = 2000;
const DEBOUNCE_MS = 300;

function formatDuration(s: TerminalSessionInfo): string {
  const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(s.startedAt).getTime()) / 1000));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
function formatMatches(n: number): string {
  return `${n} ${plural(n, 'совпадение', 'совпадения', 'совпадений')}`;
}
/** Начало периода в часовом поясе пользователя (ISO); «всё время» — без ограничения. */
function periodSince(p: TerminalPeriod): string | undefined {
  if (p === 'all') return undefined;
  const d = new Date();
  if (p === 'today') d.setHours(0, 0, 0, 0);
  else d.setTime(d.getTime() - 7 * 86_400_000);
  return d.toISOString();
}

/** Значение с задержкой: сетевой запрос уходит, когда пользователь перестал печатать. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Непересекающиеся вхождения `needle` в `text` без учёта регистра — как считает сервер. */
function findMatches(text: string, needle: string): number[] {
  if (!needle) return [];
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(n);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(n, i + n.length);
  }
  return out;
}

/**
 * История терминала: поиск по записям всех сессий сервера, слева сессии (с числом совпадений),
 * справа запись выбранной с подсветкой и переходом между совпадениями. Открытая сессия
 * дописывается на глазах.
 */
export function TerminalHistoryTab({ serverId }: { serverId: string }) {
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState<TerminalPeriod>('all');
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const since = useMemo(() => periodSince(period), [period]);
  const sessions = useTerminalSessions(serverId, { q, since });
  const items = sessions.data?.items ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  // Выбранная сессия могла выпасть из результатов поиска — тогда показываем первую подходящую.
  const activeId = (selected && items.some((s) => s.id === selected) ? selected : items[0]?.id) ?? null;
  const detail = useTerminalSession(serverId, activeId);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // При смене сервера выбор сбрасывается на самую свежую сессию.
  // biome-ignore lint/correctness/useExhaustiveDependencies: только по serverId
  useEffect(() => {
    setSelected(null);
    setQuery('');
    setPeriod('all');
  }, [serverId]);
  // Новая строка или другая сессия — переход к первому совпадению.
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс по смене q/сессии
  useEffect(() => setCursor(0), [q, activeId]);

  const text = useMemo(() => (detail.data ? stripAnsi(detail.data.transcript) : ''), [detail.data]);
  const positions = useMemo(() => findMatches(text, q), [text, q]);
  const total = positions.length;
  const current = total === 0 ? 0 : ((cursor % total) + total) % total;
  const step = (d: 1 | -1) => total > 0 && setCursor((c) => (((c + d) % total) + total) % total);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  };

  const searching = q !== '';
  const totalMatches = items.reduce((acc, s) => acc + (s.matches ?? 0), 0);
  const hasAny = (sessions.data?.items.length ?? 0) > 0 || searching || period !== 'all';

  if (sessions.isPending && !sessions.data) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 rounded-[8px]" />
        ))}
      </div>
    );
  }
  if (!hasAny) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-14 text-center">
        <p className="text-[13.5px] font-semibold">Сессий терминала ещё не было</p>
        <p className="mt-1 max-w-[420px] text-[12.5px] text-text-3">
          Откройте SSH-терминал, и всё, что покажет сервер, сохранится здесь: без ввода и паролей, только
          вывод. Записи хранятся 30 дней.
        </p>
      </div>
    );
  }

  const currentSession = items.find((s) => s.id === activeId) ?? null;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? '';

  return (
    <div className="flex h-full min-h-[360px] flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            aria-label="Поиск по истории терминала"
            placeholder="Поиск по истории: команда, вывод, адрес…"
            value={query}
            maxLength={TERMINAL_SEARCH_MAX}
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            className="h-9 rounded-[10px] bg-surface-2 pr-9 pl-9 text-[13px]"
          />
          {query && (
            <button
              type="button"
              aria-label="Очистить поиск"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-foreground"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              data-active={period !== 'all'}
              className="h-9 flex-none rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground data-[active=true]:border-brand/40 data-[active=true]:text-foreground"
            >
              <HistoryIcon className="size-3.5" aria-hidden="true" />
              {periodLabel}
              <ChevronDownIcon className="size-3.5 opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuLabel>Период</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={period} onValueChange={(v) => setPeriod(v as TerminalPeriod)}>
              {PERIODS.map((p) => (
                <DropdownMenuRadioItem key={p.key} value={p.key}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {searching && (
        <p role="status" className="text-[12px] text-text-3">
          {sessions.isFetching && sessions.data?.items !== items
            ? 'Ищем…'
            : items.length === 0
              ? `Ничего не найдено по «${q}»${period !== 'all' ? ` за период «${periodLabel}»` : ''}.`
              : `Найдено ${formatMatches(totalMatches)} в ${items.length} ${plural(items.length, 'сессии', 'сессиях', 'сессиях')}. Подсвечены в записи, Enter — следующее.`}
        </p>
      )}

      {items.length === 0 ? (
        <div className="grid flex-1 place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-10 text-center">
          <p className="text-[13px] font-semibold">
            {searching ? 'Совпадений нет' : `За период «${periodLabel}» сессий не было`}
          </p>
          <p className="mt-1 max-w-[380px] text-[12.5px] text-text-3">
            {searching
              ? 'Попробуйте другую строку или расширьте период.'
              : 'Выберите «Всё время», чтобы увидеть все записи за 30 дней.'}
          </p>
        </div>
      ) : (
        <TerminalHistoryView
          items={items}
          activeId={activeId}
          onSelect={setSelected}
          current={currentSession}
          detail={detail}
          text={text}
          q={q}
          positions={positions}
          cursor={current}
          onStep={step}
        />
      )}
    </div>
  );
}

function TerminalHistoryView({
  items,
  activeId,
  onSelect,
  current,
  detail,
  text,
  q,
  positions,
  cursor,
  onStep,
}: {
  items: TerminalSessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  current: TerminalSessionInfo | null;
  detail: ReturnType<typeof useTerminalSession>;
  text: string;
  q: string;
  positions: number[];
  cursor: number;
  onStep: (d: 1 | -1) => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const total = positions.length;
  const searching = q !== '';

  // Текущее совпадение — в центр окна записи. Крутим только саму запись: scrollIntoView
  // сдвинул бы и окно сервера целиком (на телефоне это ломает разметку).
  useEffect(() => {
    if (total === 0) return;
    const pre = preRef.current;
    const el = pre?.querySelector<HTMLElement>(`[data-match="${cursor}"]`);
    if (!pre || !el) return;
    pre.scrollTop = Math.max(0, el.offsetTop - pre.clientHeight / 2);
  }, [cursor, total]);

  // Запись режется на куски «текст, совпадение, текст…»; подсветка ограничена HIGHLIGHT_MAX.
  const parts = useMemo(() => {
    if (!searching || total === 0) return null;
    const out: Array<string | { i: number; s: string }> = [];
    let last = 0;
    const n = Math.min(total, HIGHLIGHT_MAX);
    for (let i = 0; i < n; i++) {
      const p = positions[i] as number;
      if (p > last) out.push(text.slice(last, p));
      out.push({ i, s: text.slice(p, p + q.length) });
      last = p + q.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [searching, total, positions, text, q]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-4 max-md:grid-cols-1">
      <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label="Сессии терминала">
        {items.map((s) => {
          const live = s.endedAt === null;
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={s.id === activeId}
                onClick={() => onSelect(s.id)}
                className={cn(
                  'flex w-full cursor-pointer flex-col gap-0.5 rounded-[10px] border border-transparent px-3 py-2 text-left transition-colors hover:bg-surface-2',
                  s.id === activeId && 'border-border bg-surface-2',
                )}
              >
                <span className="flex items-center gap-2 text-[12.5px] font-medium">
                  {live && (
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-ok shadow-[0_0_0_3px_var(--ns-ok-soft)]"
                    />
                  )}
                  {formatWhen(s.startedAt)}
                </span>
                <span className="text-[11.5px] text-text-3 tabular-nums">
                  {s.matches !== undefined
                    ? formatMatches(s.matches)
                    : `${live ? 'идёт сейчас' : formatDuration(s)} · ${formatKb(s.bytesOut)}`}
                  {s.truncated ? ' · усечена' : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-bg-2">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-[12px] text-text-3">
          <span className="truncate">
            {current ? `Сессия от ${formatWhen(current.startedAt)}` : 'Сессия'}
            {current?.actorDisplay ? ` · ${current.actorDisplay}` : ''}
          </span>
          <span className="flex-1" />
          {searching ? (
            <span className="flex items-center gap-1">
              <span className="tabular-nums" aria-live="polite">
                {total === 0 ? 'нет совпадений' : `${cursor + 1} из ${total}`}
              </span>
              <button
                type="button"
                aria-label="Предыдущее совпадение"
                disabled={total === 0}
                onClick={() => onStep(-1)}
                className="grid size-6 cursor-pointer place-items-center rounded-[6px] hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-40"
              >
                <ChevronUpIcon className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Следующее совпадение"
                disabled={total === 0}
                onClick={() => onStep(1)}
                className="grid size-6 cursor-pointer place-items-center rounded-[6px] hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-40"
              >
                <ChevronDownIcon className="size-4" aria-hidden="true" />
              </button>
            </span>
          ) : (
            <span className="tabular-nums">
              {current ? `${current.cols}×${current.rows}` : ''}
              {current?.endReason ? ` · ${current.endReason}` : ''}
            </span>
          )}
        </div>
        {detail.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 rounded-[6px]" />
            ))}
          </div>
        ) : (
          <pre
            ref={preRef}
            data-testid="terminal-transcript"
            className="relative min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words text-text-2"
          >
            {!detail.data
              ? '—'
              : parts
                ? parts.map((p, i) =>
                    typeof p === 'string' ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: куски записи статичны между рендерами
                      <span key={`s${i}`}>{p}</span>
                    ) : (
                      <mark
                        key={`m${p.i}`}
                        data-match={p.i}
                        className={cn(
                          'rounded-[3px] px-0.5',
                          p.i === cursor ? 'bg-warn text-on-warn' : 'bg-warn-soft text-warn',
                        )}
                      >
                        {p.s}
                      </mark>
                    ),
                  )
                : text || '(пусто)'}
          </pre>
        )}
        {searching && total > HIGHLIGHT_MAX && (
          <div className="border-t border-border px-4 py-2 text-[11.5px] text-text-3">
            Подсвечены первые {HIGHLIGHT_MAX} из {total}: уточните запрос.
          </div>
        )}
        {current?.truncated && (
          <div className="border-t border-border px-4 py-2 text-[11.5px] text-warn">
            Запись усечена: сохранены первые 2 МБ вывода, всего прошло {formatKb(current.bytesOut)}.
          </div>
        )}
      </section>
    </div>
  );
}

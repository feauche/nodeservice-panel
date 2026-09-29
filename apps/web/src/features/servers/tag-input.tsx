import { normalizeTag, SERVER_TAGS_MAX, similarTag, tagCounts } from '@nodeservice/shared';
import { TriangleAlertIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { useServers } from './servers-api';

const plural = (n: number) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'сервер';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'сервера';
  return 'серверов';
};

/** Теги парка с числом серверов; сервер, который сейчас правится, не считаем. */
export function useTagCounts(excludeId?: string): Record<string, number> {
  const q = useServers();
  return useMemo(
    () => tagCounts((q.data?.items ?? []).filter((s) => s.id !== excludeId)),
    [q.data, excludeId],
  );
}

/** Строка «a, b» из формы → список тегов. */
export const splitTagList = (raw: string): string[] =>
  raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

interface Option {
  tag: string;
  kind: 'known' | 'guess' | 'new';
  count: number;
}

/**
 * Теги капсулами (витрина `tags-variants.html`, вариант A). Пробел или запятая — капсула из напечатанного,
 * Enter — выделенная подсказка, ⌫ в пустом поле — убрать последнюю. Подсказки — теги парка с числом
 * серверов; на опечатке («noed») первой идёт «node — похоже, вы имели в виду». Новые и подозрительные
 * капсулы — жёлтые, под полем предложение заменить.
 */
export function TagInput({
  id,
  value,
  onChange,
  counts,
  disabled,
  invalid,
  describedBy,
  placeholder = 'node, exit…',
}: {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  /** Теги парка и на скольких серверах каждый (этот сервер — не в счёт, чтобы опечатка не «узаконила» себя). */
  counts: Readonly<Record<string, number>>;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Стрелками выбирали подсказку — тогда Enter берёт её и при пустом поле. */
  const [moved, setMoved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const full = value.length >= SERVER_TAGS_MAX;

  const add = (raw: string) => {
    const t = normalizeTag(raw);
    setText('');
    setActive(0);
    setMoved(false);
    if (!t || value.includes(t) || full) return;
    onChange([...value, t]);
  };

  const options = useMemo<Option[]>(() => {
    const v = normalizeTag(text);
    const known = Object.entries(counts)
      .filter(([t, n]) => n > 0 && !value.includes(t) && (!v || t.includes(v)) && !similarTag(t, counts))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([tag, count]): Option => ({ tag, count, kind: 'known' }));
    const out = [...known];
    const guess = v ? similarTag(v, counts) : null;
    if (guess && !value.includes(guess.tag) && !out.some((o) => o.tag === guess.tag))
      out.unshift({ tag: guess.tag, count: guess.count, kind: 'guess' });
    if (v && !counts[v] && !value.includes(v)) out.push({ tag: v, count: 0, kind: 'new' });
    return out;
  }, [text, counts, value]);

  const suspicious = value
    .map((t) => ({ t, like: similarTag(t, counts) }))
    .filter((x): x is { t: string; like: { tag: string; count: number } } => x.like !== null);
  const suspiciousSet = new Set(suspicious.map((x) => x.t));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setMoved(true);
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMoved(true);
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (open && o && (text.trim() || moved)) add(o.tag);
      else if (text.trim()) add(text);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const showList = open && !disabled && options.length > 0;

  return (
    <div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: клик по рамке — фокус в поле */}
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'relative flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-[10px] border bg-surface-2 px-2 py-1.5 transition-colors focus-within:border-brand',
          invalid ? 'border-crit' : 'border-border',
          disabled && 'cursor-default opacity-60',
        )}
      >
        {value.map((t) => (
          <span
            key={t}
            className={cn(
              'inline-flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-[12.5px] font-medium',
              !counts[t] || suspiciousSet.has(t) ? 'bg-warn-soft text-warn' : 'bg-brand-soft text-brand',
            )}
            title={!counts[t] ? 'Новый тег — такого в парке ещё нет' : undefined}
          >
            {t}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Убрать тег ${t}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x !== t));
              }}
              className="grid size-4 cursor-pointer place-items-center rounded-full opacity-70 hover:opacity-100"
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || (full && !text)}
          placeholder={value.length ? '' : full ? '' : placeholder}
          value={text}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (text.trim()) add(text);
          }}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            const v = e.target.value;
            // Пробел или запятая — капсула из того, что напечатано (вставка «a, b c» тоже разберётся).
            if (/[\s,]/.test(v)) {
              const parts = v.split(/[\s,]+/);
              const rest = parts.pop() ?? '';
              const next = [...value];
              for (const p of parts) {
                const t = normalizeTag(p);
                if (t && !next.includes(t) && next.length < SERVER_TAGS_MAX) next.push(t);
              }
              if (next.length !== value.length) onChange(next);
              setText(rest);
            } else setText(v);
            setActive(0);
            setOpen(true);
          }}
          className="min-w-[90px] flex-1 border-0 bg-transparent px-0.5 py-0.5 text-[13.5px] outline-none"
        />
        {showList && (
          <div
            id={listId}
            role="listbox"
            aria-label="Подсказки тегов"
            className="absolute top-[calc(100%+6px)] right-0 left-0 z-50 rounded-[12px] border border-border-2 bg-surface p-1 shadow-pop"
          >
            {options.map((o, i) => (
              <div
                key={`${o.kind}:${o.tag}`}
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(o.tag);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-[8px] px-2.5 py-1.5 text-[13px]',
                  i === active && 'bg-surface-2',
                  o.kind === 'new' && i > 0 && 'mt-1 border-t border-border pt-2',
                )}
              >
                <span className="min-w-0 truncate">
                  {o.kind === 'new' ? (
                    <>Новый тег «{o.tag}»</>
                  ) : (
                    <>
                      <b className="font-semibold text-brand">{o.tag}</b>
                      {o.kind === 'guess' && <span className="text-text-2"> — похоже, вы имели в виду</span>}
                    </>
                  )}
                </span>
                <span className="flex-none text-[11.5px] text-text-3">
                  {o.kind === 'new' ? 'такого ещё нет' : `${o.count} ${plural(o.count)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {suspicious.map(({ t, like }) => (
        <div
          key={t}
          className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px]"
          role="status"
        >
          <TriangleAlertIcon className="size-4 flex-none text-warn" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <b>
              «{t}» — {counts[t] ? 'есть только на 1 сервере' : 'новый тег'}.
            </b>{' '}
            Похоже на «{like.tag}» ({like.count} {plural(like.count)}). Опечатка?
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([...new Set(value.map((x) => (x === t ? like.tag : x)))])}
            className="h-7 cursor-pointer rounded-[8px] border border-border bg-surface px-2.5 text-[12px] font-medium hover:text-foreground"
          >
            Заменить на «{like.tag}»
          </button>
        </div>
      ))}
      <div className="mt-1.5 text-[11.5px] text-text-3">
        Необязательно. Пробел или запятая — тег как напечатан, Enter — выделенная подсказка. Новые и
        подозрительные теги — жёлтым{full ? `; больше ${SERVER_TAGS_MAX} нельзя` : ''}.
      </div>
    </div>
  );
}

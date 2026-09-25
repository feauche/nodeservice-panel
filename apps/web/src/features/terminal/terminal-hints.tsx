import type { TerminalHintResponse } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { Loader2Icon, LockIcon, SendIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { JarvisIcon } from '@/components/jarvis-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useAssistantStatus } from '@/features/assistant/assistant-api';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useTerminalHint } from './terminal-api';

/** Сколько последних строк терминала видит Джарвис по кнопке. */
export const HINT_LINES = 60;

/**
 * Подсказки к терминалу (C1): справа от экрана. Джарвис видит только то, что вы ему показали
 * кнопкой, объясняет вывод и предлагает команды. Команды только вставляются в строку ввода, без Enter.
 */
export function TerminalHints({
  serverId,
  readRecent,
  onInsert,
  onClose,
  className,
}: {
  serverId: string;
  /** Последние строки экрана терминала. */
  readRecent: () => string;
  onInsert: (command: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const status = useAssistantStatus();
  const hint = useTerminalHint(serverId);
  const [result, setResult] = useState<TerminalHintResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');

  const ask = async (q?: string) => {
    const text = readRecent().trim();
    if (!text) {
      setError('В терминале пока нет вывода: подсказывать нечего.');
      return;
    }
    setError(null);
    try {
      setResult(await hint.mutateAsync({ text, ...(q ? { question: q } : {}) }));
      if (q) setQuestion('');
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length >= 2) void ask(question.trim());
  };

  const enabled = Boolean(status.data?.enabled && status.data.permissions.terminalHints);

  return (
    <aside
      aria-label="Подсказки Джарвиса"
      className={cn('flex min-h-0 flex-col gap-2.5 overflow-hidden bg-surface p-3 text-[13px]', className)}
    >
      <div className="flex items-center gap-2 font-semibold text-ai">
        <JarvisIcon className="size-3.5" aria-hidden="true" />
        Подсказки
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-3">
          видит: последние {HINT_LINES} строк
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Скрыть подсказки"
          aria-label="Скрыть подсказки"
          className="grid size-6 cursor-pointer place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-foreground"
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
        {status.isPending ? (
          <Skeleton className="h-9 rounded-[10px]" />
        ) : !status.data?.enabled ? (
          <div className="flex flex-col items-start gap-2 text-[12.5px] leading-snug text-text-2">
            <p className="m-0">Чтобы получать подсказки, задайте провайдера, модель и ключ Джарвиса.</p>
            <Link
              to="/settings/assistant"
              className="inline-flex h-8 items-center rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:text-foreground"
            >
              Открыть «Настройки → Джарвис»
            </Link>
          </div>
        ) : !status.data.permissions.terminalHints ? (
          <div className="flex flex-col items-start gap-2 text-[12.5px] leading-snug text-text-2">
            <p className="m-0">Подсказки в терминале выключены в разрешениях Джарвиса.</p>
            <Link
              to="/settings/assistant"
              className="inline-flex h-8 items-center rounded-[9px] border border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:text-foreground"
            >
              Открыть «Настройки → Джарвис»
            </Link>
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={hint.isPending}
              onClick={() => void ask()}
              className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-cta px-3 text-[13px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-60"
            >
              {hint.isPending && <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />}
              Объяснить последние {HINT_LINES} строк
            </button>

            {hint.isPending && (
              <div className="flex flex-col gap-2" aria-hidden="true">
                <Skeleton className="h-3 w-[70%] rounded-[5px]" />
                <Skeleton className="h-3 w-[92%] rounded-[5px]" />
                <Skeleton className="h-3 w-[55%] rounded-[5px]" />
              </div>
            )}

            {error && (
              <p role="alert" className="m-0 text-[12.5px] leading-snug text-crit">
                {error}
              </p>
            )}

            {result && !hint.isPending && (
              <>
                <div
                  data-testid="terminal-hint"
                  className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface-2 p-2.5"
                >
                  <b className="text-[13px] font-semibold">{result.title}</b>
                  <span className="text-[12.5px] leading-normal text-text-2">{result.explanation}</span>
                </div>
                {result.commands.length > 0 && (
                  <>
                    <span className="text-[12px] text-text-3">Что можно сделать дальше:</span>
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {result.commands.map((c) => (
                        <li key={c.command} className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 rounded-[8px] border border-border bg-bg-2 py-1 pr-1 pl-2.5">
                            <code
                              title={c.command}
                              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-2"
                            >
                              {c.command}
                            </code>
                            <button
                              type="button"
                              onClick={() => onInsert(c.command)}
                              aria-label={`Вставить: ${c.command}`}
                              className="inline-flex h-7 flex-none cursor-pointer items-center rounded-[7px] border border-border bg-surface-2 px-2.5 text-[12px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground"
                            >
                              Вставить
                            </button>
                          </div>
                          <span className="flex flex-wrap items-center gap-1.5 pl-1 text-[11.5px] leading-snug text-text-3">
                            {c.risk === 'change' && (
                              <span className="rounded-full bg-warn-soft px-1.5 py-px text-[10.5px] font-semibold text-warn">
                                Меняет систему
                              </span>
                            )}
                            {c.note}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {result.masked > 0 && (
                  <p className="m-0 text-[11.5px] text-text-3">
                    Перед отправкой скрыто фрагментов: {result.masked} (ключи, пароли, адреса).
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
      {enabled && (
        <form onSubmit={onSubmit} className="flex flex-none gap-1.5">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            disabled={hint.isPending}
            aria-label="Вопрос по этому выводу"
            placeholder="Спросите про этот вывод…"
            className="h-9 min-w-0 flex-1 rounded-[9px] border border-border bg-surface-2 px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-text-3 focus-visible:border-ai/60 disabled:opacity-60"
          />
          <button
            type="submit"
            aria-label="Спросить"
            disabled={question.trim().length < 2 || hint.isPending}
            className="grid size-9 flex-none cursor-pointer place-items-center rounded-[9px] border border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground disabled:cursor-default disabled:opacity-50"
          >
            <SendIcon className="size-3.5" aria-hidden="true" />
          </button>
        </form>
      )}

      <p className="m-0 flex gap-2 text-[11.5px] leading-snug text-text-3">
        <LockIcon className="mt-px size-3 flex-none" aria-hidden="true" />
        <span>
          Ключи, пароли, приватные ключи и адреса маскируются до отправки. Ничего не выполняется без вас.
        </span>
      </p>
    </aside>
  );
}

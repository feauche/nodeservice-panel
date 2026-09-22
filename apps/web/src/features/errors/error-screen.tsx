import { CheckIcon, CopyIcon, RotateCwIcon } from 'lucide-react';
import { useState } from 'react';

import { useTheme } from '@/features/theme/use-theme';
import { buildErrorReport, explainError } from './error-report';

interface Props {
  error: unknown;
  /** Повторить рендер (TanStack reset); undefined — только перезагрузка страницы. */
  reset?: (() => void) | undefined;
}

/**
 * Экран необработанной ошибки: понятное объяснение, действия и отчёт, который можно скопировать
 * и отправить разработчику (сообщение, стек, страница, id запроса, браузер).
 */
export function ErrorScreen({ error, reset }: Props) {
  const theme = useTheme();
  const explanation = explainError(error);
  const [copied, setCopied] = useState(false);
  const message = error instanceof Error ? error.message || error.name : String(error);
  const path = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '';
  const report = buildErrorReport(error, { path, theme });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* буфер недоступен — отчёт виден в деталях ниже */
    }
  };

  const btn =
    'inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-[10px] px-4 text-[13px] font-semibold transition-colors';
  return (
    <main className="grid h-full place-items-center overflow-auto bg-background p-6">
      <div className="w-full max-w-[560px]">
        <h1 className="text-xl">{explanation.title}</h1>
        <p className="mt-1.5 text-[13.5px] text-text-2">{explanation.advice}</p>
        <p className="mt-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[12.5px] break-words text-text-2">
          {message}
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => (reset ? reset() : window.location.reload())}
            className={`${btn} bg-cta text-cta-foreground hover:bg-(--ns-cta-hover)`}
          >
            <RotateCwIcon className="size-4" aria-hidden="true" />
            {reset ? 'Попробовать снова' : 'Обновить страницу'}
          </button>
          {reset && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={`${btn} border border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground`}
            >
              Обновить страницу
            </button>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            className={`${btn} border border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground`}
          >
            {copied ? (
              <CheckIcon className="size-4 text-ok" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
            {copied ? 'Скопировано' : 'Скопировать отчёт'}
          </button>
        </div>
        <details className="mt-5 text-[12px] text-text-3">
          <summary className="cursor-pointer select-none">Технические детали</summary>
          <pre className="mt-2 max-h-[320px] overflow-auto rounded-[10px] border border-border bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-2">
            {report}
          </pre>
        </details>
      </div>
    </main>
  );
}

import {
  AUDIT_ACTOR_TYPE_LABELS,
  AUDIT_CATEGORY_LABELS,
  AUDIT_RESULT_LABELS,
  AUDIT_SOURCE_LABELS,
  type AuditEntry,
  type AuditResult,
  auditActionLabel,
} from '@nodeservice/shared';
import { CheckIcon, ChevronDownIcon, CopyIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { JarvisIcon } from '@/components/jarvis-icon';
import { toast } from '@/lib/notify';

import { capFirst, cn } from '@/lib/utils';
import {
  buildAuditReport,
  changeHeadline,
  changeRows,
  formatDuration,
  formatFull,
  formatValue,
  formatWhen,
  metadataRows,
  shortUserAgent,
} from './audit-format';

const RESULT_TONE: Record<AuditResult, string> = {
  ok: 'bg-ok-soft text-ok',
  failed: 'bg-warn-soft text-warn',
  denied: 'bg-crit-soft text-crit',
};

const RESULT_DOT: Record<AuditResult, string> = { ok: 'bg-ok', failed: 'bg-warn', denied: 'bg-crit' };

export function ResultPill({ result }: { result: AuditResult }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap',
        RESULT_TONE[result],
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {AUDIT_RESULT_LABELS[result]}
    </span>
  );
}

/** Бейдж источника (требование 13.4): вручную — нейтральный, авто — акцентный. */
export function SourceBadge({ source }: { source: AuditEntry['source'] }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-[6px] border px-[7px] py-[2px] text-[11px] font-medium whitespace-nowrap',
        source === 'auto'
          ? 'border-transparent bg-brand-soft text-brand'
          : 'border-border bg-surface-2 text-text-2',
      )}
    >
      {capFirst(AUDIT_SOURCE_LABELS[source])}
    </span>
  );
}

interface RowProps {
  entry: AuditEntry;
  expanded: boolean;
  fresh: boolean;
  /** Сколько колонок видно на этой ширине — для строки деталей. */
  colSpan?: number;
  onToggle: () => void;
}

export function AuditRow({ entry, expanded, fresh, colSpan = 6, onToggle }: RowProps) {
  const headline = changeHeadline(entry);
  const label = headline ?? auditActionLabel(entry.action);
  return (
    <>
      <tr
        className={cn(
          'group h-11 cursor-pointer border-t border-border text-[13px] transition-colors first:border-t-0 hover:bg-surface-2/60',
          expanded && 'bg-surface-2/60',
          fresh && 'animate-[ns-flash_2.4s_ease-out]',
        )}
        onClick={onToggle}
        data-seq={entry.seq}
      >
        <td
          className="w-[128px] px-4 text-text-2 tabular-nums whitespace-nowrap max-md:w-[96px] max-md:px-3 max-md:text-[12px]"
          title={formatFull(entry.occurredAt)}
        >
          {formatWhen(entry.occurredAt)}
        </td>
        <td className="min-w-0 px-3">
          <div className="flex min-w-0 items-center gap-2">
            {!headline && (
              <span className="hidden flex-none rounded-[5px] bg-surface-3 px-1.5 py-[1px] text-[10.5px] font-semibold tracking-[0.04em] text-text-3 uppercase xl:inline">
                {AUDIT_CATEGORY_LABELS[entry.category]}
              </span>
            )}
            {headline && <JarvisIcon className="size-3.5 flex-none text-ai" />}
            <span className={cn('truncate', headline ? 'font-semibold' : 'font-medium')} title={label}>
              {label}
            </span>
            {entry.targetDisplay && (
              <span
                className={cn('hidden truncate text-text-3 xl:inline', headline && 'max-w-[30%] flex-none')}
              >
                · {entry.targetDisplay}
              </span>
            )}
          </div>
          {/* На планшете и телефоне колонки «Кто» нет — актор второй строкой под событием. */}
          <div className="hidden truncate text-[11.5px] text-text-3 max-xl:block">
            {entry.actorDisplay}
            {entry.targetDisplay ? ` · ${entry.targetDisplay}` : ''}
          </div>
        </td>
        <td className="w-[200px] px-3 max-xl:hidden">
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate">{entry.actorDisplay}</span>
            {entry.ip && <span className="truncate font-mono text-[11px] text-text-3">{entry.ip}</span>}
          </div>
        </td>
        <td className="w-[96px] px-3 max-xl:hidden">
          <SourceBadge source={entry.source} />
        </td>
        <td className="w-[120px] px-3 max-md:w-[44px] max-md:px-2">
          <span className="max-md:hidden">
            <ResultPill result={entry.result} />
          </span>
          <span
            role="img"
            className={cn('hidden size-2.5 rounded-full max-md:inline-block', RESULT_DOT[entry.result])}
            title={AUDIT_RESULT_LABELS[entry.result]}
            aria-label={AUDIT_RESULT_LABELS[entry.result]}
          />
        </td>
        <td className="w-10 pr-3 text-right max-md:hidden">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Скрыть детали' : 'Показать детали'}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[7px] text-text-3 transition-colors group-hover:text-text-2 hover:bg-surface-3"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <ChevronDownIcon className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-border bg-surface-2/40">
          <td colSpan={colSpan} className="px-4 py-3 max-md:px-3">
            <AuditDetails entry={entry} />
          </td>
        </tr>
      )}
    </>
  );
}

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3 text-[12.5px]">
      <dt className="w-[92px] flex-none text-text-3">{label}</dt>
      <dd className={cn('min-w-0 break-words', mono && 'font-mono text-[12px]')}>{children}</dd>
    </div>
  );
}

export function AuditDetails({ entry }: { entry: AuditEntry }) {
  const changes = entry.changes ? Object.entries(entry.changes) : [];
  const rows = changeRows(entry);
  const metadata = metadataRows(entry.metadata);
  const [copied, setCopied] = useState(false);
  const copyReport = async () => {
    await navigator.clipboard.writeText(buildAuditReport(entry));
    toast.success('Отчёт по записи скопирован.');
    setCopied(true);
    setTimeout(() => setCopied(false), 1_600);
  };
  return (
    <div className="relative" data-testid="audit-details">
      {/* На уровне первой строки деталей, у правого края — без своей полосы. */}
      <button
        type="button"
        onClick={() => void copyReport()}
        className="absolute top-0 right-0 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 px-2.5 text-[11.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-ok" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
        Скопировать
      </button>
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <dl className="flex flex-col gap-1.5">
          <Field label="Кто">
            {entry.actorDisplay}{' '}
            <span className="text-text-3">· {AUDIT_ACTOR_TYPE_LABELS[entry.actorType]}</span>
          </Field>
          <Field label="IP" mono>
            {entry.ip ?? '—'}
          </Field>
          <Field label="Браузер">
            <span title={entry.userAgent ?? undefined}>{shortUserAgent(entry.userAgent)}</span>
          </Field>
          <Field label="Когда">{formatFull(entry.occurredAt)}</Field>
          <Field label="Запрос" mono>
            {entry.requestId ?? '—'}
            {entry.durationMs !== null && (
              <span className="text-text-3"> · {formatDuration(entry.durationMs)}</span>
            )}
          </Field>
          <Field label="Ключ" mono>
            {entry.action}
          </Field>
          {entry.targetDisplay && (
            <Field label="Цель">
              {entry.targetDisplay}
              {entry.targetType && <span className="text-text-3"> · {entry.targetType}</span>}
            </Field>
          )}
        </dl>
        <div className="flex flex-col gap-4">
          {rows.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
                Изменения
              </h3>
              <div className="overflow-x-auto rounded-[8px] border border-border">
                <table className="w-full text-[12px]">
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label} className="border-t border-border first:border-t-0">
                        <td className="w-[120px] px-2.5 py-1.5 text-text-2">{r.label}</td>
                        <td className="px-2.5 py-1.5">
                          <span className="text-text-3 line-through decoration-text-3/60">{r.before}</span>
                          <span className="mx-1.5 text-text-3">→</span>
                          <span className="font-medium">{r.after}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {changes.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
                Изменения
              </h3>
              <div className="overflow-x-auto rounded-[8px] border border-border">
                <table className="w-full text-[12px]">
                  <tbody>
                    {changes.map(([field, diff]) => (
                      <tr key={field} className="border-t border-border first:border-t-0">
                        <td className="w-[120px] px-2.5 py-1.5 font-mono text-text-2">{field}</td>
                        <td className="px-2.5 py-1.5">
                          <span className="text-text-3 line-through decoration-text-3/60">
                            {formatValue(diff.before)}
                          </span>
                          <span className="mx-1.5 text-text-3">→</span>
                          <span className="font-medium">{formatValue(diff.after)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {metadata.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.1em] text-text-3 uppercase">
                Данные
              </h3>
              <dl className="flex flex-col gap-1">
                {metadata.map(({ key, label, value }) => (
                  <Field key={key} label={label}>
                    {value}
                  </Field>
                ))}
              </dl>
            </section>
          )}
          {changes.length === 0 && rows.length === 0 && metadata.length === 0 && (
            <p className="text-[12.5px] text-text-3">Дополнительных данных нет.</p>
          )}
        </div>
      </div>
    </div>
  );
}

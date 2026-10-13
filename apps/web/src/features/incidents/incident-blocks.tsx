import type { IncidentEvent } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  type LucideIcon,
  MapPinIcon,
  PlugIcon,
  RadarIcon,
  TriangleAlertIcon,
  UsersIcon,
} from 'lucide-react';

import { formatWhen } from '@/features/audit/audit-format';
import { cn } from '@/lib/utils';

export type StepTone = NonNullable<IncidentEvent['tone']>;
/** Цвет значка строки по итогу: готово, ждём, нужно внимание, ошибка, изменение, сведения. */
export const TONE_CHIP: Record<StepTone, string> = {
  ok: 'bg-ok-soft text-ok',
  wait: 'bg-brand-soft text-brand',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  change: 'bg-teal/15 text-teal',
  info: 'bg-surface-2 text-text-3',
};
/** Цвет слова-итога в тех же тонах. */
export const TONE_TEXT: Record<StepTone, string> = {
  ok: 'text-ok',
  wait: 'text-brand',
  warn: 'text-warn',
  crit: 'text-crit',
  change: 'text-teal',
  info: 'text-text-2',
};
const STEP_ICON: Record<NonNullable<IncidentEvent['step']>, LucideIcon> = {
  address: MapPinIcon,
  port: RadarIcon,
  dns: GlobeIcon,
  node: PlugIcon,
  online: UsersIcon,
  close: CircleCheckIcon,
};
/** Строки до 0.95.0 (без шага и тона) — значок и цвет по итогу записи. */
const RESULT_ICON: Record<IncidentEvent['result'], LucideIcon> = {
  detect: TriangleAlertIcon,
  notify: InfoIcon,
  applied: CheckIcon,
  helped: CircleCheckIcon,
  failed: CircleXIcon,
  escalate: CircleAlertIcon,
  resolved: CircleCheckIcon,
};
const RESULT_TONE: Record<IncidentEvent['result'], StepTone> = {
  detect: 'crit',
  notify: 'info',
  applied: 'change',
  helped: 'ok',
  failed: 'crit',
  escalate: 'warn',
  resolved: 'ok',
};
/** Кнопка у строки или шага: та же высота и рамка, что у кнопок шапки события. */
export const STEP_BTN =
  'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground';

/**
 * Действие у строки: запись в «DNS интеграциях» — кнопкой (окно записи откроется само), отчёт Check-Host —
 * ссылкой наружу.
 */
export function StepLink({ link, label }: { link: NonNullable<IncidentEvent['link']>; label?: string }) {
  if (link.href)
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[12.5px] text-brand hover:underline"
      >
        {label ?? link.label}
        <ExternalLinkIcon className="size-3" aria-hidden="true" />
      </a>
    );
  if (link.to === '/integrations/dns')
    return (
      <Link
        to="/integrations/dns"
        search={link.search?.record ? { record: link.search.record } : {}}
        className={STEP_BTN}
      >
        <GlobeIcon className="size-3.5" aria-hidden="true" />
        {label ?? link.label}
      </Link>
    );
  return null;
}

/**
 * Хронология события: время, значок шага с цветом итога и линией к следующей строке, заголовок, подробности,
 * кнопка или ссылка, кто сделал. Строки прежних версий — со значком по итогу.
 */
export function Timeline({
  events,
  severity = 'crit',
}: {
  events: IncidentEvent[];
  severity?: 'crit' | 'warn' | 'info';
}) {
  return (
    <ol className="flex flex-col" aria-label="Хронология">
      {events.map((e, i) => {
        const tone: StepTone =
          e.tone ?? (e.result === 'detect' && severity === 'warn' ? 'warn' : RESULT_TONE[e.result]);
        const Icon = e.step ? STEP_ICON[e.step] : RESULT_ICON[e.result];
        return (
          <li
            key={`${e.at}-${e.result}-${e.action}`}
            className="grid grid-cols-[104px_26px_minmax(0,1fr)_auto] items-start gap-x-2.5 max-sm:grid-cols-[26px_minmax(0,1fr)]"
          >
            <span className="pt-1 text-[11.5px] whitespace-nowrap text-text-3 tabular-nums max-sm:hidden">
              {formatWhen(e.at)}
            </span>
            {/* Значок и линия к следующей строке: линия рисуется в ячейке значка, поэтому не «плывёт» */}
            <span className="relative flex justify-center self-stretch" aria-hidden="true">
              {i < events.length - 1 && <span className="absolute top-[26px] -bottom-[2px] w-px bg-border" />}
              <span
                className={cn(
                  'relative grid size-6 place-items-center rounded-[8px] ring-[3px] ring-surface',
                  TONE_CHIP[tone],
                )}
              >
                <Icon className="size-[13px]" />
              </span>
            </span>
            <div className="min-w-0 pt-0.5 pb-3.5">
              <span className="hidden text-[11.5px] text-text-3 tabular-nums max-sm:block">
                {formatWhen(e.at)}
              </span>
              <p className="text-[13px] leading-snug font-semibold">{e.action}</p>
              {e.detail && <p className="mt-0.5 text-[12.5px] leading-normal text-text-2">{e.detail}</p>}
              {e.link && (
                <div className="mt-2">
                  <StepLink link={e.link} />
                </div>
              )}
            </div>
            <span className="pt-1 text-[11.5px] text-text-3 max-sm:hidden">
              {e.by === 'auto' ? 'Авто' : 'Вручную'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

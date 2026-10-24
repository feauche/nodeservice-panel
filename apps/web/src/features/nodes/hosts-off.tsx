import type { ScenarioDisabledHosts } from '@nodeservice/shared';
import { CircleCheckIcon, ExternalLinkIcon, Loader2Icon, PowerIcon, TriangleAlertIcon } from 'lucide-react';
import { hhmm } from '@/features/incidents/incident-format';
import { useRestoreHostsNow } from '@/features/scenarios/scenarios-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';

type HostsOff = ScenarioDisabledHosts['items'][number];

const quoted = (names: string[]) => names.map((n) => `«${n}»`).join(', ');
const hostName = (h: HostsOff['hosts'][number]) => h.name ?? 'Host без имени';
/** Кто отключил: «Сценарий «Точно лежит»» или «Сценарии «A», «B»». */
function who(info: HostsOff) {
  const names = info.rules.map((r) => r.name);
  return names.length === 1 ? `Сценарий «${names[0]}»` : `Сценарии ${quoted(names)}`;
}

/**
 * Метка «Host отключён · N» у имени ноды (витрина reference-pack-2026-10, раздел 1 — C): Host этой ноды отключил
 * сценарий, клиенты их не получают. В подсказке — кто, когда и какие Host.
 */
export function HostsOffBadge({ info }: { info: HostsOff }) {
  const at = info.at ? ` в ${hhmm(new Date(info.at).toISOString())}` : '';
  return (
    <span
      title={`${who(info)} отключил${info.rules.length > 1 ? 'и' : ''} Host${at}: ${quoted(info.hosts.map(hostName))}`}
      className="inline-flex flex-none items-center gap-1 rounded-full bg-warn-soft px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-warn"
    >
      <PowerIcon className="size-3" aria-hidden="true" />
      Host отключён · {info.hosts.length}
    </span>
  );
}

const BTN =
  'inline-flex h-9 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5';

/**
 * Блок над метриками в окне ноды: какие Host отключил сценарий и когда, вернёт ли он их сам, и «Вернуть Host сейчас» —
 * если нода так и не восстановилась или возврат в сценарии выключен.
 */
export function HostsOffCard({ info, domain }: { info: HostsOff; domain: string | null }) {
  const restore = useRestoreHostsNow(info.nodeUuid);
  const result = restore.data;
  return (
    <section
      aria-label="Host отключены панелью"
      className="flex flex-col gap-2.5 rounded-[14px] border border-warn/45 bg-warn/[0.06] px-4 py-3.5"
    >
      <div className="flex items-center gap-2 text-[14px] font-semibold text-warn">
        <PowerIcon className="size-4 flex-none" aria-hidden="true" />
        Host отключены панелью
        {info.at && (
          <span className="ml-auto text-[12px] font-medium text-text-3">
            {hhmm(new Date(info.at).toISOString())}
          </span>
        )}
      </div>
      <p className="m-0 text-[12.5px] leading-relaxed text-text-2">
        {who(info)} отключил{info.rules.length > 1 ? 'и' : ''} Host этой ноды: клиенты не получают их в
        подписке.{' '}
        {info.autoRestore
          ? 'Сценарий вернёт их сам, когда нода восстановится.'
          : 'Возврат в сценарии выключен — верните их кнопкой ниже или в Remnawave.'}
      </p>
      <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-border p-0">
        {info.hosts.map((h) => (
          <li
            key={h.uuid}
            className="flex items-center gap-3 border-t border-border bg-surface px-3.5 py-2.5 first:border-t-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{hostName(h)}</span>
              {h.address && (
                <span className="block truncate font-mono text-[11.5px] text-text-3">{h.address}</span>
              )}
            </span>
            <span className="inline-flex flex-none items-center gap-1.5 text-[12px] font-semibold text-warn">
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              Отключён
            </span>
          </li>
        ))}
      </ul>
      {result && result.restored.length > 0 && (
        <p className="m-0 flex items-start gap-1.5 text-[12.5px] leading-snug text-ok">
          <CircleCheckIcon className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
          Вернули: {quoted(result.restored)}
        </p>
      )}
      {result?.failed.map((f) => (
        <p key={f} className="m-0 flex items-start gap-1.5 text-[12.5px] leading-snug text-warn">
          <TriangleAlertIcon className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
          {f}
        </p>
      ))}
      {restore.error && (
        <p role="alert" className="m-0 text-[12.5px] leading-snug text-crit">
          {apiErrorMessage(restore.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={restore.isPending}
          onClick={() =>
            // Итог — всплывашкой: когда Host вернулись, этот блок исчезает вместе с ними.
            restore.mutate(undefined, {
              onSuccess: (r) => {
                if (r.restored.length && !r.failed.length)
                  toast.success(`Host вернули: ${quoted(r.restored)}`);
                else if (r.failed.length)
                  toast.warning(
                    r.restored.length ? `Вернули не все Host: ${quoted(r.restored)}` : 'Host не вернули',
                    {
                      description: r.failed.join('\n'),
                    },
                  );
              },
            })
          }
          className={cn(BTN, 'border-brand/45 bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand')}
        >
          {restore.isPending ? (
            <Loader2Icon className="animate-spin" aria-hidden="true" />
          ) : (
            <PowerIcon aria-hidden="true" />
          )}
          Вернуть Host сейчас
        </button>
        {domain && (
          <a href={`https://${domain}`} target="_blank" rel="noreferrer" className={BTN}>
            <ExternalLinkIcon aria-hidden="true" />
            Открыть Remnawave
          </a>
        )}
      </div>
    </section>
  );
}

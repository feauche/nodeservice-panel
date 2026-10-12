import type { remnaPermissionsSchema } from '@nodeservice/shared';
import { CheckIcon, CircleHelpIcon, InfoIcon, XIcon } from 'lucide-react';
import type { z } from 'zod';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useRemnaPermissions } from './nodes-api';

/** Сколько разрешений проверяет панель: столько строк и у каркаса, чтобы блок не прыгал по высоте. */
const SKELETON_ROWS = 8;

export function ConnectionPermissions({
  enabled,
  preview,
}: {
  enabled: boolean;
  preview?: z.infer<typeof remnaPermissionsSchema> | null;
}) {
  const query = useRemnaPermissions(enabled && !preview);
  const items = (preview ?? query.data)?.items;
  return (
    <div className="mt-4 border-t border-border pt-4">
      <h3 className="text-[14px] font-semibold">Разрешения API-ключа</h3>
      <p className="mt-1 mb-3 text-[12.5px] leading-relaxed text-text-3">
        Чтение проверяется само, права на изменение — при вашем действии. Remnawave не раскрывает список прав
        ключа.
      </p>
      {!preview && query.isError && !items ? (
        <p role="alert" className="text-[12.5px] text-crit">
          Не удалось проверить доступ. Панель повторит проверку сама.
        </p>
      ) : !items ? (
        <div
          role="status"
          aria-label="Проверяем разрешения ключа"
          className="grid gap-x-7 gap-y-3 md:grid-cols-2"
        >
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: каркас — строки одинаковые
            <div key={i} className="flex items-start gap-2.5">
              <Skeleton className="size-4 flex-none rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-[13px] w-[46%]" />
                <Skeleton className="mt-[7px] h-[11px] w-[72%]" />
                <Skeleton className="mt-1.5 h-[10px] w-[38%]" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-x-7 gap-y-3 md:grid-cols-2">
          {items.map((p) => {
            const write = /(?:update|create|delete)/.test(p.scope);
            const Icon =
              p.state === 'granted'
                ? CheckIcon
                : p.state === 'denied'
                  ? XIcon
                  : write
                    ? InfoIcon
                    : CircleHelpIcon;
            return (
              <div key={p.scope} className="flex items-start gap-2.5">
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    p.state === 'granted' ? 'text-ok' : p.state === 'denied' ? 'text-crit' : 'text-text-3',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <b
                      className={cn(
                        'text-[13px] font-semibold',
                        p.state === 'granted'
                          ? 'text-ok'
                          : p.state === 'denied'
                            ? 'text-crit'
                            : 'text-foreground',
                      )}
                    >
                      {p.label}
                    </b>
                    <span
                      className={cn(
                        'rounded-full px-[9px] py-[2px] text-[11px] font-semibold whitespace-nowrap',
                        p.state === 'granted'
                          ? 'bg-ok-soft text-ok'
                          : p.state === 'denied'
                            ? 'bg-crit-soft text-crit'
                            : 'bg-surface-2 text-text-3',
                      )}
                    >
                      {p.state === 'granted'
                        ? 'Доступ подтверждён'
                        : p.state === 'denied'
                          ? 'Нет доступа'
                          : write
                            ? 'Проверится при сохранении'
                            : 'Нет ответа на проверку'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-text-3">{p.why}</p>
                  <code className="font-mono text-[11.5px] text-text-3">{p.scope}</code>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

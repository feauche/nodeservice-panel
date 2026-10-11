import type { remnaPermissionsSchema } from '@nodeservice/shared';
import { CheckIcon, CircleHelpIcon, XIcon } from 'lucide-react';
import type { z } from 'zod';
import { cn } from '@/lib/utils';
import { useRemnaPermissions } from './nodes-api';
export function ConnectionPermissions({
  enabled,
  preview,
}: {
  enabled: boolean;
  preview?: z.infer<typeof remnaPermissionsSchema> | null;
}) {
  const query = useRemnaPermissions(enabled && !preview);
  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="text-[13px] font-semibold">Разрешения API-ключа</h3>
      <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">
        Выдайте ключу права для нужных действий. Чтение проверяется автоматически; права изменения — по
        результату вашего действия. Remnawave не раскрывает список прав API-ключа.
      </p>
      {!preview && query.isPending ? (
        <p className="mt-3 text-xs text-text-3">Проверяем доступ…</p>
      ) : !preview && query.isError ? (
        <p className="mt-3 text-xs text-crit">Не удалось проверить доступ. Повторим автоматически.</p>
      ) : (
        <div className="mt-3 grid gap-x-6 gap-y-3 md:grid-cols-2">
          {(preview ?? query.data)?.items.map((p) => {
            const Icon = p.state === 'granted' ? CheckIcon : p.state === 'denied' ? XIcon : CircleHelpIcon;
            return (
              <div key={p.scope} className="flex items-start gap-2">
                <Icon
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    p.state === 'granted' ? 'text-ok' : p.state === 'denied' ? 'text-crit' : 'text-text-3',
                  )}
                />
                <div className="min-w-0">
                  <div
                    className={cn(
                      'text-[12px] font-medium',
                      p.state === 'granted' ? 'text-ok' : p.state === 'denied' ? 'text-crit' : 'text-text-2',
                    )}
                  >
                    {p.label}
                    <span className="ml-2 text-[10.5px] font-normal">
                      {p.state === 'granted'
                        ? 'Доступ подтверждён'
                        : p.state === 'denied'
                          ? 'Нет доступа'
                          : /(?:update|create|delete)/.test(p.scope)
                            ? 'Проверяется при сохранении'
                            : 'Нет ответа на проверку'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-3">{p.why}</p>
                  <code className="text-[10px] text-text-3">{p.scope}</code>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

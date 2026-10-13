import { BRAND_NAME_DEFAULT, parseBrandName } from '@nodeservice/shared';
import { useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useAppearance } from '@/features/settings/settings-api';
import { cn } from '@/lib/utils';

/** Встроенный логотип: градиентный квадрат с «узлом». */
export function DefaultLogoMark({ className }: { className?: string }) {
  return (
    <img aria-hidden="true" src="/icon-512.png" alt="" className={cn('size-[30px] flex-none', className)} />
  );
}

/**
 * Логотип панели. Если в настройках задана своя ссылка — показывает картинку в той же плитке;
 * если картинка не грузится — молча возвращается к встроенному. Иконка вкладки браузера не меняется.
 * `logoUrl` можно передать явно (превью в настройках), иначе берётся из настроек.
 */
export function BrandLogo({ className, logoUrl }: { className?: string; logoUrl?: string | null }) {
  const appearance = useAppearance();
  const url = logoUrl !== undefined ? logoUrl : (appearance.data?.logoUrl ?? null);
  const [broken, setBroken] = useState<string | null>(null);
  // Первое открытие в этом браузере: настроек ещё нет — силуэт плитки, а не мелькание стандартного логотипа.
  if (logoUrl === undefined && appearance.isPending)
    return <Skeleton aria-hidden="true" className={cn('size-[30px] flex-none rounded-[9px]', className)} />;
  if (!url || broken === url) return <DefaultLogoMark className={className} />;
  return (
    // Своя картинка — без подложки и скругления: прозрачный PNG/SVG показывается как есть.
    // Высота — как у встроенной плитки (30px), ширина подстраивается под пропорции (до 120px).
    <div className={cn('flex h-[30px] max-w-[120px] flex-none items-center', className)}>
      <img
        src={url}
        alt="Логотип"
        className="h-full w-auto max-w-full object-contain"
        draggable={false}
        decoding="async"
        onError={() => setBroken(url)}
      />
    </div>
  );
}

/**
 * Название панели с цветными сегментами (см. parseBrandName в @nodeservice/shared).
 * `name` можно передать явно (превью в настройках), иначе берётся из настроек.
 */
export function BrandName({ className, name }: { className?: string; name?: string }) {
  const appearance = useAppearance();
  if (name === undefined && appearance.isPending)
    return (
      <div className={cn('font-heading font-bold', className)}>
        <Skeleton aria-hidden="true" className="h-[0.95em] w-[8.5em] max-w-full rounded-[6px]" />
      </div>
    );
  const raw = name ?? appearance.data?.brandName ?? BRAND_NAME_DEFAULT;
  const segments = parseBrandName(raw);
  return (
    <div className={cn('font-heading font-bold tracking-[-0.02em] whitespace-pre', className)}>
      {segments.map((s, i) =>
        s.color === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: сегменты статичны и без id
          <span key={i}>{s.text}</span>
        ) : (
          <b
            // biome-ignore lint/suspicious/noArrayIndexKey: сегменты статичны и без id
            key={i}
            className={cn('font-bold', s.color === 'accent' && 'text-brand')}
            style={s.color === 'accent' ? undefined : { color: s.color }}
          >
            {s.text}
          </b>
        ),
      )}
    </div>
  );
}

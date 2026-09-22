import { BRAND_NAME_DEFAULT, parseBrandName } from '@nodeservice/shared';
import { useState } from 'react';

import { useAppearance } from '@/features/settings/settings-api';
import { cn } from '@/lib/utils';

/** Встроенный логотип: градиентный квадрат с «узлом». */
export function DefaultLogoMark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'grid size-[30px] flex-none place-items-center rounded-[10px] bg-[linear-gradient(150deg,var(--ns-accent),var(--ns-teal))] shadow-[0_4px_14px_-4px_var(--ns-accent-soft)] [&_svg]:size-[17px]',
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        role="img"
        aria-label="NodeService"
        stroke="#0c0e12"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="5" r="2.3" />
        <circle cx="5" cy="18" r="2.3" />
        <circle cx="19" cy="18" r="2.3" />
        <path d="M12 7.3v3.4M10.4 12.4 6.6 16M13.6 12.4 17.4 16" />
      </svg>
    </div>
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

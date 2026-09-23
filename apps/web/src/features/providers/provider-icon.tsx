import type { Provider } from '@nodeservice/shared';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { providerIconUrl } from './providers-api';

const SIZE = {
  sm: 'size-[18px] rounded-[5px] text-[10px]',
  md: 'size-6 rounded-[6px] text-[11px]',
  lg: 'size-9 rounded-[10px] text-[15px]',
};

/** Цвет плитки-буквы по названию: стабильный, чтобы «H» у Hetzner всегда одного цвета. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * Иконка провайдера: картинка с сайта, а пока её нет или она не загрузилась — плитка с первой
 * буквой названия. Размер под контекст: карточка, селект, шапка справочника.
 */
export function ProviderIcon({
  provider,
  size = 'md',
  className,
  src,
}: {
  provider: Pick<Provider, 'id' | 'name' | 'hasIcon' | 'iconVersion'> &
    Partial<Pick<Provider, 'iconPending'>>;
  size?: keyof typeof SIZE;
  className?: string;
  /** Явный источник (превью в форме) вместо адреса из API. */
  src?: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const url = src ?? (provider.hasIcon ? providerIconUrl(provider) : null);
  if (url && !broken) {
    return (
      <img
        src={url}
        alt=""
        width={24}
        height={24}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cn('flex-none object-contain', SIZE[size], className)}
        data-testid="provider-icon"
      />
    );
  }
  const letter = (provider.name.trim()[0] ?? '?').toUpperCase();
  const pending = provider.iconPending && src === undefined;
  return (
    <span
      aria-hidden="true"
      data-testid={pending ? 'provider-icon-pending' : 'provider-icon-fallback'}
      title={pending ? 'Ищем иконку…' : undefined}
      className={cn(
        pending && 'animate-pulse',
        'grid flex-none place-items-center font-bold text-white select-none',
        SIZE[size],
        className,
      )}
      style={{ background: `hsl(${hue(provider.name)} 55% 48%)` }}
    >
      {letter}
    </span>
  );
}

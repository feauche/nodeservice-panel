import { countryName, isCountryCode } from '@nodeservice/shared';
import { GlobeIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Флаги стран: SVG из пакета country-flag-icons (формат 3x2, MIT), самохостные, без CDN. Каждый флаг
 * подгружается отдельным запросом и только когда он нужен на экране; у стран без флага в наборе — глобус.
 * Эмодзи-флаги не используем: в Windows они показываются двумя буквами.
 */
const loaders = import.meta.glob<string>('../../node_modules/country-flag-icons/3x2/*.svg', {
  query: '?url',
  import: 'default',
});

const byCode = new Map<string, () => Promise<string>>();
for (const [path, load] of Object.entries(loaders)) {
  const code = path.split('/').pop()?.replace('.svg', '');
  if (code) byCode.set(code.toUpperCase(), load);
}

const urlCache = new Map<string, string | null>();

/** Есть ли флаг в наборе: у остальных стран показывается глобус. */
export const hasFlag = (code: string): boolean => byCode.has(code.toUpperCase());

function useFlagUrl(code: string): string | null | undefined {
  const upper = code.toUpperCase();
  const [url, setUrl] = useState<string | null | undefined>(() => urlCache.get(upper));
  useEffect(() => {
    if (urlCache.has(upper)) {
      setUrl(urlCache.get(upper));
      return;
    }
    const load = byCode.get(upper);
    if (!load) {
      urlCache.set(upper, null);
      setUrl(null);
      return;
    }
    let alive = true;
    load()
      .then((u) => {
        urlCache.set(upper, u);
        if (alive) setUrl(u);
      })
      .catch(() => {
        urlCache.set(upper, null);
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [upper]);
  return url;
}

/** Размеры: sm — в списках и подсказках, md — в поле и на плитке карточки, lg — в шапках. */
const SIZE = {
  sm: 'h-[12px] w-[16px] rounded-[2.5px]',
  md: 'h-[15px] w-[20px] rounded-[3px]',
  lg: 'h-[19.5px] w-[26px] rounded-[3.5px]',
} as const;

export function CountryFlag({
  code,
  size = 'md',
  className,
  decorative,
}: {
  code: string;
  size?: keyof typeof SIZE;
  className?: string;
  /** Рядом уже написано название страны: картинка без собственной подписи. */
  decorative?: boolean;
}) {
  const url = useFlagUrl(code);
  const name = isCountryCode(code.toUpperCase()) ? countryName(code) : code;
  const box = cn('inline-block flex-none align-[-3px]', SIZE[size], className);
  if (url === undefined)
    return <span aria-hidden="true" data-testid="country-flag-loading" className={cn(box, 'bg-surface-3')} />;
  if (url === null) {
    const cls = cn(box, 'grid place-items-center border border-dashed border-border-2 text-text-3');
    const globe = <GlobeIcon className="size-[10px]" aria-hidden="true" />;
    return decorative ? (
      <span aria-hidden="true" data-testid="country-flag-none" className={cls}>
        {globe}
      </span>
    ) : (
      <span role="img" aria-label={name} data-testid="country-flag-none" className={cls}>
        {globe}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={decorative ? '' : name}
      aria-hidden={decorative ? true : undefined}
      data-code={code.toUpperCase()}
      draggable={false}
      className={cn(box, 'object-cover shadow-[0_0_0_1px_rgba(128,128,128,0.4)]')}
    />
  );
}

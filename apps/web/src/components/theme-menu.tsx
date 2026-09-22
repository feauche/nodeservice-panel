import { CheckIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isThemeKey, setTheme, THEMES, type ThemeKey } from '@/features/theme/theme';
import { ThemeIcon } from '@/features/theme/theme-icon';
import { useTheme } from '@/features/theme/use-theme';
import { cn } from '@/lib/utils';

/* ---------- образцы тем (как .topt .sw в демо) ---------- */
const SWATCH: Record<ThemeKey, { bg: string; line: string; accent: string; border?: string }> = {
  dark: { bg: '#171c25', line: '#373f51', accent: '#6ea8fe', border: '#373f51' },
  light: { bg: '#ffffff', line: '#dfe4ec', accent: '#2f6fe0' },
  black: { bg: '#000000', line: '#2d2d33', accent: '#5fe3cf', border: '#2d2d33' },
};

/** Миниатюра темы: подложка + три полоски, одна акцентная. */
export function Swatch({ theme, className }: { theme: ThemeKey; className?: string }) {
  const s = SWATCH[theme];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative h-[22px] w-[34px] flex-none overflow-hidden rounded-[7px] border border-border-2',
        className,
      )}
      style={{ background: s.bg, borderColor: s.border }}
    >
      <i
        className="absolute top-[5px] right-1.5 left-1.5 h-[3px] rounded-[2px]"
        style={{ background: s.line }}
      />
      <i
        className="absolute top-[11px] right-3.5 left-1.5 h-[3px] rounded-[2px]"
        style={{ background: s.line }}
      />
      <i
        className="absolute top-[11px] right-1.5 left-6 h-[3px] rounded-[2px]"
        style={{ background: s.accent }}
      />
    </span>
  );
}

/** Кнопка-иконка 36px с выпадающим списком тем — одна и та же в шапке панели и на экранах входа. */
export function ThemeMenu({ className }: { className?: string }) {
  const theme = useTheme();
  const name = THEMES.find((t) => t.key === theme)?.name ?? '';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={`Тема: ${name}`}
        aria-label={`Тема: ${name}`}
        className={cn(
          'grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface text-text-2 transition-colors hover:border-border-2 hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 aria-expanded:bg-surface-3 aria-expanded:text-foreground [&_svg]:size-[17px]',
          className,
        )}
      >
        <ThemeIcon theme={theme} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[250px] rounded-[14px] border border-border-2 p-1.5 shadow-float"
      >
        <DropdownMenuLabel className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.1em] text-text-3 uppercase">
          Тема
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => {
            if (isThemeKey(v)) setTheme(v);
          }}
        >
          {THEMES.map((t) => (
            <DropdownMenuRadioItem
              key={t.key}
              value={t.key}
              className="w-full gap-[11px] rounded-[10px] px-2.5 py-[9px] pr-2.5 text-text-2 focus:bg-surface-2 focus:text-foreground data-[state=checked]:text-foreground [&>span:first-child]:hidden"
            >
              <Swatch theme={t.key} />
              <span className="min-w-0 flex-1">
                <b className="block text-[13px] font-semibold">{t.name}</b>
                <span className="mt-px block text-[11px] text-text-3">{t.description}</span>
              </span>
              <CheckIcon
                className={cn('size-4 flex-none text-brand', theme === t.key ? 'opacity-100' : 'opacity-0')}
                aria-hidden="true"
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

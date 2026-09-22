import { CheckIcon } from 'lucide-react';

import { Swatch } from '@/components/theme-menu';
import { setTheme, THEMES } from '@/features/theme/theme';
import { useTheme } from '@/features/theme/use-theme';
import { cn } from '@/lib/utils';
import { BrandCard } from './brand-card';
import { SettingsCard } from './settings-ui';

export function AppearancePage() {
  const theme = useTheme();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SettingsCard
        className="flex flex-col"
        title="Тема"
        hint="Как выглядит панель: три варианта, переключаются мгновенно."
      >
        <div className="mt-3 flex flex-wrap gap-2">
          {THEMES.map((t) => {
            const on = t.key === theme;
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={on}
                onClick={() => setTheme(t.key)}
                className={cn(
                  'flex min-w-0 flex-[1_1_100%] cursor-pointer items-center gap-[11px] rounded-[10px] border px-3 py-[9px] text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2',
                  on
                    ? 'border-brand bg-brand-soft text-foreground'
                    : 'border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground',
                )}
              >
                <Swatch theme={t.key} />
                <span className="min-w-0 flex-1">
                  <b className="block text-[13px] font-semibold">{t.name}</b>
                  <span className="mt-px block text-[11px] text-text-3">{t.description}</span>
                </span>
                <CheckIcon
                  className={cn('size-4 flex-none text-brand', on ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11.5px] text-text-3">Тема хранится в этом браузере.</p>
      </SettingsCard>
      <BrandCard />
    </div>
  );
}

import { CheckIcon, SunIcon } from 'lucide-react';

import { Swatch } from '@/components/theme-menu';
import { setTheme, THEMES } from '@/features/theme/theme';
import { useTheme } from '@/features/theme/use-theme';
import { cn } from '@/lib/utils';
import { BrandCard } from './brand-card';
import { SectionHeader, SettingsCard } from './settings-ui';
import { TimeZoneCard } from './time-zone-card';

export function AppearancePage() {
  const theme = useTheme();
  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        icon={SunIcon}
        title="Внешний вид"
        description="Тема применяется сразу и хранится в этом браузере. Часовой пояс — сразу и для всех. Логотип и название — для всех, по кнопке «Сохранить»."
      />
      <SettingsCard title="Тема" hint="Три варианта, переключаются мгновенно.">
        <div className="grid gap-2.5 py-3 sm:grid-cols-3">
          {THEMES.map((t) => {
            const on = t.key === theme;
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={on}
                onClick={() => setTheme(t.key)}
                className={cn(
                  'flex min-w-0 cursor-pointer items-center gap-[11px] rounded-[11px] border px-3 py-[10px] text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2',
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
      </SettingsCard>
      <TimeZoneCard />
      <BrandCard />
    </div>
  );
}

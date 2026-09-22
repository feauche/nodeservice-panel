import type { ReactNode, Ref } from 'react';

import { BrandLogo, BrandName } from '@/components/brand-logo';
import { ThemeMenu } from '@/components/theme-menu';
import { cn } from '@/lib/utils';

interface AuthShellProps {
  children: ReactNode;
  /** 560px вместо 420px — для QR и кодов восстановления. */
  wide?: boolean;
  /** Подпись под карточкой. */
  foot?: ReactNode;
  /** Скрыть логотип (экран блокировки рисует шапку сам). */
  hideLogo?: boolean;
  /** Ключ анимации — при смене содержимое «въезжает» заново. */
  animKey?: string;
  /**
   * Боковая панель слева (мастер первого запуска): карточка становится двухколоночной
   * 340px + форма, до 900px; на узких экранах панель встаёт над формой.
   */
  side?: ReactNode;
}

/** Полноэкранный слой со свечением, карточка по центру, переключатель темы справа сверху. */
export function AuthShell({ children, wide, foot, hideLogo, animKey, side }: AuthShellProps) {
  return (
    <div className="fixed inset-0 z-100 flex flex-col items-center overflow-y-auto overscroll-contain bg-background p-6 phone:p-4">
      <div aria-hidden="true" className="auth-bg pointer-events-none fixed inset-0" />
      <div className="fixed top-[18px] right-[18px] z-1 phone:top-3 phone:right-3">
        <ThemeMenu />
      </div>

      {side ? (
        <main className="relative mt-auto grid w-full max-w-[900px] min-w-0 animate-modin grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-[18px] border border-border-2 bg-surface shadow-float max-md:grid-cols-1">
          <aside className="flex flex-col border-r border-border bg-bg-2 p-[34px_30px] max-md:border-r-0 max-md:border-b max-md:p-[22px_20px_18px]">
            {side}
          </aside>
          <div key={animKey} className="animate-fade p-[34px_36px] max-md:p-[24px_20px]">
            {children}
          </div>
        </main>
      ) : (
        <main
          key={animKey}
          className={cn(
            'relative mt-auto w-full min-w-0 animate-modin rounded-2xl border border-border-2 bg-surface p-[30px_30px_26px] shadow-float phone:p-[24px_20px]',
            wide ? 'max-w-[560px]' : 'max-w-[420px]',
          )}
        >
          {!hideLogo && (
            <div className="mb-[22px] flex items-center gap-[11px]">
              <BrandLogo className="size-9 [&_svg]:size-5" />
              <BrandName className="text-lg" />
            </div>
          )}
          {children}
        </main>
      )}

      <div className="relative mt-[18px] mb-auto max-w-[420px] text-center text-[11.5px] leading-[1.6] text-text-3">
        {foot}
      </div>
    </div>
  );
}

interface AuthHeadingProps {
  title: string;
  children?: ReactNode;
  /** Для программного фокуса (шаг 3 мастера): ref + tabIndex={-1}. */
  ref?: Ref<HTMLHeadingElement>;
  tabIndex?: number;
}

/** Заголовок карточки + подзаголовок (h2 20px / sub 13px). */
export function AuthHeading({ title, children, ref, tabIndex }: AuthHeadingProps) {
  return (
    <>
      <h2 ref={ref} tabIndex={tabIndex} className="mb-[5px] text-xl outline-none">
        {title}
      </h2>
      {children && (
        <div className="mb-5 text-[13px] leading-normal text-text-2 [&_b]:font-semibold [&_b]:text-foreground">
          {children}
        </div>
      )}
    </>
  );
}

/** Ссылки под формой: «Забыли пароль?» / «← Назад» и приглушённая подпись справа. */
export function AuthLinks({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[12.5px]">{children}</div>
  );
}

export const linkClass =
  'cursor-pointer rounded-[4px] bg-transparent p-0 text-brand transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2';

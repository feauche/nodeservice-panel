import { CheckIcon } from 'lucide-react';

import { BrandLogo, BrandName } from '@/components/brand-logo';
import { cn } from '@/lib/utils';

export const SETUP_STEPS = [
  { title: 'Учётная запись', hint: 'Токен, логин и пароль администратора' },
  { title: 'Двухфакторная защита', hint: 'QR-код для приложения-аутентификатора' },
  { title: 'Коды восстановления', hint: 'Запасной вход, если телефон недоступен' },
] as const;

/** Боковая панель мастера первого запуска: логотип, что предстоит, три шага с текущим. */
export function SetupSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <>
      <div className="mb-8 flex items-center gap-[11px] max-md:mb-5">
        <BrandLogo className="size-9 [&_svg]:size-5" />
        <BrandName className="text-lg" />
      </div>
      <h2 className="mb-2.5 text-[22px] leading-[1.2] max-md:text-xl">Первый запуск панели</h2>
      <p className="mb-6 text-[13px] leading-normal text-text-2 max-md:mb-4">
        Три коротких шага. После них мастер исчезает, и вход возможен только с паролем и кодом 2FA.
      </p>
      <ol className="flex flex-col gap-0.5" aria-label={`Шаг ${current} из ${SETUP_STEPS.length}`}>
        {SETUP_STEPS.map((s, i) => {
          const n = i + 1;
          const state = n === current ? 'current' : n < current ? 'done' : 'todo';
          return (
            <li
              key={s.title}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'grid grid-cols-[26px_1fr] items-start gap-3 rounded-[10px] px-2.5 py-2.5 text-[13px] text-text-3',
                state === 'current' && 'bg-brand-soft text-foreground',
                state === 'done' && 'text-text-2',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-[26px] place-items-center rounded-[8px] border border-border-2 font-mono text-xs',
                  state === 'current' && 'border-transparent bg-brand text-(--ns-on-accent)',
                  state === 'done' && 'border-transparent bg-ok-soft text-ok',
                )}
              >
                {state === 'done' ? <CheckIcon className="size-3.5" strokeWidth={3} /> : n}
              </span>
              <span className="min-w-0">
                <b className="block font-semibold">{s.title}</b>
                <small className="mt-px block text-[11.5px] leading-snug max-md:hidden">{s.hint}</small>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-auto pt-6 text-[11.5px] leading-normal text-text-3 max-md:hidden">
        Панель управляет всеми вашими серверами и хранит доступы к ним, поэтому 2FA обязательна.
      </p>
    </>
  );
}

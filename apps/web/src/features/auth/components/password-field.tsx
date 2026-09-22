import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { type ComponentProps, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { AuthInput } from './field';

type PasswordFieldProps = Omit<ComponentProps<typeof AuthInput>, 'type'>;

/** Пароль с кнопкой-глазом. Кнопка вне tab-порядка — как в демо; после клика фокус возвращается в поле. */
export function PasswordField({ className, ref, ...props }: PasswordFieldProps) {
  const [show, setShow] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="relative">
      <AuthInput
        ref={(el) => {
          inputRef.current = el;
          if (typeof ref === 'function') return ref(el);
          if (ref) ref.current = el;
        }}
        type={show ? 'text' : 'password'}
        placeholder="••••••••••••"
        autoComplete="current-password"
        className={cn('pr-[42px]', className)}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
        onClick={() => {
          setShow((v) => !v);
          inputRef.current?.focus({ preventScroll: true });
        }}
        className="absolute top-1/2 right-1.5 grid size-[30px] -translate-y-1/2 cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground [&_svg]:size-4"
      >
        {show ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
      </button>
    </div>
  );
}

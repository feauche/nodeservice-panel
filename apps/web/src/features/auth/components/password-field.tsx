import { EyeIcon, EyeOffIcon, SparklesIcon } from 'lucide-react';
import { type ComponentProps, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { AuthInput } from './field';

interface PasswordFieldProps extends Omit<ComponentProps<typeof AuthInput>, 'type'> {
  /** Показать пароль открытым текстом (управляемый режим: вместе с onShowChange). */
  show?: boolean;
  onShowChange?: (show: boolean) => void;
  /** Кнопка «Сгенерировать надёжный пароль» слева от глаза. */
  onGenerate?: () => void;
}

const toolClass =
  'grid size-[30px] cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:-outline-offset-2 [&_svg]:size-4';

/**
 * Пароль с кнопкой-глазом (вне tab-порядка, после клика фокус возвращается в поле)
 * и, если передан onGenerate, кнопкой генерации (в tab-порядке — это действие, а не переключатель).
 */
export function PasswordField({
  className,
  ref,
  show: showProp,
  onShowChange,
  onGenerate,
  ...props
}: PasswordFieldProps) {
  const [showState, setShowState] = useState(false);
  const show = showProp ?? showState;
  const setShow = (v: boolean) => {
    setShowState(v);
    onShowChange?.(v);
  };
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
        className={cn(onGenerate ? 'pr-[74px]' : 'pr-[42px]', className)}
        {...props}
      />
      <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-0.5">
        {onGenerate && (
          <button
            type="button"
            aria-label="Сгенерировать надёжный пароль"
            title="Сгенерировать надёжный пароль"
            onClick={onGenerate}
            className={toolClass}
          >
            <SparklesIcon aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
          title={show ? 'Скрыть пароль' : 'Показать пароль'}
          onClick={() => {
            setShow(!show);
            inputRef.current?.focus({ preventScroll: true });
          }}
          className={toolClass}
        >
          {show ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

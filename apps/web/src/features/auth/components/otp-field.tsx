import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { type Ref, useId } from 'react';

import { InputOTP, InputOTPSlot } from '@/components/ui/input-otp';
import { cn } from '@/lib/utils';

interface OtpFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** Все 6 цифр введены — вызывается один раз на заполнение. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  /** Подсветить красным и тряхнуть. */
  invalid?: boolean;
  autoFocus?: boolean;
  id?: string;
  /** Ссылка на настоящий <input> — чтобы вернуть фокус после паузы. */
  ref?: Ref<HTMLInputElement>;
  'aria-describedby'?: string;
}

const slotClass =
  'h-[52px] w-auto flex-1 rounded-[10px] border border-border bg-surface-2 font-mono text-[22px] font-semibold text-foreground first:rounded-l-[10px] last:rounded-r-[10px] dark:bg-surface-2 data-[active=true]:border-brand data-[active=true]:ring-3 data-[active=true]:ring-brand-soft phone:h-[46px] phone:text-[19px]';

/**
 * 6 клеток для кода из приложения. Вставка, Backspace и стрелки — из input-otp;
 * автоотправка через onComplete. Один настоящий <input> под клетками — autocomplete=one-time-code.
 */
export function OtpField({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  autoFocus,
  id,
  ref,
  ...aria
}: OtpFieldProps) {
  const autoId = useId();
  return (
    <InputOTP
      ref={ref}
      id={id ?? autoId}
      maxLength={6}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label="Код из приложения, 6 цифр"
      aria-invalid={invalid || undefined}
      aria-describedby={aria['aria-describedby']}
      containerClassName={cn('w-full gap-2 phone:gap-1.5', invalid && 'animate-shake')}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <InputOTPSlot key={i} index={i} className={cn(slotClass, invalid && 'border-crit')} />
      ))}
    </InputOTP>
  );
}

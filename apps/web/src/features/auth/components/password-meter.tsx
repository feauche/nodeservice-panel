import { cn } from '@/lib/utils';
import { passwordStrength } from './password-strength';

const SEGMENT_COLOR = ['', 'bg-crit', 'bg-warn', 'bg-brand', 'bg-ok'] as const;

/** 4 сегмента + подпись. Цвет сегментов зависит от уровня: crit → warn → accent → ok. */
interface PasswordMeterProps {
  value: string;
  id?: string;
  className?: string;
  /** Подсказка при пустом поле (например, про кнопку генерации). */
  emptyHint?: string;
}

export function PasswordMeter({ value, id, className, emptyHint }: PasswordMeterProps) {
  const { level, label } = passwordStrength(value, emptyHint);
  const color = SEGMENT_COLOR[level];
  return (
    <div id={id} className={className}>
      <div className="mt-2 flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <i
            key={i}
            data-testid="pw-seg"
            data-on={i < level ? 'true' : undefined}
            className={cn('h-1 flex-1 rounded-[2px] bg-surface-3 transition-colors', i < level && color)}
          />
        ))}
      </div>
      <p className="mt-[5px] text-[11.5px] leading-[1.4] text-text-3" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

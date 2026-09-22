import { cn } from '@/lib/utils';
import { passwordStrength } from './password-strength';

const SEGMENT_COLOR = ['', 'bg-crit', 'bg-warn', 'bg-brand', 'bg-ok'] as const;

/** 4 сегмента + подпись. Цвет сегментов зависит от уровня: crit → warn → accent → ok. */
export function PasswordMeter({ value, id }: { value: string; id?: string }) {
  const { level, label } = passwordStrength(value);
  const color = SEGMENT_COLOR[level];
  return (
    <div id={id}>
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
      <p className="mt-[5px] text-[11px] leading-[1.4] text-text-3" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

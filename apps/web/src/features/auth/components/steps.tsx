import { cn } from '@/lib/utils';

/** Прогресс мастера: 3 полоски — пройдено (ok), текущий (accent), впереди (surface-3). */
export function Steps({ current, total = 3 }: { current: number; total?: number }) {
  return (
    <div className="mb-5 flex gap-1.5" role="img" aria-label={`Шаг ${current} из ${total}`}>
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <i
          key={n}
          className={cn(
            'h-1 flex-1 rounded-[2px] bg-surface-3 transition-colors duration-300',
            n < current && 'bg-ok',
            n === current && 'bg-brand',
          )}
        />
      ))}
    </div>
  );
}

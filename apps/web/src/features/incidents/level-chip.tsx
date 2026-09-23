import { ACTION_LEVEL_LABELS, type ActionLevel } from '@nodeservice/shared';

import { cn } from '@/lib/utils';

const TONE: Record<ActionLevel, string> = {
  T0: 'border-border-2 bg-surface-2 text-text-3',
  T1: 'border-ok/40 bg-ok-soft text-ok',
  T2: 'border-warn/40 bg-warn-soft text-warn',
  T3: 'border-crit/40 bg-crit-soft text-crit',
};

/** Уровень действия T0–T3 — маленький моноширинный чип, одинаковый в хронологии, карточках и реестре. */
export function LevelChip({ level, className }: { level: ActionLevel; className?: string }) {
  return (
    <span
      title={ACTION_LEVEL_LABELS[level]}
      className={cn(
        'inline-flex h-[18px] flex-none items-center rounded-[5px] border px-1.5 font-mono text-[10.5px] font-bold tracking-wide',
        TONE[level],
        className,
      )}
    >
      {level}
    </span>
  );
}

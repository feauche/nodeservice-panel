import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/** Рамка окна с шапкой и полосой действий: прокручивается только середина (одинаково во всех окнах интеграций). */
export const dialogBox =
  'flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0';
/** Тёмная полоса снизу, в ней подсказка слева и кнопки справа; на телефоне — столбиком. */
export const dialogFoot =
  'flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4';
/** Кнопка полосы: одинаковые высота и ширина у «Отмена» и главного действия. */
export const footButton = 'h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:flex-none sm:max-w-none';

export function DialogHead({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 max-sm:px-4">
      <div className="min-w-0 flex-1">
        <DialogTitle className="font-heading text-[17px] break-words">{title}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[12.5px] text-text-3">{description}</DialogDescription>
      </div>
      <DialogClose
        aria-label="Закрыть окно"
        className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <XIcon className="size-4" aria-hidden="true" />
      </DialogClose>
    </div>
  );
}

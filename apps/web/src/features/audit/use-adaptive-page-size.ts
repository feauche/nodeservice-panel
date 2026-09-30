import { AUDIT_PAGE_SIZE_DEFAULT } from '@nodeservice/shared';
import type { RefObject } from 'react';

import { useAvailableHeight } from '@/lib/use-available-height';

export const AUDIT_ROW_HEIGHT = 44;
/** Ниже этого не сжимаем даже на очень низком окне — но и не задираем искусственно выше того, что
 * реально помещается: на низких окнах именно требование «показать не меньше N строк» и вызывало
 * прокрутку страницы (10 строк не помещались, а показать всё равно требовалось). */
const MIN_ROWS = 5;
const MAX_ROWS = 100;

/**
 * Место под строку пагинации под таблицей: отступ `gap-3` (12px) + сама строка (32px, кнопки `h-8`).
 * Остаток от деления доступной высоты на высоту строки и становится нижним полем — оно того же
 * порядка, что и боковые отступы страницы, а не отдельным зазором поверх них (было 64px: этого хватало
 * на саму пагинацию, но раздутый запас добавлял лишние 20–40px пустоты снизу, заметно больше боковых).
 */
const PAGINATION_ROW_HEIGHT = 12 + 32;

/**
 * Сколько строк помещается на экране: от верха таблицы до низа прокручиваемой области минус место
 * под пагинацию (измерение — useAvailableHeight, пересчёт при resize, требование 13.3).
 * В тестах (jsdom, нулевые размеры) — значение по умолчанию.
 */
export function useAdaptivePageSize(
  ref: RefObject<HTMLElement | null>,
  reservedBelow = PAGINATION_ROW_HEIGHT,
): number {
  const available = useAvailableHeight(ref, reservedBelow);
  if (!available) return AUDIT_PAGE_SIZE_DEFAULT;
  // -1: строка заголовка таблицы
  const rows = Math.floor(available / AUDIT_ROW_HEIGHT) - 1;
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows));
}

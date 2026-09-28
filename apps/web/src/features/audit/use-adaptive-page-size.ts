import { AUDIT_PAGE_SIZE_DEFAULT } from '@nodeservice/shared';
import { type RefObject, useLayoutEffect, useState } from 'react';

export const AUDIT_ROW_HEIGHT = 44;
/** Ниже этого не сжимаем даже на очень низком окне — но и не задираем искусственно выше того, что
 * реально помещается: на низких окнах именно требование «показать не меньше N строк» и вызывало
 * прокрутку страницы (10 строк не помещались, а показать всё равно требовалось). */
const MIN_ROWS = 5;
const MAX_ROWS = 100;

/** Ближайший прокручиваемый предок (контент AppShell); null — прокручивается окно. */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Место под строку пагинации под таблицей: отступ `gap-3` (12px) + сама строка (32px, кнопки `h-8`).
 * Остаток от деления доступной высоты на высоту строки и становится нижним полем — оно того же
 * порядка, что и боковые отступы страницы, а не отдельным зазором поверх них (было 64px: этого хватало
 * на саму пагинацию, но раздутый запас добавлял лишние 20–40px пустоты снизу, заметно больше боковых).
 */
const PAGINATION_ROW_HEIGHT = 12 + 32;

/**
 * Сколько строк помещается на экране: от верха таблицы до низа прокручиваемой области минус место
 * под пагинацию. Считается относительно контейнера (а не окна), поэтому прокрутка внутри страницы —
 * например, при раскрытии деталей — размер не меняет. Пересчёт при resize (требование 13.3).
 * В тестах (jsdom, нулевые размеры) — значение по умолчанию.
 */
export function useAdaptivePageSize(
  ref: RefObject<HTMLElement | null>,
  reservedBelow = PAGINATION_ROW_HEIGHT,
): number {
  const [size, setSize] = useState(AUDIT_PAGE_SIZE_DEFAULT);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = findScrollParent(el);
    let frame = 0;
    const measure = () => {
      let available: number;
      if (scroller) {
        const offsetTop =
          el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        available = scroller.clientHeight - offsetTop - reservedBelow;
      } else {
        available = window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - reservedBelow;
      }
      if (!Number.isFinite(available) || available <= 0) return;
      // -1: строка заголовка таблицы
      const rows = Math.floor(available / AUDIT_ROW_HEIGHT) - 1;
      setSize(Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows)));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // Следим за размером контейнера (сворачивание меню, resize) и за всем блоком страницы целиком —
    // не только за таблицей. Если то, что стоит НАД таблицей, вырастет (например, панель фильтров
    // перенесётся на вторую строку при более длинной подписи индикатора Live), сам контейнер прокрутки
    // не изменится в размере, «верх таблицы» тихо сместится вниз, а число строк останется прежним —
    // получится лишний скролл страницы. Наблюдение за родителем таблицы ловит и такие случаи тоже.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(scroller ?? document.documentElement);
    if (el.parentElement) ro?.observe(el.parentElement);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [ref, reservedBelow]);

  return size;
}

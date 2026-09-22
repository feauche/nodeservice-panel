import { AUDIT_PAGE_SIZE_DEFAULT } from '@nodeservice/shared';
import { type RefObject, useLayoutEffect, useState } from 'react';

export const AUDIT_ROW_HEIGHT = 44;
const MIN_ROWS = 10;
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
 * Сколько строк помещается на экране: от верха таблицы до низа прокручиваемой области минус место
 * под пагинацию. Считается относительно контейнера (а не окна), поэтому прокрутка внутри страницы —
 * например, при раскрытии деталей — размер не меняет. Пересчёт при resize (требование 13.3).
 * В тестах (jsdom, нулевые размеры) — значение по умолчанию.
 */
export function useAdaptivePageSize(ref: RefObject<HTMLElement | null>, reservedBelow = 64): number {
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
    // Следим за размером контейнера (сворачивание меню, resize), а не самой таблицы —
    // её высота меняется при каждом раскрытии строки.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(scroller ?? document.documentElement);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [ref, reservedBelow]);

  return size;
}

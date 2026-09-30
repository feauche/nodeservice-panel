import { type RefObject, useLayoutEffect, useState } from 'react';

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
 * Верх элемента внутри прокручиваемого контейнера по раскладке (offsetTop), а не по getBoundingClientRect:
 * страница появляется со сдвигом (`animate-fade`, translateY 4px → 0), и замер по прямоугольнику в это время
 * врал на эти пиксели — размер страницы считался по заниженной высоте и потом уже не пересчитывался.
 * null — цепочку offsetParent пройти не удалось (элемент скрыт), тогда считаем по прямоугольнику.
 */
function layoutTop(el: HTMLElement, scroller: HTMLElement): number | null {
  let top = 0;
  let node: HTMLElement = el;
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent) return null;
    top += node.offsetTop;
    if (parent === scroller) return top;
    // Контейнер не позиционирован, и цепочка его проскочила: оба отсчитаны от одного предка.
    if (parent.contains(scroller))
      return scroller.offsetParent === parent ? top - scroller.offsetTop - scroller.clientTop : null;
    top += parent.clientTop;
    node = parent;
  }
  return null;
}

/**
 * Высота от верха элемента до низа прокручиваемой области минус `reservedBelow` (место под то, что стоит
 * ниже: пагинация, поле). Считается относительно контейнера, а не окна, поэтому прокрутка внутри страницы
 * размер не меняет. Пересчёт — при изменении окна, контейнера и всего, что стоит над элементом.
 *
 * undefined — ещё не измеряли (первый кадр); null — измерить нельзя (тесты в jsdom, скрытая вкладка):
 * тогда вызывающий берёт своё значение по умолчанию. Удачное измерение неудачным не затирается.
 */
export function useAvailableHeight(
  ref: RefObject<HTMLElement | null>,
  reservedBelow: number,
): number | null | undefined {
  const [available, setAvailable] = useState<number | null | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setAvailable((cur) => cur ?? null);
      return;
    }
    const scroller = findScrollParent(el);
    let frame = 0;
    const measure = () => {
      let value: number;
      if (scroller) {
        const offsetTop =
          layoutTop(el, scroller) ??
          el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        value = scroller.clientHeight - offsetTop - reservedBelow;
      } else {
        value = window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - reservedBelow;
      }
      if (!Number.isFinite(value) || value <= 0) {
        setAvailable((cur) => cur ?? null);
        return;
      }
      setAvailable(Math.floor(value));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // Следим за размером контейнера (сворачивание меню, resize) и за всем блоком страницы целиком —
    // не только за самим элементом. Если то, что стоит НАД ним, вырастет (например, панель фильтров
    // перенесётся на вторую строку), контейнер прокрутки в размере не изменится, «верх» тихо сместится
    // вниз, а число строк останется прежним — получится лишний скролл страницы.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(scroller ?? document.documentElement);
    if (el.parentElement) ro?.observe(el.parentElement);
    // Блоки над страницей (заголовок раздела) лежат вне родителя элемента: их высота меняется, например,
    // когда догружается шрифт, — без наблюдения «верх» сместился бы незаметно для расчёта.
    for (const child of scroller?.children ?? []) ro?.observe(child);
    let alive = true;
    document.fonts?.ready.then(() => alive && schedule()).catch(() => undefined);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [ref, reservedBelow]);

  return available;
}

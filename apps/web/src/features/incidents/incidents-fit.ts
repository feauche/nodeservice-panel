/**
 * Реестр инцидентов по высоте окна (просьба владельца 30.09.2026): на странице столько решённых, сколько
 * помещается, а нижнее поле под реестром — такое же, как боковые. Сколько строк помещается, зависит от
 * числа заголовков дней на странице (при редких сбоях каждый день — свой заголовок), а оно заранее не
 * известно. Поэтому панель запрашивает строки с запасом и показывает ровно столько, сколько помещается:
 * страницы получаются разной длины, зато реестр всегда кончается у нижнего поля — без прокрутки и пустоты.
 * Остаток меньше одной строки раздаётся строкам по пикселю.
 * Работает на широком экране; на телефоне строки разной высоты и страница просто листается.
 */

/** Обычная высота строки реестра на широком экране (её задаёт min-height строки). */
export const ROW_HEIGHT = 59;
/** Сжатая строка: две строки текста и минимальные поля — ниже текст уже не помещается. */
export const ROW_MIN = 52;
/** Больше этого строку не растягиваем: короткая страница (конец списка) остаётся короткой. */
export const ROW_MAX = 72;
/**
 * Предел растяжения на полной странице — когда дальше есть ещё строки, но следующая уже не помещается даже
 * сжатой. Это бывает при трёх-четырёх строках на странице (низкое окно, редкие сбои): лучше строки повыше,
 * чем пустота под реестром. Больше 82 при трёх и более строках не нужно никогда.
 */
export const ROW_MAX_FULL = 84;
/** Заголовок группы («Сейчас», «Сегодня · 10 сбоев») — фиксированной высоты. */
export const GROUP_HEIGHT = 36;
/** Рамка карточки реестра сверху и снизу. */
export const LIST_BORDER = 2;
/** Поле под реестром — как боковые поля страницы. */
export const BOTTOM_GAP = 26;
/** Строка с номерами страниц вместе с отступом до реестра. */
export const FOOTER_HEIGHT = 16 + 32;

/** Размер страницы, пока высота не измерена (телефон, тесты): обычное листание по десять. */
export const FALLBACK_PAGE_SIZE = 10;
/** Границы размера запроса: меньше пяти сервер не отдаёт. */
const MIN_REQUEST = 5;
const MAX_REQUEST = 100;
/**
 * Не помещается ни одной решённой строки (окно совсем низкое или открытых инцидентов больше, чем влезает) —
 * подгонять нечего: показываем столько строк обычной высоты, и листается страница.
 */
export const CRAMPED_VISIBLE = 5;

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/**
 * Сколько решённых запросить. `available` — высота под карточку реестра; открытые («Сейчас») показываются
 * целиком и место занимают первыми. Берём с запасом — столько, сколько поместилось бы сжатыми строками при
 * одном дне: лишнее просто не показывается (см. visibleCount).
 */
export function requestSize(available: number | null, openRows: number): number {
  if (available === null) return FALLBACK_PAGE_SIZE;
  const openBlock = openRows > 0 ? GROUP_HEIGHT + openRows * ROW_MIN : 0;
  return clamp(
    Math.floor((available - LIST_BORDER - openBlock - GROUP_HEIGHT) / ROW_MIN),
    MIN_REQUEST,
    MAX_REQUEST,
  );
}

/**
 * Сколько решённых показать, чтобы реестр дошёл до нижнего поля и не вышел за него. `days` — день закрытия
 * каждой полученной строки в порядке сервера; `from` — с какой стороны считать: 'start' — первые строки
 * (листаем вперёд), 'end' — последние (листаем назад: страница должна кончиться там, где началась следующая).
 *
 * Строк берём столько, чтобы высота строки была ближе всего к обычной: чуть растянуть или чуть сжать — не
 * важно, лишь бы не ниже сжатой. Высота неизвестна — показываем всё полученное.
 */
export function visibleCount(
  available: number | null,
  openRows: number,
  days: readonly string[],
  from: 'start' | 'end' = 'start',
): number {
  const n = days.length;
  if (available === null || n === 0) return n;
  const openGroups = openRows > 0 ? 1 : 0;
  const seen = new Set<string>();
  /** Высота строки, если показать k решённых: место делится поровну между всеми строками реестра. */
  const heights: number[] = [];
  for (let k = 1; k <= n; k += 1) {
    seen.add(days[from === 'start' ? k - 1 : n - k] as string);
    heights.push((available - LIST_BORDER - (openGroups + seen.size) * GROUP_HEIGHT) / (openRows + k));
  }
  const at = (k: number): number => heights[k - 1] as number;
  // Высота с ростом k только убывает: находим, сколько помещается обычными строками и сколько — сжатыми.
  let natural = 0;
  let tight = 0;
  for (let k = 1; k <= n; k += 1) {
    if (at(k) >= ROW_HEIGHT) natural = k;
    if (at(k) >= ROW_MIN) tight = k;
  }
  // Не помещается ни одна — окно слишком низкое: показываем пять обычных строк, листается страница.
  if (tight === 0) return Math.min(n, CRAMPED_VISIBLE);
  if (natural === n) return n;
  if (natural === 0) return tight;
  // Ещё одна строка помещается только сжатой. Берём её, если так ближе к обычной высоте.
  const more = natural + 1;
  if (more > tight) return natural;
  return ROW_HEIGHT - at(more) < at(natural) - ROW_HEIGHT ? more : natural;
}

/**
 * Высота каждой строки, чтобы реестр занял `available` ровно: целые пиксели, первые строки на пиксель выше
 * остальных. `full` — страница полная: дальше есть ещё строки, они просто не поместились. null — подгонять
 * не нужно: высота неизвестна, строк мало (растягивать пришлось бы слишком сильно — конец списка) или они
 * не помещаются даже сжатыми (совсем низкое окно) — тогда строки обычной высоты.
 */
export function fitRows(
  available: number | null,
  groups: number,
  rows: number,
  full = false,
): number[] | null {
  if (available === null || rows <= 0) return null;
  const space = Math.floor(available) - LIST_BORDER - groups * GROUP_HEIGHT;
  const base = Math.floor(space / rows);
  const extra = space - base * rows;
  if (base < ROW_MIN || base + (extra > 0 ? 1 : 0) > (full ? ROW_MAX_FULL : ROW_MAX)) return null;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Что показано: страницы разной длины номером не адресуются, поэтому хранится строка. 'start' — с какой
 * строки страница начинается (с нуля); 'end' — перед какой строкой кончается (так листаем назад: иначе
 * строки между концом предыдущей страницы и началом этой можно было бы пропустить).
 */
export interface ListView {
  mode: 'start' | 'end';
  row: number;
}

/** Что запросить у сервера для такого вида: смещение и число строк. */
export function requestWindow(view: ListView, size: number): { offset: number; limit: number } {
  if (view.mode === 'start') return { offset: Math.max(0, view.row), limit: size };
  const offset = Math.max(0, view.row - size);
  return { offset, limit: clamp(view.row - offset, MIN_REQUEST, MAX_REQUEST) };
}

/** Положение страницы среди остальных: номер, сколько всего и куда ведёт нажатие на номер. */
export interface Paging {
  page: number;
  totalPages: number;
  /** Куда перейти по номеру страницы (или «Следующая»/«Предыдущая» — это соседние номера). */
  go: (page: number) => ListView;
}

/**
 * Номера страниц для реестра, где страницы разной длины. Единица счёта — длина показанной страницы: при
 * плотных сбоях она постоянна, и всё выглядит как обычное листание. «Следующая» начинает ровно с конца
 * показанного, «Предыдущая» кончается ровно у его начала — без пропусков и повторов.
 */
export function paging(start: number, shown: number, total: number, fallback: number): Paging {
  const per = Math.max(1, shown || fallback);
  const end = start + shown;
  const page = Math.ceil(start / per) + 1;
  const totalPages = page + Math.ceil(Math.max(0, total - end) / per);
  return {
    page,
    totalPages,
    go: (next) => {
      if (next <= 1) return { mode: 'start', row: 0 };
      // Соседние страницы — встык с показанной; дальние — по расчёту; последняя — так, чтобы кончилась последней строкой.
      if (next === page + 1) return { mode: 'start', row: end };
      if (next === page - 1) return { mode: 'end', row: start };
      if (next >= totalPages) return { mode: 'end', row: total };
      return { mode: 'start', row: clamp(start + (next - page) * per, 0, Math.max(0, total - 1)) };
    },
  };
}

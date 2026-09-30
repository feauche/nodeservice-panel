/**
 * Реестр инцидентов по высоте окна (просьба владельца 30.09.2026): на странице столько решённых, сколько
 * помещается, а нижнее поле под реестром — такое же, как боковые. Сколько строк помещается, зависит от
 * числа заголовков дней на странице (при редких сбоях каждый день — свой заголовок), а оно заранее не
 * известно. Поэтому панель запрашивает строки с запасом и показывает ровно столько, сколько помещается:
 * страницы получаются разной длины, зато реестр всегда кончается у нижнего поля — без прокрутки и пустоты.
 * Остаток меньше одной строки раздаётся строкам по пикселю.
 * Работает на широком экране; на телефоне строки разной высоты и страница просто листается.
 *
 * Страницы разной длины номером не адресуются — любой «номер» врал бы. Поэтому листание идёт от строки:
 * «Следующая» начинается там, где кончилась показанная, «Предыдущая» возвращает ровно ту страницу, с которой
 * ушли (или кончается у начала показанной), «В начало» и «В конец» — края списка. Сверху — диапазон строк.
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
 * чем пустота под реестром. Больше 82 при трёх и более строках не нужно никогда (одна-две — см. fullRowMax).
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
 * Предел растяжения полной страницы из `rows` строк. Страница полная, когда следующая строка не помещается
 * даже сжатой, а это так, пока на строку приходится меньше 52 + 88 / rows пикселей (88 — сжатая строка со
 * своим заголовком дня). При трёх строках и больше это не выше ROW_MAX_FULL, при двух — 96, при одной — 140:
 * на низком окне (ноутбук) страница из одной-двух строк тоже должна дойти до нижнего поля.
 */
const fullRowMax = (rows: number): number =>
  Math.max(ROW_MAX_FULL, ROW_MIN + Math.ceil((ROW_MIN + GROUP_HEIGHT) / rows));

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
  if (base < ROW_MIN || base + (extra > 0 ? 1 : 0) > (full ? fullRowMax(rows) : ROW_MAX)) return null;
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

/** Место страницы в списке: с какой строки начинается и перед какой кончается (с нуля). */
export interface PageSpan {
  start: number;
  end: number;
}

/**
 * Что запросить у сервера для такого вида: смещение и число строк. Кроме самих строк — по соседней с каждой
 * стороны: по ним подпись дня узнаёт, продолжается ли крайний день на соседней странице. В счёт строк
 * страницы соседние не идут (см. pageOf).
 */
export function requestWindow(view: ListView, size: number): { offset: number; limit: number } {
  const first = view.mode === 'start' ? Math.max(0, view.row) : Math.max(0, view.row - size);
  const end = view.mode === 'start' ? first + size : Math.max(0, view.row);
  const offset = Math.max(0, first - 1);
  return { offset, limit: clamp(end + 1 - offset, MIN_REQUEST, MAX_REQUEST) };
}

/**
 * Какие строки полученного окна показать. `offset` — с какой строки списка окно начинается, `days` — день
 * закрытия каждой его строки. Вперёд — первые строки с нужной, назад — последние перед нужной (страница
 * кончается там, где начиналась следующая); не больше `size` — остальное соседние строки и запас.
 */
export function pageOf(
  view: ListView,
  offset: number,
  days: readonly string[],
  size: number,
  available: number | null,
  openRows: number,
): { start: number; count: number } {
  if (view.mode === 'start') {
    const from = Math.max(0, view.row - offset);
    return {
      start: offset + from,
      count: visibleCount(available, openRows, days.slice(from, from + size), 'start'),
    };
  }
  const to = clamp(view.row - offset, 0, days.length);
  const count = visibleCount(available, openRows, days.slice(Math.max(0, to - size), to), 'end');
  return { start: offset + to - count, count };
}

/**
 * Листание реестра: какая страница нужна и откуда сюда пришли. `back` — страницы, с которых ушли
 * «Следующей», от давней к недавней: «Предыдущая» открывает ровно их и тем же видом. Счёт строк с начала и
 * с конца у границы дня расходится на строку, поэтому страница, открытая «с конца», видом «с начала» уже не
 * та же. Запомненные страницы верны, пока место под реестр и число решённых прежние: иначе они забываются.
 */
export interface ListNav {
  view: ListView;
  back: ListView[];
}

/** Начало списка: «В начало», смена вкладки, после «Удалить решённые». */
export const LIST_START: ListNav = { view: { mode: 'start', row: 0 }, back: [] };

/** «В конец»: страница кончается последней строкой списка. */
export const toLast = (total: number): ListNav => ({ view: { mode: 'end', row: total }, back: [] });

/**
 * «Следующая» — ровно с конца показанной. `shown` — страница уже на экране: тогда она запоминается для
 * «Предыдущей». Пока она не пришла, её конец — оценка по длине прежней, и цепочку дальше не ведём: «Предыдущая»
 * по такой истории могла бы пропустить строки.
 */
export function toNext(nav: ListNav, span: PageSpan, shown: boolean): ListNav {
  return { view: { mode: 'start', row: span.end }, back: shown ? [...nav.back, nav.view] : [] };
}

/**
 * «Предыдущая» — страница, с которой ушли «Следующей»; истории нет (пришли «В конец» или она кончилась) —
 * страница, которая кончается ровно у начала показанной.
 */
export function toPrev(nav: ListNav, span: PageSpan): ListNav {
  const back = nav.back.at(-1);
  if (back) return { view: back, back: nav.back.slice(0, -1) };
  return span.start > 0 ? { view: { mode: 'end', row: span.start }, back: [] } : LIST_START;
}

/**
 * Где окажется страница, которая ещё не пришла: один край задан видом точно, другой — по длине показанной
 * (`per`). По ней считаются подпись и кнопки, чтобы быстрые нажатия шли от запрошенного места, а не от того,
 * что ещё на экране.
 */
export function expectedSpan(view: ListView, per: number, total: number): PageSpan {
  if (view.mode === 'start') {
    const start = clamp(view.row, 0, total);
    return { start, end: Math.min(start + per, total) };
  }
  const end = clamp(view.row, 0, total);
  return { start: Math.max(0, end - per), end };
}

/**
 * Место под реестр изменилось (высота окна, число открытых). Страница «кончается у строки» становится
 * страницей «с первой показанной строки» (`shownStart`; null — нужная страница ещё не на экране): иначе с
 * экрана ушли бы верхние строки. Запомненные страницы были другой длины — они забываются. Изменилось число
 * решённых — вызывается без `shownStart`: вид прежний, забывается только история (строки сдвинулись).
 */
export function reanchored(nav: ListNav, shownStart: number | null): ListNav {
  if (nav.view.mode === 'end' && shownStart !== null)
    return { view: { mode: 'start', row: shownStart }, back: [] };
  return nav.back.length > 0 ? { view: nav.view, back: [] } : nav;
}

/**
 * Поправка вида, когда страница пришла; null — вид остаётся. Пустая страница при непустом списке (решённых
 * убавилось) — показываем конец. Дошли «Предыдущей» до самого начала — показываем первую страницу «с начала»,
 * полной, а не коротким остатком; но только если при этом ничего не пропадёт: счёт с начала по тем же
 * строкам (`days` — их дни) должен показать их все. Счёт с конца мог взять на строку больше — сжатыми, тогда
 * страница остаётся как есть.
 */
export function settledView(
  view: ListView,
  page: { start: number; count: number },
  days: readonly string[],
  total: number,
  available: number | null,
  openRows: number,
): ListView | null {
  if (total <= 0) return null;
  if (page.count === 0) return view.mode === 'end' && view.row === total ? null : { mode: 'end', row: total };
  if (
    view.mode === 'end' &&
    page.start === 0 &&
    visibleCount(available, openRows, days, 'start') === page.count
  )
    return LIST_START.view;
  return null;
}

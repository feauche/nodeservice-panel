import { describe, expect, it } from 'vitest';

import {
  CRAMPED_VISIBLE,
  expectedSpan,
  FALLBACK_PAGE_SIZE,
  fitRows,
  GROUP_HEIGHT,
  LIST_BORDER,
  LIST_START,
  type ListNav,
  type ListView,
  pageOf,
  ROW_HEIGHT,
  ROW_MAX,
  ROW_MAX_FULL,
  ROW_MIN,
  reanchored,
  requestSize,
  requestWindow,
  settledView,
  toLast,
  toNext,
  toPrev,
  visibleCount,
} from './incidents-fit';

/** Высота реестра, в которую ровно помещаются `rows` строк и `groups` заголовков. */
const exact = (rows: number, groups: number) => LIST_BORDER + groups * GROUP_HEIGHT + rows * ROW_HEIGHT;
const sum = (heights: number[] | null) => (heights ?? []).reduce((a, b) => a + b, 0);
/** Дни закрытия для `n` строк: по `perDay` сбоев в день, от новых к старым. */
const days = (n: number, perDay: number): string[] =>
  Array.from({ length: n }, (_, i) => `день ${Math.floor(i / perDay)}`);
const distinct = (list: readonly string[]) => new Set(list).size;

describe('requestSize: сколько решённых запросить — с запасом', () => {
  it('высота неизвестна (телефон, тесты) — обычные десять', () => {
    expect(requestSize(null, 0)).toBe(FALLBACK_PAGE_SIZE);
    expect(FALLBACK_PAGE_SIZE).toBe(10);
  });

  it('столько, сколько поместилось бы сжатыми строками при одном дне: больше показать всё равно нельзя', () => {
    const tight = (rows: number) => LIST_BORDER + GROUP_HEIGHT + rows * ROW_MIN;
    expect(requestSize(tight(12), 0)).toBe(12);
    expect(requestSize(tight(12) - 1, 0)).toBe(11);
    // Открытые занимают место сверху: заголовок «Сейчас» и по строке на каждый.
    expect(requestSize(tight(12) + GROUP_HEIGHT + 2 * ROW_MIN, 2)).toBe(12);
  });

  it('границы: не меньше пяти (меньше сервер не отдаёт) и не больше ста', () => {
    expect(requestSize(120, 0)).toBe(5);
    expect(requestSize(800, 30)).toBe(5);
    expect(requestSize(100_000, 0)).toBe(100);
  });
});

describe('visibleCount: сколько решённых показать, чтобы реестр дошёл до низа окна и не вышел за него', () => {
  it('высота неизвестна — показываем всё полученное', () => {
    expect(visibleCount(null, 0, days(10, 3))).toBe(10);
    expect(visibleCount(800, 0, [])).toBe(0);
  });

  it('плотные сбои (один день на странице): столько строк, сколько помещается обычной высотой', () => {
    expect(visibleCount(exact(11, 1), 0, days(16, 100))).toBe(11);
    // Двенадцатая помещается, только если все чуть сжать (до 56): так ближе к обычной высоте, чем растянуть одиннадцать.
    expect(visibleCount(exact(11, 1) + ROW_HEIGHT - 20, 0, days(16, 100))).toBe(12);
    // А если растяжение меньше сжатия — остаёмся на одиннадцати.
    expect(visibleCount(exact(11, 1) + 20, 0, days(16, 100))).toBe(11);
  });

  it('редкие сбои: каждый день — свой заголовок, строк помещается меньше, и реестр всё равно кончается у нижнего поля', () => {
    const available = exact(13, 1);
    // По одному в день: на строку приходится и заголовок.
    const sparse = days(16, 1);
    const k = visibleCount(available, 0, sparse);
    expect(k).toBe(8);
    // Помещается ровно: строки не ниже сжатой и не выше растянутой.
    const heights = fitRows(available, distinct(sparse.slice(0, k)), k, true);
    expect(heights).not.toBeNull();
    expect(sum(heights) + k * GROUP_HEIGHT + LIST_BORDER).toBe(available);
    // Плотные сбои в том же окне — тринадцать строк.
    expect(visibleCount(available, 0, days(16, 100))).toBe(13);
  });

  it('любая плотность и высота: показанное помещается ровно, без прокрутки и пустоты', () => {
    // От окна, куда помещается одна строка (ноутбук с низким окном браузера), до очень высокого.
    for (const perDay of [1, 2, 3, 5, 10, 100])
      for (const openRows of [0, 1, 3])
        for (let available = 100; available <= 1400; available += 7) {
          const size = requestSize(available, openRows);
          const list = days(size + 1, perDay);
          const k = visibleCount(available, openRows, list);
          const groups = distinct(list.slice(0, k)) + (openRows > 0 ? 1 : 0);
          // Полная страница: из полученного показано не всё.
          const heights = fitRows(available, groups, openRows + k, k < list.length);
          const where = `${available}px, в день ${perDay}, открытых ${openRows}, показано ${k} из ${size}`;
          // Если строки не помещаются даже сжатыми, значит окно совсем низкое: показано пять обычных строк.
          if (heights === null) expect(k, where).toBe(CRAMPED_VISIBLE);
          else expect(sum(heights) + groups * GROUP_HEIGHT + LIST_BORDER, where).toBe(available);
          // Запаса хватило: показано не больше запрошенного (больше бы не поместилось).
          expect(k, where).toBeLessThanOrEqual(size);
          // Три строки и больше — не выше 84; одна-две растягиваются сильнее, иначе под ними пустота.
          const rows = openRows + k;
          const limit = rows === 1 ? 140 : rows === 2 ? 96 : ROW_MAX_FULL;
          for (const h of heights ?? []) expect(h, where).toBeLessThanOrEqual(limit);
        }
  });

  it('листаем назад — берутся последние строки окна: страница кончается там, где началась следующая', () => {
    // Четыре свежих сбоя в один день, перед ними — по одному в день.
    const list = ['д5', 'д4', 'д3', 'д2', 'д1', 'д0', 'д0', 'д0', 'д0'];
    const available = exact(6, 2);
    // С начала: строки разных дней — на каждую свой заголовок, помещается меньше.
    expect(visibleCount(available, 0, list, 'start')).toBe(4);
    // С конца: четыре строки одного дня и ещё две — шесть.
    expect(visibleCount(available, 0, list, 'end')).toBe(6);
  });

  it('не помещается ни одной решённой (окно совсем низкое или открытых много) — пять обычных строк, листается страница', () => {
    expect(visibleCount(80, 0, days(8, 100))).toBe(CRAMPED_VISIBLE);
    expect(visibleCount(700, 12, days(8, 100))).toBe(CRAMPED_VISIBLE);
    expect(fitRows(80, 1, CRAMPED_VISIBLE, true)).toBeNull();
    // Решённых меньше — показываем сколько есть.
    expect(visibleCount(80, 0, days(2, 100))).toBe(2);
  });

  it('помещается одна-две строки — показываем их: реестр кончается у нижнего поля, страница не листается', () => {
    // Ноутбук, два открытых сверху: под решённые остаётся место на две строки.
    const available = 334;
    const k = visibleCount(available, 2, days(7, 100));
    expect(k).toBe(2);
    expect(fitRows(available, 2, 2 + k, true)).toEqual([65, 65, 65, 65]);
    // Редкие сбои в том же окне: две строки и два заголовка дня — сжатыми, но помещаются.
    const sparse = visibleCount(available, 2, days(7, 1));
    expect(sparse).toBe(2);
    expect(fitRows(available, 3, 2 + sparse, true)).not.toBeNull();
    // Место только под одну.
    expect(visibleCount(LIST_BORDER + GROUP_HEIGHT + ROW_HEIGHT, 0, days(7, 100))).toBe(1);
  });

  it('список кончился раньше, чем окно: показываем всё, не растягивая строки на весь экран', () => {
    expect(visibleCount(exact(11, 1), 0, days(3, 100))).toBe(3);
    expect(fitRows(exact(11, 1), 1, 3)).toBeNull();
  });
});

describe('fitRows: высота строк, при которой реестр кончается ровно у нижнего поля', () => {
  it('остаток меньше строки раздаётся строкам по пикселю — сумма сходится точно', () => {
    const available = exact(11, 1) + 40;
    const heights = fitRows(available, 1, 11);
    expect(heights).toHaveLength(11);
    expect(sum(heights) + GROUP_HEIGHT + LIST_BORDER).toBe(available);
    // 40 пикселей на 11 строк: семь строк по 63 и четыре по 62 — разница не больше пикселя.
    expect(new Set(heights)).toEqual(new Set([ROW_HEIGHT + 3, ROW_HEIGHT + 4]));
    expect(heights?.[0]).toBe(ROW_HEIGHT + 4);
    expect(heights?.at(-1)).toBe(ROW_HEIGHT + 3);
  });

  it('ровно помещается — строки обычной высоты', () => {
    expect(fitRows(exact(10, 2), 2, 10)).toEqual(Array.from({ length: 10 }, () => ROW_HEIGHT));
  });

  it('границы: не ниже сжатой строки и не выше растянутой', () => {
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 5 * ROW_MIN, 1, 5)).toEqual([52, 52, 52, 52, 52]);
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 5 * ROW_MIN - 1, 1, 5)).toBeNull();
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 5 * ROW_MAX, 1, 5)).toEqual([72, 72, 72, 72, 72]);
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 5 * ROW_MAX + 5, 1, 5)).toBeNull();
    // Полная страница (дальше есть ещё строки, они не поместились) растягивается сильнее — иначе под
    // реестром осталась бы пустота; конец списка так не растягиваем.
    expect(fitRows(LIST_BORDER + 4 * GROUP_HEIGHT + 4 * 74, 4, 4, true)).toEqual([74, 74, 74, 74]);
    expect(fitRows(LIST_BORDER + 4 * GROUP_HEIGHT + 4 * 74, 4, 4)).toBeNull();
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 3 * (ROW_MAX_FULL + 1), 1, 3, true)).toBeNull();
  });

  it('полная страница из одной-двух строк растягивается до нижнего поля: следующая не влезла бы даже сжатой', () => {
    // Ноутбук с низким окном, по одному сбою в день: две строки и два заголовка дня, третья не помещается.
    expect(fitRows(246, 2, 2, true)).toEqual([86, 86]);
    // Место под одну строку.
    expect(fitRows(170, 1, 1, true)).toEqual([132]);
    // Предел — высота, при которой поместилась бы ещё одна сжатая строка со своим заголовком дня:
    // 140 на одну строку, 96 на две.
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 140, 1, 1, true)).toEqual([140]);
    expect(fitRows(LIST_BORDER + GROUP_HEIGHT + 141, 1, 1, true)).toBeNull();
    expect(fitRows(LIST_BORDER + 2 * GROUP_HEIGHT + 2 * 96, 2, 2, true)).toEqual([96, 96]);
    expect(fitRows(LIST_BORDER + 2 * GROUP_HEIGHT + 2 * 96 + 1, 2, 2, true)).toBeNull();
    // Конец списка (страница неполная) по-прежнему не растягиваем на весь экран.
    expect(fitRows(246, 2, 2)).toBeNull();
    expect(fitRows(170, 1, 1)).toBeNull();
  });

  it('высота неизвестна или строк нет — ничего не трогаем', () => {
    expect(fitRows(null, 1, 10)).toBeNull();
    expect(fitRows(800, 0, 0)).toBeNull();
  });
});

describe('requestWindow: что запросить у сервера', () => {
  it('вперёд — с нужной строки; назад — окно, которое кончается перед нужной строкой; и по соседней строке с краёв', () => {
    // Соседние строки нужны подписи дня: по ним видно, продолжается ли крайний день на соседней странице.
    expect(requestWindow({ mode: 'start', row: 24 }, 16)).toEqual({ offset: 23, limit: 18 });
    expect(requestWindow({ mode: 'start', row: 0 }, 16)).toEqual({ offset: 0, limit: 17 });
    expect(requestWindow({ mode: 'end', row: 40 }, 16)).toEqual({ offset: 23, limit: 18 });
    // У самого начала списка окно короче; меньше пяти сервер не отдаёт — лишнее отбросит страница.
    expect(requestWindow({ mode: 'end', row: 9 }, 16)).toEqual({ offset: 0, limit: 10 });
    expect(requestWindow({ mode: 'end', row: 3 }, 16)).toEqual({ offset: 0, limit: 5 });
    // Больше ста сервер не отдаёт: соседняя строка снизу тогда не приходит.
    expect(requestWindow({ mode: 'start', row: 50 }, 100)).toEqual({ offset: 49, limit: 100 });
  });
});

/** Дни строк по числу сбоев в каждый день (0 — сегодня): [1, 10] → д0, д1 ×10. */
const byDays = (perDay: readonly number[]): string[] =>
  perDay.flatMap((n, d) => Array.from({ length: n }, () => `д${d}`));

describe('pageOf: какие строки полученного окна показать', () => {
  it('вперёд — с нужной строки, соседние строки окна в счёт не идут', () => {
    const list = byDays([1, 10, 10]);
    const { offset, limit } = requestWindow({ mode: 'start', row: 5 }, 16);
    const page = pageOf(
      { mode: 'start', row: 5 },
      offset,
      list.slice(offset, offset + limit),
      16,
      exact(8, 2),
      0,
    );
    expect(page).toEqual({ start: 5, count: 8 });
  });

  it('назад — последние строки перед нужной', () => {
    const list = byDays([1, 10, 10]);
    const { offset, limit } = requestWindow({ mode: 'end', row: 15 }, 16);
    const page = pageOf(
      { mode: 'end', row: 15 },
      offset,
      list.slice(offset, offset + limit),
      16,
      exact(8, 2),
      0,
    );
    expect(page).toEqual({ start: 7, count: 8 });
  });

  it('высота неизвестна (телефон) — ровно по размеру страницы, как раньше: соседние строки не показываются', () => {
    const list = byDays([30]);
    const got = (view: ListView) => {
      const { offset, limit } = requestWindow(view, 10);
      return pageOf(view, offset, list.slice(offset, offset + limit), 10, null, 0);
    };
    expect(got({ mode: 'start', row: 0 })).toEqual({ start: 0, count: 10 });
    expect(got({ mode: 'start', row: 10 })).toEqual({ start: 10, count: 10 });
    expect(got({ mode: 'end', row: 20 })).toEqual({ start: 10, count: 10 });
    expect(got({ mode: 'start', row: 25 })).toEqual({ start: 25, count: 5 });
  });

  it('за концом списка — пустая страница', () => {
    expect(pageOf({ mode: 'start', row: 70 }, 69, [], 10, null, 0)).toEqual({ start: 70, count: 0 });
  });
});

describe('листание: история страниц, «Предыдущая» и «Следующая»', () => {
  const at = (row: number): ListView => ({ mode: 'start', row });

  it('«Следующая» запоминает показанную страницу, «Предыдущая» возвращает ровно её', () => {
    let nav = LIST_START;
    nav = toNext(nav, { start: 0, end: 8 }, true);
    expect(nav).toEqual({ view: at(8), back: [at(0)] });
    nav = toNext(nav, { start: 8, end: 15 }, true);
    expect(nav).toEqual({ view: at(15), back: [at(0), at(8)] });
    nav = toPrev(nav, { start: 15, end: 22 });
    expect(nav).toEqual({ view: at(8), back: [at(0)] });
  });

  it('страница, открытая «с конца», возвращается тем же видом: счёт с начала дал бы другую', () => {
    const endView: ListView = { mode: 'end', row: 40 };
    let nav: ListNav = { view: endView, back: [] };
    nav = toNext(nav, { start: 33, end: 40 }, true);
    expect(nav.view).toEqual(at(40));
    nav = toPrev(nav, { start: 40, end: 47 });
    expect(nav).toEqual({ view: endView, back: [] });
  });

  it('истории нет (пришли «В конец» или она кончилась) — «Предыдущая» кончается ровно у начала показанной', () => {
    expect(toPrev(toLast(143), { start: 135, end: 143 })).toEqual({
      view: { mode: 'end', row: 135 },
      back: [],
    });
    expect(toLast(143)).toEqual({ view: { mode: 'end', row: 143 }, back: [] });
    // У самого начала листать назад некуда.
    expect(toPrev(LIST_START, { start: 0, end: 8 })).toEqual(LIST_START);
  });

  it('нажали, пока страница ещё не пришла: её длина — оценка, историю дальше не ведём, чтобы не пропустить строки', () => {
    const nav = toNext({ view: at(8), back: [at(0)] }, { start: 8, end: 16 }, false);
    expect(nav).toEqual({ view: at(16), back: [] });
    // А «Предыдущая» по истории точна и во время загрузки.
    expect(toPrev({ view: at(8), back: [at(0)] }, { start: 8, end: 16 })).toEqual(LIST_START);
  });

  it('пока страница не пришла, её место оценивается по длине показанной: известный край — точно', () => {
    expect(expectedSpan(at(24), 8, 143)).toEqual({ start: 24, end: 32 });
    expect(expectedSpan(at(140), 8, 143)).toEqual({ start: 140, end: 143 });
    expect(expectedSpan({ mode: 'end', row: 40 }, 8, 143)).toEqual({ start: 32, end: 40 });
    expect(expectedSpan({ mode: 'end', row: 5 }, 8, 143)).toEqual({ start: 0, end: 5 });
    // Решённых стало меньше, чем начало открытой страницы: начало не больше общего числа.
    expect(expectedSpan(at(70), 8, 50)).toEqual({ start: 50, end: 50 });
  });
});

describe('reanchored: место под реестр изменилось (высота окна, число открытых)', () => {
  it('страница «кончается у строки» становится страницей «с первой показанной строки»: она остаётся на экране', () => {
    const nav: ListNav = { view: { mode: 'end', row: 113 }, back: [] };
    expect(reanchored(nav, 107)).toEqual({ view: { mode: 'start', row: 107 }, back: [] });
  });

  it('запомненные страницы были другой длины — история забывается, вид «с начала» не меняется', () => {
    const nav: ListNav = {
      view: { mode: 'start', row: 24 },
      back: [LIST_START.view, { mode: 'start', row: 8 }],
    };
    expect(reanchored(nav, 24)).toEqual({ view: { mode: 'start', row: 24 }, back: [] });
  });

  it('нужная страница ещё не показана — держать на экране нечего, вид остаётся', () => {
    const nav: ListNav = { view: { mode: 'end', row: 113 }, back: [] };
    expect(reanchored(nav, null)).toEqual(nav);
  });
});

describe('settledView: поправка вида, когда страница пришла', () => {
  it('строка за концом списка (решённых убавилось) — показываем конец', () => {
    expect(settledView({ mode: 'start', row: 70 }, { start: 70, count: 0 }, [], 50, 514, 0)).toEqual({
      mode: 'end',
      row: 50,
    });
    // Уже у конца, а сервер ничего не отдал — больше не прыгаем (иначе по кругу).
    expect(settledView({ mode: 'end', row: 50 }, { start: 50, count: 0 }, [], 50, 514, 0)).toBeNull();
    expect(settledView({ mode: 'start', row: 0 }, { start: 0, count: 0 }, [], 0, 514, 0)).toBeNull();
  });

  it('дошли «Предыдущей» до начала коротким остатком — показываем первую страницу полной', () => {
    const list = byDays([12]);
    expect(
      settledView({ mode: 'end', row: 3 }, { start: 0, count: 3 }, list.slice(0, 3), 12, exact(8, 1), 0),
    ).toEqual(LIST_START.view);
  });

  it('…но только если при этом ничего не пропадёт: счёт с конца мог взять на строку больше — сжатыми', () => {
    // 1440×900: сегодня один сбой, вчера десять. С конца помещается восемь сжатых строк, с начала — семь
    // обычных: перевод в «с начала» потерял бы восьмую строку (находка Н2).
    const list = byDays([1, 10]);
    const view: ListView = { mode: 'end', row: 8 };
    const { offset, limit } = requestWindow(view, requestSize(514, 0));
    const page = pageOf(view, offset, list.slice(offset, offset + limit), requestSize(514, 0), 514, 0);
    expect(page).toEqual({ start: 0, count: 8 });
    expect(visibleCount(514, 0, list.slice(0, 8), 'start')).toBe(7);
    expect(settledView(view, page, list.slice(0, 8), list.length, 514, 0)).toBeNull();
  });
});

/**
 * Реестр, как его листает страница: сервер отдаёт окно, страница показывает, сколько помещается по высоте,
 * и поправляет вид (settledView); кнопки — те же функции, что у страницы.
 */
function registry(list: readonly string[], available: number | null, openRows = 0) {
  const total = list.length;
  const size = requestSize(available, openRows);
  let nav: ListNav = LIST_START;
  const page = () => {
    for (let guard = 0; guard < 4; guard += 1) {
      const { offset, limit } = requestWindow(nav.view, size);
      const { start, count } = pageOf(
        nav.view,
        offset,
        list.slice(offset, offset + limit),
        size,
        available,
        openRows,
      );
      const fix = settledView(
        nav.view,
        { start, count },
        list.slice(start, start + count),
        total,
        available,
        openRows,
      );
      if (!fix) return { start, end: start + count };
      nav = { view: fix, back: [] };
    }
    throw new Error('вид не устоялся');
  };
  return {
    total,
    page,
    first: () => {
      nav = LIST_START;
      return page();
    },
    last: () => {
      nav = toLast(total);
      return page();
    },
    next: () => {
      nav = toNext(nav, page(), true);
      return page();
    },
    prev: () => {
      nav = toPrev(nav, page());
      return page();
    },
  };
}
type Registry = ReturnType<typeof registry>;
type Span = { start: number; end: number };
const range = (p: Span) => `${p.start + 1}–${p.end}`;

/** От первой страницы «Следующей» до последней. */
const walkForward = (r: Registry): Span[] => {
  const pages = [r.first()];
  while ((pages.at(-1) as Span).end < r.total && pages.length < 500) pages.push(r.next());
  return pages;
};
/** От последней страницы («В конец») «Предыдущей» до первой. */
const walkBack = (r: Registry): Span[] => {
  const pages = [r.last()];
  while ((pages.at(-1) as Span).start > 0 && pages.length < 500) pages.push(r.prev());
  return pages;
};
/** Строки, которые ни разу не показаны. */
const missing = (pages: Span[], total: number): number[] =>
  Array.from({ length: total }, (_, i) => i).filter((i) => !pages.some((p) => p.start <= i && i < p.end));

/** Окна из отчёта проверки: высота под реестр на полной странице (замер в браузере). */
const WINDOWS = [
  { name: '1852×1180', available: 794 },
  { name: '1440×900', available: 514 },
  { name: '1366×768', available: 382 },
  { name: '1024×768', available: 366 },
  { name: '1024×768, есть открытые', available: 336 },
];

describe('листание по страницам разной длины: без пропусков и с возвратом на ту же страницу', () => {
  it('таблица Н2: от последней страницы «Предыдущей» до первой каждая строка показана', () => {
    const cases: Array<[string, number, number, number[], string]> = [
      ['1852×1180 «Решённые»', 794, 0, [1, 1, 1, 1, 60], '1–10 пропускала 11, 12'],
      ['1852×1180 «Все», 2 открытых', 794, 2, [1, 1, 1, 1, 1, 1, 1, 1, 40], '1–7 пропускала 8'],
      ['1440×900 «Все»', 514, 0, [1, 10, 10, 10, 10, 10, 10, 10, 10, 1], '1–7 пропускала 8'],
      [
        '1440×900 «Все», 1 открытый',
        514,
        1,
        [1, ...Array.from({ length: 20 }, () => 3), 4],
        '1–5 пропускала 6',
      ],
      ['1366×768 «Все»', 382, 0, [4, 10, 10, 10, 10, 10, 10, 10, 10], '1–5 пропускала 6'],
    ];
    for (const [name, available, openRows, perDay, was] of cases) {
      const r = registry(byDays(perDay), available, openRows);
      const back = walkBack(r);
      const where = `${name}: ${back.slice(-3).map(range).join(' → ')} (было: ${was})`;
      expect(missing(back, r.total), where).toEqual([]);
      // Каждая страница кончается там, где начиналась следующая за ней; у самого начала первая страница
      // может показать и больше.
      for (let i = 1; i < back.length; i += 1) {
        const [later, earlier] = [back[i - 1] as Span, back[i] as Span];
        if (earlier.start > 0) expect(earlier.end, where).toBe(later.start);
        else expect(earlier.end, where).toBeGreaterThanOrEqual(later.start);
      }
    }
  });

  it('1440×900, сегодня один сбой и дальше по десять: у начала — восемь сжатых строк, восьмая не пропадает', () => {
    const r = registry(byDays([1, 10, 10, 10, 10, 10, 10, 10, 10, 1]), 514, 0);
    const back = walkBack(r);
    expect(back.slice(-2).map(range)).toEqual(['9–15', '1–8']);
  });

  it('любая плотность, окно и число открытых: вперёд — каждая строка ровно один раз, назад — без пропусков', () => {
    const densities: Array<[string, number[]]> = [
      ['10 в день', Array.from({ length: 18 }, (_, d) => (d === 17 ? 3 : 10))],
      ['3 в день', Array.from({ length: 44 }, () => 3)],
      ['1 в день', Array.from({ length: 97 }, () => 1)],
      ['смешанные', [2, 1, 0, 1, 14, 1, 1, 0, 3, 22, 1, 1, 1, 9, 2]],
      ['тихие дни и всплеск', [1, 1, 1, 1, 60]],
    ];
    for (const [dl, perDay] of densities)
      for (const w of WINDOWS)
        for (const openRows of [0, 1, 3]) {
          const r = registry(byDays(perDay), w.available, openRows);
          const where = `${dl}, ${w.name}, открытых ${openRows}`;
          const fwd = walkForward(r);
          for (let i = 1; i < fwd.length; i += 1)
            expect((fwd[i] as Span).start, where).toBe((fwd[i - 1] as Span).end);
          expect(missing(fwd, r.total), where).toEqual([]);
          expect(missing(walkBack(r), r.total), `${where}, назад`).toEqual([]);
        }
  });

  it('«Следующая» → «Предыдущая» возвращает тот же диапазон — и при листании вперёд, и после «В конец»', () => {
    for (const perDay of [
      Array.from({ length: 40 }, () => 3),
      [1, 10, 10, 10, 10, 10, 10, 10, 10, 1],
      [2, 1, 0, 1, 14, 1, 1, 0, 3, 22, 1, 1, 1, 9, 2],
    ])
      for (const w of WINDOWS)
        for (const openRows of [0, 1, 3]) {
          const where = `${w.name}, открытых ${openRows}, дни ${perDay.join(',')}`;
          // Вперёд с первой страницы (виды «с начала»).
          const r = registry(byDays(perDay), w.available, openRows);
          for (let p = r.first(); p.end < r.total; p = r.next()) {
            r.next();
            expect(range(r.prev()), where).toBe(range(p));
          }
          // Назад от последней (виды «кончается у строки»).
          const b = registry(byDays(perDay), w.available, openRows);
          for (let p = b.last(); p.start > 0; p = b.prev()) {
            if (p.end < b.total) {
              b.next();
              expect(range(b.prev()), `${where}, назад`).toBe(range(p));
            }
          }
        }
  });

  it('Н4: 1024×768, по три сбоя в день — «6–9» → «Следующая» → «Предыдущая» снова «6–9», а не «5–9»', () => {
    const r = registry(byDays(Array.from({ length: 40 }, () => 3)), 366, 0);
    const pages = walkForward(r).slice(0, 5);
    r.first();
    for (const p of pages.slice(0, -1)) {
      expect(range(r.page())).toBe(range(p));
      r.next();
      r.prev();
      expect(range(r.page())).toBe(range(p));
      r.next();
    }
  });
});

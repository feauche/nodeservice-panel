import { describe, expect, it } from 'vitest';

import {
  CRAMPED_VISIBLE,
  FALLBACK_PAGE_SIZE,
  fitRows,
  GROUP_HEIGHT,
  LIST_BORDER,
  paging,
  ROW_HEIGHT,
  ROW_MAX,
  ROW_MAX_FULL,
  ROW_MIN,
  requestSize,
  requestWindow,
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
    for (const perDay of [1, 2, 3, 5, 10, 100])
      for (const openRows of [0, 1, 3])
        for (let available = 420; available <= 1400; available += 7) {
          const size = requestSize(available, openRows);
          const list = days(size, perDay);
          const k = visibleCount(available, openRows, list);
          const groups = distinct(list.slice(0, k)) + (openRows > 0 ? 1 : 0);
          // Полная страница: из полученного показано не всё.
          const heights = fitRows(available, groups, openRows + k, k < size);
          const where = `${available}px, в день ${perDay}, открытых ${openRows}, показано ${k} из ${size}`;
          // Если строки не помещаются даже сжатыми, значит окно совсем низкое: показано пять обычных строк.
          if (heights === null) expect(k, where).toBe(Math.min(size, CRAMPED_VISIBLE));
          else expect(sum(heights) + groups * GROUP_HEIGHT + LIST_BORDER, where).toBe(available);
          // Запаса хватило: показано меньше запрошенного либо ровно столько (и больше бы не поместилось).
          expect(k, where).toBeLessThanOrEqual(size);
          for (const h of heights ?? []) expect(h, where).toBeLessThanOrEqual(ROW_MAX_FULL);
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

  it('высота неизвестна или строк нет — ничего не трогаем', () => {
    expect(fitRows(null, 1, 10)).toBeNull();
    expect(fitRows(800, 0, 0)).toBeNull();
  });
});

describe('requestWindow: что запросить у сервера', () => {
  it('вперёд — с нужной строки; назад — окно, которое кончается перед нужной строкой', () => {
    expect(requestWindow({ mode: 'start', row: 24 }, 16)).toEqual({ offset: 24, limit: 16 });
    expect(requestWindow({ mode: 'end', row: 40 }, 16)).toEqual({ offset: 24, limit: 16 });
    // У самого начала списка окно короче; меньше пяти сервер не отдаёт — лишнее отбросит страница.
    expect(requestWindow({ mode: 'end', row: 9 }, 16)).toEqual({ offset: 0, limit: 9 });
    expect(requestWindow({ mode: 'end', row: 3 }, 16)).toEqual({ offset: 0, limit: 5 });
  });
});

describe('paging: номера страниц, когда страницы разной длины', () => {
  it('плотные сбои — как обычное листание', () => {
    const p = paging(16, 8, 45, 10);
    expect([p.page, p.totalPages]).toEqual([3, 6]);
    expect(p.go(4)).toEqual({ mode: 'start', row: 24 });
    expect(p.go(1)).toEqual({ mode: 'start', row: 0 });
  });

  it('«Следующая» начинает ровно с конца показанного, «Предыдущая» кончается ровно у его начала', () => {
    // Показаны строки 13–18 (шесть штук: на странице много дней).
    const p = paging(13, 6, 143, 16);
    expect(p.go(p.page + 1)).toEqual({ mode: 'start', row: 19 });
    expect(p.go(p.page - 1)).toEqual({ mode: 'end', row: 13 });
  });

  it('последняя страница по номеру кончается последней строкой списка, а не обрывается пустотой', () => {
    const p = paging(0, 8, 45, 10);
    expect(p.totalPages).toBe(6);
    expect(p.go(6)).toEqual({ mode: 'end', row: 45 });
    // А «Следующая» с предпоследней — встык, без повтора строк.
    const last = paging(32, 8, 45, 10);
    expect([last.page, last.totalPages]).toEqual([5, 6]);
    expect(last.go(6)).toEqual({ mode: 'start', row: 40 });
  });

  it('последняя показанная строка — последняя в списке: дальше листать некуда', () => {
    const p = paging(37, 8, 45, 10);
    expect(p.page).toBe(p.totalPages);
    // Список пуст или ничего не показано — одна страница.
    expect(paging(0, 0, 0, 10).totalPages).toBe(1);
  });
});

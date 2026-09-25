import { describe, expect, it } from 'vitest';

import { applyFormat } from './knowledge-format';

describe('applyFormat', () => {
  it('жирный и курсив оборачивают выделение и выделяют внутренность', () => {
    expect(applyFormat('bold', 'a слово b', 2, 7)).toEqual({
      value: 'a **слово** b',
      selStart: 4,
      selEnd: 9,
    });
    expect(applyFormat('italic', 'слово', 0, 5)).toEqual({ value: '*слово*', selStart: 1, selEnd: 6 });
  });

  it('без выделения вставляет заглавную заготовку и выделяет её', () => {
    expect(applyFormat('bold', '', 0, 0)).toEqual({ value: '**Текст**', selStart: 2, selEnd: 7 });
  });

  it('повторное нажатие снимает разметку — и при выделении вместе со знаками, и только внутри', () => {
    expect(applyFormat('bold', '**слово**', 0, 9).value).toBe('слово');
    expect(applyFormat('bold', '**слово**', 2, 7)).toEqual({ value: 'слово', selStart: 0, selEnd: 5 });
  });

  it('курсив не путает жирный с курсивом', () => {
    // «**слово**» — это жирный: курсив оборачивает поверх, а не «снимает» одну звёздочку
    expect(applyFormat('italic', '**слово**', 0, 9).value).toBe('***слово***');
    expect(applyFormat('italic', '**слово**', 2, 7).value).toBe('***слово***');
  });

  it('заголовок: ставит, заменяет другой уровень и снимает при повторе', () => {
    expect(applyFormat('h2', 'Как проверить', 0, 0).value).toBe('## Как проверить');
    expect(applyFormat('h3', '## Как проверить', 0, 0).value).toBe('### Как проверить');
    expect(applyFormat('h2', '## Как проверить', 0, 0).value).toBe('Как проверить');
  });

  it('заголовок на пустой строке — заготовка', () => {
    expect(applyFormat('h2', '', 0, 0)).toEqual({ value: '## Заголовок', selStart: 3, selEnd: 12 });
  });

  it('курсор в строке не превращается в выделение всей строки', () => {
    const r = applyFormat('ul', 'пункт', 3, 3);
    expect(r).toEqual({ value: '- пункт', selStart: 5, selEnd: 5 });
  });

  it('список на несколько строк: пустые строки не трогает, нумерация идёт подряд', () => {
    const src = 'а\nб\n\nв';
    expect(applyFormat('ul', src, 0, src.length).value).toBe('- а\n- б\n\n- в');
    expect(applyFormat('ol', src, 0, src.length).value).toBe('1. а\n2. б\n\n3. в');
  });

  it('переключение между видами списка не копит префиксы', () => {
    expect(applyFormat('ol', '- а\n- б', 0, 7).value).toBe('1. а\n2. б');
    expect(applyFormat('quote', '1. а', 0, 4).value).toBe('> а');
  });

  it('действует только на выделенные строки', () => {
    const src = 'первая\nвторая\nтретья';
    expect(applyFormat('quote', src, 7, 13).value).toBe('первая\n> вторая\nтретья');
  });

  it('код: однострочное выделение — инлайн, иначе блок', () => {
    expect(applyFormat('code', 'запустите ls', 10, 12).value).toBe('запустите `ls`');
    expect(applyFormat('code', '', 0, 0).value).toBe('```\nКоманда\n```\n');
    expect(applyFormat('code', 'a\nb', 0, 3).value).toBe('```\na\nb\n```\n');
  });

  it('блоки (таблица, линия) отделяются пустыми строками от соседнего текста', () => {
    expect(applyFormat('hr', 'до\nпосле', 2, 2).value).toBe('до\n\n---\n\nпосле');
    expect(applyFormat('hr', 'до\n\nпосле', 4, 4).value).toBe('до\n\n---\n\nпосле');
    expect(applyFormat('table', 'абзац', 5, 5).value.startsWith('абзац\n\n| Колонка 1')).toBe(true);
  });

  it('ссылка: для текста выделяет адрес, для готового адреса — подпись', () => {
    expect(applyFormat('link', 'сайт', 0, 4)).toEqual({ value: '[сайт](https://)', selStart: 7, selEnd: 15 });
    expect(applyFormat('link', 'https://a.ru', 0, 12)).toEqual({
      value: '[Ссылка](https://a.ru)',
      selStart: 1,
      selEnd: 7,
    });
  });
});

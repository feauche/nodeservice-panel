import { describe, expect, it } from 'vitest';

import {
  backupBlocks,
  bodyBlocks,
  digestBlocks,
  isRichRejected,
  type RichBlock,
  richMessageBlocks,
  richTextLength,
  sampleBlocks,
} from './telegram.rich.js';

const BODY = [
  'Онлайн: 605 → 0 (−100 %) за 5 минут',
  '',
  'Из России:',
  '• Мост — порт не отвечает совсем',
  '• Россия - 1 — порт не отвечает совсем',
  'Из-за рубежа:',
  '• Нидерланды - 2 — порт отвечает',
  '',
  'Похоже: блокировка IP на стороне России — сервер жив. Обычно помогает только смена IP.',
].join('\n');

const table = (b: RichBlock | undefined) =>
  b?.type === 'table' ? b.cells.map((r) => r.map((c) => c.text)) : null;

describe('расширенное оформление Telegram', () => {
  it('проверки порта — таблицами «Откуда / Результат», подписи — жирным', () => {
    const blocks = bodyBlocks(BODY);
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'table',
      'paragraph',
      'table',
      'paragraph',
      'paragraph',
    ]);
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      text: [{ type: 'bold', text: 'Онлайн:' }, ' 605 → 0 (−100 %) за 5 минут'],
    });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: '\u00a0' });
    expect(blocks[2]).toEqual({ type: 'paragraph', text: { type: 'bold', text: 'Из России:' } });
    // Подпись целиком с двоеточиями внутри — тоже жирная.
    expect(bodyBlocks('Вход арендодателя (amwey.guardora.pro:1819), из России:')).toEqual([
      {
        type: 'paragraph',
        text: { type: 'bold', text: 'Вход арендодателя (amwey.guardora.pro:1819), из России:' },
      },
    ]);
    expect(table(blocks[3])).toEqual([
      ['Откуда', 'Результат'],
      ['Мост', 'порт не отвечает совсем'],
      ['Россия - 1', 'порт не отвечает совсем'],
    ]);
    expect(table(blocks[5])).toEqual([
      ['Откуда', 'Результат'],
      ['Нидерланды - 2', 'порт отвечает'],
    ]);
  });

  it('у каждой ячейки заданы выравнивания, шапка помечена', () => {
    const t = bodyBlocks('• Мост — порт открыт')[0];
    expect(t).toMatchObject({ type: 'table', is_bordered: true, is_striped: true, is_compact: true });
    if (t?.type !== 'table') throw new Error('ожидалась таблица');
    expect(t.cells[0]?.every((c) => c.is_header === true)).toBe(true);
    expect(t.cells.flat().every((c) => c.align === 'left' && c.valign === 'top')).toBe(true);
    expect(t.cells[1]?.some((c) => 'is_header' in c)).toBe(false);
  });

  it('строки с точками без «кто — что» — обычный список, а не кривая таблица', () => {
    const blocks = bodyBlocks('Что сделать:\n• Проверьте оплату\n• Напишите хостеру');
    expect(blocks[1]).toEqual({
      type: 'list',
      items: [
        { blocks: [{ type: 'paragraph', text: 'Проверьте оплату' }] },
        { blocks: [{ type: 'paragraph', text: 'Напишите хостеру' }] },
      ],
    });
  });

  it('пустых блоков не бывает, а внутренний разрыв сохраняется безопасным пробелом', () => {
    const blocks = bodyBlocks('\n\n  \nСтрока\n\n\n•  \n');
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Строка' },
      { type: 'paragraph', text: '\u00a0' },
      { type: 'list', items: [{ blocks: [{ type: 'paragraph', text: '—' }] }] },
    ]);
  });

  it('ссылка в тексте не принимается за подпись', () => {
    expect(bodyBlocks('Откройте https://panel.example.com/incidents')[0]).toEqual({
      type: 'paragraph',
      text: 'Откройте https://panel.example.com/incidents',
    });
  });

  it('сообщение целиком: заголовок без повтора имени, сервер с адресом, текст, хвост', () => {
    const blocks = richMessageBlocks({
      event: 'incident_crit',
      title: 'Похоже на блокировку IP из России · Финляндия #01',
      body: BODY,
      server: { name: 'Финляндия #01', host: '95.216.10.4' },
      footer: 'Критичный инцидент · 23:11',
    });
    expect(blocks[0]).toEqual({ type: 'heading', size: 3, text: '🔴 Похоже на блокировку IP из России' });
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      text: [{ type: 'bold', text: 'Финляндия #01' }, ' · ', { type: 'code', text: '95.216.10.4' }],
    });
    expect(blocks[2]).toEqual({ type: 'paragraph', text: '\u00a0' });
    expect(blocks.at(-2)).toEqual({ type: 'paragraph', text: '\u00a0' });
    expect(blocks.at(-1)).toEqual({ type: 'footer', text: 'Критичный инцидент · 23:11' });
    // Разметку экранировать не нужно: текст идёт как есть.
    const raw = richMessageBlocks({ event: 'resolved', title: 'a <b> & c', body: null, server: null });
    expect(raw).toEqual([{ type: 'heading', size: 3, text: '✅ a <b> & c' }]);
  });

  it('разбор Джарвиса, уточнение и таблица не слипаются', () => {
    const blocks = bodyBlocks(
      [
        '🤖 Разбор Джарвиса (уверенность средняя): причина.',
        '',
        'Уточнено: свежая проверка.',
        '',
        'Порт SSH 5492 — ни из одной страны:',
        '• Мост — порт не отвечает',
      ].join('\n'),
    );
    expect(blocks.map((b) => (b.type === 'paragraph' ? b.text : b.type))).toEqual([
      [{ type: 'bold', text: '🤖 Разбор Джарвиса (уверенность средняя):' }, ' причина.'],
      '\u00a0',
      [{ type: 'bold', text: 'Уточнено:' }, ' свежая проверка.'],
      '\u00a0',
      { type: 'bold', text: 'Порт SSH 5492 — ни из одной страны:' },
      'table',
    ]);
  });

  it('очень длинный текст обрезается, а не упирается в предел Telegram', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Строка ${i}: ${'я'.repeat(60)}`).join('\n');
    const blocks = richMessageBlocks({ event: 'incident_warn', title: 'Т', body: long, server: null });
    expect(blocks.length).toBeLessThanOrEqual(123);
    expect(richTextLength(blocks)).toBeLessThan(13_000);
    expect(blocks.at(-1)).toEqual({ type: 'paragraph', text: '…остальное — в панели.' });
  });

  it('утренняя сводка — таблица «Когда / Что было»', () => {
    const blocks = digestBlocks([{ time: '03:10', title: 'Контейнер ноды не запущен · Нидерланды - 2' }], 4);
    expect(table(blocks[1])).toEqual([
      ['Когда', 'Что было'],
      ['03:10', 'Контейнер ноды не запущен · Нидерланды - 2'],
    ]);
    expect(blocks[2]).toEqual({ type: 'paragraph', text: '…и ещё 4' });
    expect(digestBlocks([{ time: '03:10', title: 'x' }], 0).map((b) => b.type)).toEqual([
      'heading',
      'table',
      'footer',
    ]);
  });

  it('резервная копия — rich-карточка с таблицей и честным предупреждением о защите', () => {
    const blocks = backupBlocks({
      when: '2 октября, 03:10',
      zone: 'Омск',
      size: '18,4 МБ',
      contents: 'база, ключи, метрики',
      encrypted: false,
    });
    expect(blocks[0]).toEqual({ type: 'heading', size: 3, text: '🗄 Резервная копия NodeService' });
    expect(table(blocks[1])).toEqual([
      ['Создана', '2 октября, 03:10 (Омск)'],
      ['Размер', '18,4 МБ'],
      ['Внутри', 'база, ключи, метрики'],
      ['Защита', 'Без пароля'],
    ]);
    expect(blocks[2]).toEqual({ type: 'paragraph', text: '⚠ Архив не защищён паролем.' });
    expect(blocks.at(-1)?.type).toBe('footer');
  });

  it('резервная копия частями показывает число файлов и команду объединения', () => {
    const command = 'cat nodeservice-backup-x.tar.gz.enc.part-* > nodeservice-backup-x.tar.gz.enc';
    const blocks = backupBlocks({
      when: '5 октября, 17:46',
      zone: 'Омск',
      size: '60,9 МБ',
      contents: 'база, ключи',
      encrypted: true,
      parts: 2,
      mergeCommand: command,
    });
    expect(blocks).toContainEqual({
      type: 'paragraph',
      text: '📦 Архив разделён на 2 части. Скачайте все части в одну папку.',
    });
    expect(blocks).toContainEqual({ type: 'paragraph', text: { type: 'code', text: command } });
  });

  it('образец для кнопки «Проверить» содержит заголовок и таблицу', () => {
    const blocks = sampleBlocks('Чат парка');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'table', 'footer']);
    expect(blocks.at(-1)).toEqual({ type: 'footer', text: 'Образец · Чат парка' });
  });

  it('когда отказ Telegram относится к оформлению (тогда шлём по-старому), а когда — к чату или сети', () => {
    // Старый сервер Bot API, не принятая разметка — оформление.
    expect(isRichRejected(404, 'Not Found: method not found')).toBe(true);
    expect(isRichRejected(400, 'Bad Request: rich message must be non-empty')).toBe(true);
    expect(isRichRejected(400, 'Bad Request: can\'t parse InputRichBlock: type "x" is unsupported')).toBe(
      true,
    );
    expect(isRichRejected(400, 'Bad Request: RICH_MESSAGE_CONTENT_REQUIRED')).toBe(true);
    expect(
      isRichRejected(
        400,
        "Bad Request: Can't parse PageBlockTableCell: Invalid horizontal alignment specified",
      ),
    ).toBe(true);
    // Чат, права, лимит частоты, сеть — оформление ни при чём.
    expect(isRichRejected(400, 'Bad Request: chat not found')).toBe(false);
    expect(isRichRejected(403, 'Forbidden: bot was blocked by the user')).toBe(false);
    expect(isRichRejected(429, 'Too Many Requests: retry after 12')).toBe(false);
    expect(isRichRejected(0, 'timeout')).toBe(false);
    expect(isRichRejected(0, 'network')).toBe(false);
  });
});

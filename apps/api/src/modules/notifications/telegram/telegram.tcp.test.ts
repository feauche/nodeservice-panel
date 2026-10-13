import type { NodeTcpDiagnostics } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import { formatTelegramMessage } from './telegram.format.js';
import { type RichBlock, richMessageBlocks } from './telegram.rich.js';

const point = (country: string, state: 'ok' | 'failed') => ({
  node: `${country}1.node.check-host.net`,
  country,
  city: '',
  state,
  error: null,
});
const port = (target: string, link: string) => ({
  verdict: 'reachable' as const,
  checkedAt: '2026-10-13T02:06:40.000Z',
  target,
  link,
  observations: [
    point('ru', 'ok'),
    point('ru', 'ok'),
    point('ru', 'ok'),
    point('de', 'ok'),
    point('fi', 'ok'),
    point('nl', 'ok'),
  ],
  error: null,
});
const tcp: NodeTcpDiagnostics = {
  source: 'checkhost',
  online: { before: 286, after: 0 },
  report: {
    ...port('85.155.96.99:5492', 'https://check-host.net/check-report/509c577ek217'),
    ports: [
      port('85.155.96.99:5492', 'https://check-host.net/check-report/509c577ek217'),
      port('85.155.96.99:26572', 'https://check-host.net/check-report/509c57d5k2bb'),
    ],
  },
};
const message = {
  event: 'incident_crit' as const,
  title: 'Падение онлайна',
  body: 'Онлайн: 286 → 0.\nTCP-порт доступен из РФ и других стран.\n85.155.96.99:5492: доступен.\nhttps://check-host.net/check-report/509c577ek217',
  server: { name: 'vk (Аренда)', host: '85.155.96.99' },
  footer: 'Критичное событие · 08:06',
  tcp,
};

describe('событие с проверкой портов в Telegram (витрина telegram-2026-10, вариант C)', () => {
  it('обычное сообщение: онлайн, вывод со значком, строка на порт без адреса со ссылкой «отчёт»', () => {
    const t = formatTelegramMessage(message);
    expect(t).toContain('<b>Онлайн:</b> 286 → 0 (−100 %)\n\n<b>🟢 Порты доступны</b>');
    expect(t).toContain(
      '• <b>Порт <code>5492</code></b> — РФ 3 из 3 · другие 3 из 3 · <a href="https://check-host.net/check-report/509c577ek217">отчёт</a>',
    );
    // Адрес — только под заголовком; сырых ссылок строками нет.
    expect(t.match(/85\.155\.96\.99/g)).toHaveLength(1);
    expect(t.split('\n').some((l) => l.startsWith('https://'))).toBe(false);
    expect(t.endsWith('\n\n<i>Критичное событие · 08:06</i>')).toBe(true);
  });

  it('расширенное сообщение: порты столбцами без адреса, строки «РФ» и «Другие страны», без ссылок в тексте', () => {
    const blocks = richMessageBlocks(message);
    const table = blocks.find((b): b is Extract<RichBlock, { type: 'table' }> => b.type === 'table');
    expect(table?.cells.map((row) => row.map((c) => c.text))).toEqual([
      ['Откуда', { type: 'code', text: '5492' }, { type: 'code', text: '26572' }],
      ['РФ', '3 из 3', '3 из 3'],
      ['Другие страны', '3 из 3', '3 из 3'],
    ]);
    expect(JSON.stringify(blocks)).not.toContain('85.155.96.99:');
    expect(JSON.stringify(blocks)).not.toContain('https://');
    expect(blocks.at(-1)).toEqual({ type: 'footer', text: 'Критичное событие · 08:06' });
  });

  it('частично из РФ и повтор подтвердил: две строки РФ со временем обеих проверок по поясу панели', () => {
    const partial = (at: string, ru: Array<'ok' | 'failed'>) => ({
      ...port('94.183.255.199:5492', 'https://check-host.net/check-report/aaa'),
      verdict: 'russia_partial' as const,
      checkedAt: at,
      observations: [
        ...ru.map((s) => point('ru', s)),
        point('de', 'ok'),
        point('fi', 'ok'),
        point('nl', 'ok'),
      ],
    });
    const first = partial('2026-10-13T10:09:20.000Z', ['ok', 'failed', 'failed']);
    const again = partial('2026-10-13T10:10:40.000Z', ['ok', 'ok', 'failed']);
    const msg = {
      ...message,
      timeZone: 'Asia/Omsk',
      tcp: {
        source: 'checkhost' as const,
        online: { before: 499, after: 77 },
        report: { ...again, ports: [again], confirmed: true, first: { ...first, ports: [first] } },
      },
    };
    const table = richMessageBlocks(msg).find(
      (b): b is Extract<RichBlock, { type: 'table' }> => b.type === 'table',
    );
    expect(table?.cells.map((row) => row.map((c) => c.text))).toEqual([
      ['Откуда', { type: 'code', text: '5492' }],
      ['РФ, 16:09', '1 из 3'],
      ['РФ, 16:10', '2 из 3'],
      ['Другие страны', '3 из 3'],
    ]);
    const t = formatTelegramMessage(msg);
    expect(t).toContain('<b>🟠 Частично недоступен из РФ</b>\nИз России подключилась только часть точек');
    expect(t).toContain('— РФ 1 из 3, повтор 2 из 3 · другие 3 из 3');
  });

  it('сообщение сценария: строки шагов, под ними таблица портов без вывода', () => {
    const msg = {
      event: 'scenario' as const,
      title: 'Сценарий: Критическое падение онлайна',
      body: 'Условие: Подтверждено падение онлайна\n\n🟠 TCP: частично недоступен из РФ\n✅ Записано в событие «Падение онлайна»',
      server: { name: 'Нидерланды - 1', host: '94.183.255.199' },
      footer: 'Сценарий · 16:12',
      ports: tcp.report,
    };
    const blocks = richMessageBlocks(msg);
    const lastStep = blocks.findIndex((b) => JSON.stringify(b).includes('✅ Записано'));
    // Таблица — под строками шагов, подпись — последней; вывода над таблицей нет (он в строке «TCP: …»).
    expect(blocks.findIndex((b) => b.type === 'table')).toBeGreaterThan(lastStep);
    expect(blocks.at(-1)).toEqual({ type: 'footer', text: 'Сценарий · 16:12' });
    expect(JSON.stringify(blocks)).not.toContain('Порты доступны');
    expect(formatTelegramMessage(msg)).toContain(
      '<b>Порты:</b> 5492 — РФ 3 из 3 · 26572 — РФ 3 из 3 · другие страны 3 из 3',
    );
  });

  it('«Восстановление»: строки онлайна, прежнего адреса, порта и DNS вместо одной фразы', () => {
    const msg = {
      event: 'resolved' as const,
      title: 'Восстановление',
      body: 'Нода снова работает: адрес сменили, порт доступен, онлайн 274.',
      server: { name: 'Германия - 1', host: '87.120.187.164' },
      footer: 'Починилось за 16 мин · 16:26',
      recovery: {
        online: { low: 61, now: 274, before: 451, usual: null },
        oldAddress: '177.3.216.253',
        tcp: { ...tcp.report, ports: [port('87.120.187.164:5492', 'https://check-host.net/check-report/b')] },
        dns: { label: 'DNS-запись de1.example.ru', text: 'обновлена автоматически' },
      },
    };
    expect(formatTelegramMessage(msg)).toBe(
      [
        '✅ <b>Восстановление</b>',
        '<b>Германия - 1</b> · <code>87.120.187.164</code>',
        '',
        '<b>Онлайн:</b> 61 → 274 (до падения 451)',
        '<b>Адрес сменили:</b> был <code>177.3.216.253</code>',
        '<b>Порт 5492:</b> РФ 3 из 3 · другие 3 из 3',
        '<b>DNS-запись de1.example.ru:</b> обновлена автоматически',
        '',
        '<i>Починилось за 16 мин · 16:26</i>',
      ].join('\n'),
    );
    const blocks = richMessageBlocks(msg);
    expect(blocks.filter((b) => b.type === 'paragraph').map((b) => JSON.stringify(b))).toContain(
      JSON.stringify({
        type: 'paragraph',
        text: [
          { type: 'bold', text: 'Адрес сменили:' },
          ' ',
          'был ',
          { type: 'code', text: '177.3.216.253' },
        ],
      }),
    );
  });
});

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

describe('событие с проверкой портов в Telegram', () => {
  it('обычное сообщение: онлайн, вывод, порты строками со ссылкой «отчёт», разделы через пустую строку', () => {
    const t = formatTelegramMessage(message);
    expect(t).toContain('<b>Онлайн:</b> 286 → 0 (−100 %)\n\n<b>IP доступен: хотя бы один порт отвечает</b>');
    expect(t).toContain(
      '• <code>85.155.96.99:5492</code> — доступен: РФ 3 из 3, другие страны 3 из 3 · <a href="https://check-host.net/check-report/509c577ek217">отчёт</a>',
    );
    // Сырых адресов отдельными строками больше нет: текст события заменён разделами проверки.
    expect(t.split('\n').some((l) => l.startsWith('https://'))).toBe(false);
    expect(t.endsWith('\n\n<i>Критичное событие · 08:06</i>')).toBe(true);
  });

  it('расширенное сообщение: таблица «Порт / РФ / Другие страны / Итог», отступы между разделами, без ссылок в тексте', () => {
    const blocks = richMessageBlocks(message);
    const table = blocks.find((b): b is Extract<RichBlock, { type: 'table' }> => b.type === 'table');
    expect(table?.cells[0]?.map((c) => c.text)).toEqual(['Порт', 'РФ', 'Другие страны', 'Итог']);
    expect(table?.cells[1]?.map((c) => c.text)).toEqual([
      { type: 'code', text: '85.155.96.99:5492' },
      '3 из 3',
      '3 из 3',
      'Доступен',
    ]);
    expect(table?.cells).toHaveLength(3);
    const spacers = blocks.filter((b) => b.type === 'paragraph' && b.text === ' ').length;
    expect(spacers).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(blocks)).not.toContain('https://');
    expect(blocks.at(-1)).toEqual({ type: 'footer', text: 'Критичное событие · 08:06' });
  });
});

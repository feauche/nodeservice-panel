import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZvenoProvider } from './zveno.provider.js';

/** Ответ провайдера с вызовами инструментов — как его отдаёт OpenAI-совместимый шлюз. */
const reply = (calls: Array<{ name: string; args: unknown }>) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c, i) => ({
              id: `call_${i}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const run = () => new ZvenoProvider().run({ apiKey: 'k', model: 'm', system: 's', messages: [], tools: [] });

describe('ZvenoProvider: аргументы инструментов', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('статья с HTML, <kbd> и <details> доходит до инструмента целиком', async () => {
    const content = [
      '# Сайт-заглушка',
      '',
      '```html',
      '<head><title>Моя страница</title></head>',
      '```',
      '',
      'Нажмите <kbd>Ctrl</kbd>+<kbd>O</kbd>.',
      '',
      '<details><summary>Подробнее</summary>Порт 443 должен быть свободен.</details>',
      '',
      '## Проверка',
      '',
      '`curl -I https://example.com` отвечает 200.',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply([{ name: 'save_kb_article', args: { title: 'Сайт-заглушка', content } }])),
    );
    const res = await run();
    expect(res.stopReason).toBe('tool_use');
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'call_0', name: 'save_kb_article', input: { title: 'Сайт-заглушка', content } },
    ]);
  });

  it('параметр, вписанный разметкой в текст, по-прежнему возвращается в своё поле', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply([
          {
            name: 'submit_hint',
            args: {
              title: 'Диск почти полон',
              explanation:
                'Свободно меньше гигабайта.</explanation> <parameter name="commands">[{"command":"df -h","note":"Сколько занято"}]</parameter>',
            },
          },
        ]),
      ),
    );
    const res = await run();
    expect(res.blocks[0]).toMatchObject({
      name: 'submit_hint',
      input: {
        title: 'Диск почти полон',
        explanation: 'Свободно меньше гигабайта.',
        commands: [{ command: 'df -h', note: 'Сколько занято' }],
      },
    });
  });
});

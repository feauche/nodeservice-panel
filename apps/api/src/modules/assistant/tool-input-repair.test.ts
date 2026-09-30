import { describe, expect, it } from 'vitest';

import { repairToolInput } from './tool-input-repair.js';

describe('repairToolInput', () => {
  it('параметры, вписанные разметкой в текст, возвращаются в свои поля', () => {
    const r = repairToolInput({
      title: 'Агент не на связи',
      explanation:
        'Проверьте службу агента и её логи.</explanation> <parameter name="commands">[{"command":"systemctl status nodeservice-agent","note":"Запущена ли служба"},{"command":"journalctl -u nodeservice-agent -n 50 --no-pager","note":"Ошибки в логе"}]</parameter>',
    }) as Record<string, unknown>;
    expect(r.explanation).toBe('Проверьте службу агента и её логи.');
    expect(r.commands).toEqual([
      { command: 'systemctl status nodeservice-agent', note: 'Запущена ли служба' },
      { command: 'journalctl -u nodeservice-agent -n 50 --no-pager', note: 'Ошибки в логе' },
    ]);
  });
  it('заполненное моделью поле не перетирается; обычный текст с < и > не трогается', () => {
    const r = repairToolInput({
      explanation: 'Текст.</explanation><parameter name="commands">[]',
      commands: [{ command: 'df -h', note: 'диск' }],
      note: 'порт < 1024 и > 0',
    }) as Record<string, unknown>;
    expect(r.commands).toEqual([{ command: 'df -h', note: 'диск' }]);
    expect(r.explanation).toBe('Текст.');
    expect(r.note).toBe('порт < 1024 и > 0');
  });
  it('не объект — как есть', () => {
    expect(repairToolInput(null)).toBeNull();
    expect(repairToolInput([1])).toEqual([1]);
  });

  /** Статья, какой её пишет модель: HTML в блоке кода, клавиши, сворачиваемый блок, XML-профиль. */
  const ARTICLE = [
    '# Сайт-заглушка для self-steal',
    '',
    'Положите страницу в `/var/www/html/index.html`:',
    '',
    '```html',
    '<!doctype html>',
    '<html lang="ru">',
    '<head><title>Моя страница</title></head>',
    '<body><h1>Скоро здесь будет сайт</h1></body>',
    '</html>',
    '```',
    '',
    'В редакторе нажмите <kbd>Ctrl</kbd>+<kbd>O</kbd>, затем <kbd>Enter</kbd>.',
    '',
    '<details>',
    '<summary>Если порт 443 занят</summary>',
    '',
    'Посмотрите, кто слушает: `ss -ltnp | grep :443`.',
    '',
    '</details>',
    '',
    'Профиль для iOS (`.mobileconfig`):',
    '',
    '```xml',
    '<dict>',
    '  <key>PayloadType</key>',
    '  <string>com.apple.vpn.managed</string>',
    '</dict>',
    '```',
    '',
    '## Проверка',
    '',
    '1. `curl -I https://example.com` отвечает 200.',
    '2. В логах ноды нет ошибок рукопожатия.',
  ].join('\n');

  it('статья базы знаний с HTML в блоке кода, <kbd> и <details> не обрезается на закрывающем теге', () => {
    const r = repairToolInput(
      { title: 'Сайт-заглушка для self-steal', content: ARTICLE, tags: ['xray', 'инструкция'] },
      'save_kb_article',
    ) as Record<string, unknown>;
    expect(r.content).toBe(ARTICLE);
    expect(r.title).toBe('Сайт-заглушка для self-steal');
    expect(r.tags).toEqual(['xray', 'инструкция']);
  });

  it('в теле статьи середина не трогается никогда: в ней по праву бывает и XML с тегами, похожими на разметку вызова', () => {
    const content = [
      'Пример настройки:',
      '',
      '```xml',
      '<parameter name="mtu">1400</parameter>',
      '<parameter name="dns">1.1.1.1</parameter>',
      '```',
      '',
      'После правки перезапустите службу.',
    ].join('\n');
    const r = repairToolInput({ title: 'Настройка туннеля', content }, 'save_kb_article') as Record<
      string,
      unknown
    >;
    expect(r).toEqual({ title: 'Настройка туннеля', content });
  });

  it('закрывающий тег в любом тексте — не разметка вызова: текст остаётся целым, у какого инструмента он ни был', () => {
    const explanation =
      'Сервер отдаёт страницу с заголовком <title>403 Forbidden</title> — доступ закрыт правилом nginx. Нажмите <kbd>q</kbd>, чтобы выйти из просмотра.';
    expect(repairToolInput({ title: 'Доступ закрыт', explanation, commands: [] }, 'submit_hint')).toEqual({
      title: 'Доступ закрыт',
      explanation,
      commands: [],
    });
    // Без имени инструмента — то же самое: HTML в тексте не режется.
    expect(repairToolInput({ content: ARTICLE })).toEqual({ content: ARTICLE });
    // Собственное имя поля в середине текста — тоже текст, а не конец поля.
    expect(repairToolInput({ title: 'Что значит </title> в коде страницы', content: 'x' })).toEqual({
      title: 'Что значит </title> в коде страницы',
      content: 'x',
    });
  });

  it('хвост из разметки вызова по-прежнему срезается: закрытие своего поля, </parameter>, </invoke>', () => {
    const r = repairToolInput(
      {
        verdict: 'Диск заполнен логами.</verdict>',
        unknown: 'Данных о сети нет.</unknown> </invoke>',
        explanation:
          'Служба остановлена.</parameter>\n<parameter name="commands">[{"command":"systemctl status xray","note":"Состояние службы"}]</parameter>\n</invoke>',
      },
      'submit_hint',
    ) as Record<string, unknown>;
    expect(r.verdict).toBe('Диск заполнен логами.');
    expect(r.unknown).toBe('Данных о сети нет.');
    expect(r.explanation).toBe('Служба остановлена.');
    expect(r.commands).toEqual([{ command: 'systemctl status xray', note: 'Состояние службы' }]);
  });

  it('в теле статьи срезается только хвост из закрывающих тегов разметки вызова в самом конце', () => {
    const body = [
      '# Настройка туннеля',
      '',
      '```xml',
      '<parameter name="mtu">1400</parameter>',
      '```',
      '',
      'Итог: </content> и </invoke> в середине текста остаются как есть.',
      '',
      '<details><summary>Подробнее</summary>Перезапустите службу.</details>',
    ].join('\n');
    const r = repairToolInput(
      { title: 'Настройка туннеля', content: `${body}</content>\n</parameter>\n</invoke>\n` },
      'save_kb_article',
    ) as Record<string, unknown>;
    expect(r.content).toBe(body);
    // Статья, которая сама кончается тегом, не из разметки вызова, — целая.
    expect(repairToolInput({ content: body }, 'save_kb_article')).toEqual({ content: body });
  });

  it('следом вписан ещё один вызов: текст поля чистый, а параметры чужого вызова в этот не попадают', () => {
    const r = repairToolInput(
      {
        title: 'Служба остановлена',
        explanation:
          'Перезапустите службу.</parameter>\n</invoke>\n<invoke name="get_server_detail">\n<parameter name="server">de-1</parameter>\n</invoke>',
        note: 'Готово.</note>\n</invoke>\n</function_calls>\n<function_calls>\n<invoke name="search_kb">',
      },
      'submit_hint',
    ) as Record<string, unknown>;
    expect(r).toEqual({ title: 'Служба остановлена', explanation: 'Перезапустите службу.', note: 'Готово.' });
    // Свой параметр до чужого вызова по-прежнему возвращается в своё поле.
    const own = repairToolInput({
      explanation:
        'Текст.</explanation> <parameter name="commands">[{"command":"df -h","note":"диск"}]</parameter>\n</invoke>\n<invoke name="x">\n<parameter name="server">de-1</parameter>',
    }) as Record<string, unknown>;
    expect(own).toEqual({ explanation: 'Текст.', commands: [{ command: 'df -h', note: 'диск' }] });
  });

  it('поле закрыто своим тегом, а дальше идут чужие теги — это уже не текст поля; обычный текст после тега остаётся', () => {
    // Модель «закрыла» поле и дописала следующее своими тегами, без <parameter>: текст поля — до закрытия.
    expect(
      repairToolInput({
        title: 'Диск почти полон',
        explanation: 'Свободно меньше гигабайта.</explanation>\n<commands>[{"command":"df -h"}]</commands>',
      }),
    ).toEqual({ title: 'Диск почти полон', explanation: 'Свободно меньше гигабайта.' });
    // А если после такого же тега идёт обычный текст — это текст, его не режем.
    const text = 'Тег </explanation> в ответе модели означает конец поля, но здесь это просто слово.';
    expect(repairToolInput({ explanation: text })).toEqual({ explanation: text });
  });

  it('длинный хвост из пробелов не подвешивает разбор', () => {
    const tail = ' '.repeat(50_000);
    const t0 = Date.now();
    expect(repairToolInput({ a: `Текст.${tail}`, b: `Текст.</b>${tail}</invoke>${tail}` })).toEqual({
      a: `Текст.${tail}`,
      b: 'Текст.',
    });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('имя инструмента и имена полей приходят от модели: любые строки, в том числе «constructor», не роняют разбор', () => {
    expect(repairToolInput({ text: 'Готово.</text>' }, 'constructor')).toEqual({ text: 'Готово.' });
    expect(repairToolInput({ 'a.b(c)': 'Готово.</a.b(c)> </invoke>' }, 'toString')).toEqual({
      'a.b(c)': 'Готово.',
    });
  });

  it('статья, уехавшая разметкой в заголовок, возвращается в тело целиком — вместе со своим HTML', () => {
    const r = repairToolInput(
      { title: `Сайт-заглушка</title>\n<parameter name="content">${ARTICLE}</parameter>\n</invoke>` },
      'save_kb_article',
    ) as Record<string, unknown>;
    expect(r.title).toBe('Сайт-заглушка');
    expect(r.content).toBe(ARTICLE);
  });
});

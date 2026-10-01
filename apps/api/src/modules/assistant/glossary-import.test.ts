import { describe, expect, it } from 'vitest';

import {
  DOCKER_INFO,
  DOCKER_INSPECT,
  FAQ_TEXT,
  GLOSSARY_TEXT,
  GLOSSARY_TEXT_TERMS,
  LSCPU_QUESTION,
  MACHINE_LIKE_LINES,
  MACHINE_LIKE_TERMS,
} from './glossary-import.fixture.js';
import {
  asksQuestion,
  autoGlossary,
  extractDefinitions,
  glossaryImportReply,
  isGlossaryArticle,
  isPureGlossary,
  parseGlossaryText,
  parseTermLine,
} from './glossary-import.js';

const GUIDE = `# Установка ноды

Сначала подготовьте сервер. Понадобится Docker и открытый порт 443.

Шаг 1: Установите Docker и проверьте версию командой docker --version
Шаг 2: Скачайте образ ноды и запустите контейнер с нужными параметрами

\`\`\`bash
docker run -d remnawave/node
\`\`\`

Важно: порт 443 должен быть свободен, иначе нода не поднимется на этом сервере.

Reality: способ маскировки, при котором VPN выдаёт себя за визит на популярный сайт.
SNI: имя сайта, которое видно в начале TLS-соединения ещё до шифрования.
`;

describe('parseTermLine', () => {
  it('двоеточие, тире, список и строка таблицы дают термин и объяснение', () => {
    const want = { term: 'SNI', explain: 'имя сайта, видимое в начале TLS-соединения до шифрования' };
    expect(parseTermLine('SNI: имя сайта, видимое в начале TLS-соединения до шифрования')).toEqual(want);
    expect(parseTermLine('SNI — имя сайта, видимое в начале TLS-соединения до шифрования')).toEqual(want);
    expect(parseTermLine('- **SNI** — имя сайта, видимое в начале TLS-соединения до шифрования')).toEqual(
      want,
    );
    expect(parseTermLine('| SNI | имя сайта, видимое в начале TLS-соединения до шифрования |')).toEqual(want);
  });
  it('заголовки, шаги, короткие «ключ: значение» и предложения с двоеточием — не термины', () => {
    for (const line of [
      '## Термины: коротко',
      'Шаг 1: Установите Docker и проверьте версию командой',
      'Важно: порт 443 должен быть свободен, иначе нода не поднимется',
      'Порт: 443',
      'Панель: что с чем связано',
      'Здесь собраны все термины, которые встречаются в гайдах, коротко и без занудства. Не нужно учить наизусть: просто возвращайтесь сюда.',
      'Это очень длинное предложение из многих слов, где двоеточие стоит далеко: и что дальше происходит',
      'https://example.com/path: ссылка на страницу с подробным описанием',
      '',
    ])
      expect(parseTermLine(line), line).toBeNull();
  });
});

describe('словарь терминов', () => {
  it('из настоящего текста владельца берутся все термины, без заголовков и вступления', () => {
    const terms = parseGlossaryText(GLOSSARY_TEXT);
    expect(terms).toHaveLength(GLOSSARY_TEXT_TERMS);
    const names = terms.map((t) => t.term);
    for (const t of [
      'DPI (Deep Packet Inspection)',
      'ТСПУ',
      'Self-steal (селфстил)',
      'sendThrough',
      'Гео-файлы',
    ])
      expect(names).toContain(t);
    for (const junk of ['Панель: что с чем связано', 'Термины простыми словами', 'Не нашли термин?'])
      expect(names.join('|')).not.toContain(junk);
    expect(terms.every((t) => t.explain.length >= 20)).toBe(true);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });
  it('такой текст целиком словарь: статья не нужна', () => {
    expect(isPureGlossary(GLOSSARY_TEXT)).toBe(true);
  });
  it('гайд с шагами, кодом и парой определений — не словарь: статью собирать можно', () => {
    expect(isPureGlossary(GUIDE)).toBe(false);
    // определения в нём всё равно находятся: их отдаст модель или разбор по строкам
    expect(parseGlossaryText(GUIDE).map((t) => t.term)).toEqual(['Reality', 'SNI']);
  });
  it('список настроек «ключ: значение» словарём не считается', () => {
    const cfg = Array.from({ length: 12 }, (_, i) => `Параметр${i}: значение${i}`).join('\n');
    expect(isPureGlossary(cfg)).toBe(false);
  });
  it('мало определений — тоже не словарь', () => {
    const few = GLOSSARY_TEXT.split('\n').slice(0, 12).join('\n');
    expect(parseGlossaryText(few).length).toBeLessThan(8);
    expect(isPureGlossary(few)).toBe(false);
  });
});

describe('isGlossaryArticle: защита от статьи-глоссария', () => {
  it('статья со словарём внутри или с «глоссарий» в названии отклоняется', () => {
    expect(isGlossaryArticle('Глоссарий терминов VPN и обхода DPI', GLOSSARY_TEXT)).toBe(true);
    expect(
      isGlossaryArticle(
        'Словарь',
        Array.from(
          { length: 4 },
          (_, n) => `Термин${n}: система у оператора, которая смотрит на вид трафика`,
        ).join('\n'),
      ),
    ).toBe(true);
    expect(isGlossaryArticle('Разные заметки', GLOSSARY_TEXT)).toBe(true);
  });
  it('обычная инструкция проходит, даже если в ней есть пара определений', () => {
    expect(isGlossaryArticle('Установка ноды', GUIDE)).toBe(false);
    expect(isGlossaryArticle('Глоссарий', 'Пусто.')).toBe(false);
  });
});

describe('glossaryImportReply', () => {
  it('называет числа и прямо говорит, что статьи нет', () => {
    const text = glossaryImportReply(68, 68);
    expect(text).toContain('отдельную статью я не создавал');
    expect(text).toContain('Найдено терминов: 68');
    expect(text).toContain('Добавлено новых: 68');
    expect(text).toContain('Уже были в глоссарии: 0');
  });
  it('повторы называются по именам и не добавляются', () => {
    const text = glossaryImportReply(68, 60, ['SSH', 'CPU']);
    expect(text).toContain('Добавлено новых: 60');
    expect(text).toContain('Уже были в глоссарии: 2 (SSH, CPU)');
    expect(text).toContain('Повторы не добавлялись');
  });
});

describe('вставка из браузера и чужие форматы', () => {
  it('переносы строк Safari и Word (CR, CRLF, U+2028) не мешают разбору', () => {
    for (const nl of ['\r\n', '\r', '\u2028', '\u2029', '\u000b']) {
      const text = GLOSSARY_TEXT.replace(/\n/g, nl);
      expect(parseGlossaryText(text), JSON.stringify(nl)).toHaveLength(GLOSSARY_TEXT_TERMS);
      expect(isPureGlossary(text), JSON.stringify(nl)).toBe(true);
    }
  });
  it('лог, вывод docker и настройки словарём не считаются', () => {
    const log = Array.from(
      { length: 12 },
      (_, i) =>
        `2026-09-26 12:00:${String(i).padStart(2, '0')} INFO xray: connection from client accepted after handshake ok`,
    ).join('\n');
    const cfg = Array.from({ length: 12 }, (_, i) => `listen_port_${i}: 44${i}`).join('\n');
    const docker = `CONTAINER ID   IMAGE   STATUS\n${Array.from({ length: 10 }, (_, i) => `abc${i}   remnawave/node:latest   Up ${i} hours [healthy]`).join('\n')}`;
    expect(extractDefinitions(log), 'лог').toBeNull();
    expect(isPureGlossary(log), 'лог').toBe(false);
    expect(isPureGlossary(cfg), 'настройки').toBe(false);
    expect(isPureGlossary(docker), 'docker').toBe(false);
  });
  it('extractDefinitions отдаёт термины и из смешанного текста с разделом «Термины»', () => {
    const guide = Array.from(
      { length: 20 },
      (_, i) =>
        `Шаг ${i + 1}. Подробно опишите, что нужно сделать на этом этапе установки, какие команды выполнить и как проверить результат, чтобы не возвращаться к нему позже.`,
    ).join('\n\n');
    const mixed = `# Установка Reality\n\n${guide}\n\n## Термины\n${GLOSSARY_TEXT.split('\n').slice(6, 22).join('\n')}`;
    expect(extractDefinitions(mixed)?.length).toBeGreaterThanOrEqual(8);
    expect(isPureGlossary(mixed)).toBe(false);
  });
});

/** Словарь владельца без первой строки «Термины простыми словами»: те же строки, но без пометки «это словарь». */
const UNMARKED_GLOSSARY = GLOSSARY_TEXT.split('\n').slice(1).join('\n');

describe('вывод команд, «проблема: решение» и вопросы — не словарь', () => {
  it('вывод lscpu с вопросом: ни одной строки-определения, модель не обходится', () => {
    expect(parseGlossaryText(LSCPU_QUESTION)).toEqual([]);
    expect(extractDefinitions(LSCPU_QUESTION)).toBeNull();
    expect(isPureGlossary(LSCPU_QUESTION)).toBe(false);
    expect(autoGlossary(LSCPU_QUESTION)).toBeNull();
  });
  it('docker inspect и docker info: ключи в кавычках, хэши, пути и даты в «Пояснения» не идут', () => {
    for (const [name, text] of Object.entries({ DOCKER_INSPECT, DOCKER_INFO })) {
      expect(parseGlossaryText(text), name).toEqual([]);
      expect(extractDefinitions(text), name).toBeNull();
      expect(autoGlossary(text), name).toBeNull();
    }
  });
  it('строка «ключ: значение» из вывода команды не термин, русское объяснение — термин', () => {
    for (const line of [
      '"Id": "3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f",',
      '"Name": имя контейнера, под которым его видно в списке',
      'ResolvConfPath: /var/lib/docker/containers/3f4e8a0c2b1d/resolv.conf',
      'Spectre v1: Mitigation; usercopy/swapgs barriers and __user pointer sanitization',
      'Flags: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov',
      'Обновление: 2026-09-20T08:14:03 установлено автоматически на всех серверах',
      'Хэш образа: sha256:9b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c',
      'Каталог данных: лежит в /var/lib/docker/volumes на каждом сервере',
      'Причины: высокая нагрузка; нехватка памяти; перегрузка канала',
    ])
      expect(parseTermLine(line), line).toBeNull();
    // Латинский ключ с русским объяснением — обычное определение (из словаря владельца).
    expect(
      parseTermLine('sendThrough: настройка, указывающая, с какого адреса сервера уходит соединение'),
    ).not.toBeNull();
    expect(parseTermLine('WireGuard: быстрый протокол VPN, встроенный в ядро Linux')).not.toBeNull();
    // Русский термин в прямых кавычках — не ключ JSON.
    expect(
      parseTermLine('"Белый список": адреса, которые оператор пропускает даже при жёстких ограничениях'),
    ).not.toBeNull();
  });
  it('строки внутри блока кода не разбираются', () => {
    const lines = GLOSSARY_TEXT.split('\n').slice(8, 20).join('\n');
    expect(parseGlossaryText(`Термины\n\`\`\`\n${lines}\n\`\`\``)).toEqual([]);
  });
  it('«проблема: решение» без пометки словаря: модель отвечает, статью сохранить можно', () => {
    expect(extractDefinitions(FAQ_TEXT)).toBeNull();
    expect(isPureGlossary(FAQ_TEXT)).toBe(false);
    expect(autoGlossary(FAQ_TEXT)).toBeNull();
    expect(isGlossaryArticle('Частые проблемы клиентов', FAQ_TEXT)).toBe(false);
    expect(isGlossaryArticle('Частые проблемы клиентов', `# Частые проблемы клиентов\n\n${FAQ_TEXT}`)).toBe(
      false,
    );
  });
  it('строки-определения без пометки «Термины» или «Глоссарий» сервер не трогает: решает модель', () => {
    expect(parseGlossaryText(UNMARKED_GLOSSARY)).toHaveLength(GLOSSARY_TEXT_TERMS);
    expect(extractDefinitions(UNMARKED_GLOSSARY)).toBeNull();
    expect(autoGlossary(UNMARKED_GLOSSARY)).toBeNull();
  });
  it('словарь без заголовка статьёй не сохраняется: и под названием «Термины VPN», и «Основные понятия»', () => {
    expect(isGlossaryArticle('Термины VPN', UNMARKED_GLOSSARY)).toBe(true);
    expect(isGlossaryArticle('Основные понятия', UNMARKED_GLOSSARY)).toBe(true);
  });
  it('явный словарь работает как раньше: первая строка, заголовок Markdown или таблица терминов', () => {
    expect(autoGlossary(GLOSSARY_TEXT)).toEqual({
      terms: parseGlossaryText(GLOSSARY_TEXT),
      rejected: [],
      pure: true,
    });
    expect(autoGlossary(GLOSSARY_TEXT)?.terms).toHaveLength(GLOSSARY_TEXT_TERMS);
    expect(isPureGlossary(`## Глоссарий\n${UNMARKED_GLOSSARY}`)).toBe(true);
    expect(isPureGlossary(`**Словарь VPN**\n${UNMARKED_GLOSSARY}`)).toBe(true);
    const table = [
      '| Термин | Простыми словами |',
      '| --- | --- |',
      ...parseGlossaryText(GLOSSARY_TEXT).map((t) => `| ${t.term} | ${t.explain} |`),
    ].join('\n');
    expect(autoGlossary(table)?.terms).toHaveLength(GLOSSARY_TEXT_TERMS);
    expect(autoGlossary(table)?.pure).toBe(true);
    // Таблица не про термины («Симптом | Что делать») пометкой словаря не считается.
    const faqTable = ['| Симптом | Что делать |', '| --- | --- |', ...FAQ_TEXT.split('\n').slice(1)]
      .map((l) => (l.startsWith('|') ? l : `| ${l.replace(': ', ' | ')} |`))
      .join('\n');
    expect(autoGlossary(faqTable)).toBeNull();
  });
  it('раздел «Термины» внутри статьи: сервер берёт только его, «проблема: решение» рядом не трогает', () => {
    const terms = GLOSSARY_TEXT.split('\n').slice(8, 20).join('\n');
    const guide = `# Установка ноды\n\nСначала подготовьте сервер и откройте порт 443.\n\n## Частые проблемы\n${FAQ_TEXT.split('\n').slice(1).join('\n')}\n\n## Термины\n${terms}\n\n## Что дальше\nНе подключается после установки: проверьте, что нода видна в панели Remnawave.`;
    const found = autoGlossary(guide);
    expect(found?.pure).toBe(false);
    const names = found?.terms.map((t) => t.term) ?? [];
    expect(names).toEqual(parseGlossaryText(terms).map((t) => t.term));
    expect(names.join('|')).not.toMatch(/Не подключается|Медленно работает|Высокий пинг/);
  });
  it('вопрос в сообщении: даже явный словарь разбирает модель', () => {
    for (const text of [
      `Что думаете, всё ли тут верно?\n\n${GLOSSARY_TEXT}`,
      `${GLOSSARY_TEXT}\n\nЧего тут не хватает?`,
      `${GLOSSARY_TEXT}\nЧто с этим делать? Хочу понять, всё ли нужно.`,
    ]) {
      expect(asksQuestion(text), text.slice(0, 40)).toBe(true);
      expect(autoGlossary(text), text.slice(0, 40)).toBeNull();
    }
    expect(asksQuestion(LSCPU_QUESTION)).toBe(true);
    // «Не нашли термин? Напишите в чат…» в конце словаря владельца — подпись страницы, а не вопрос Джарвису.
    expect(asksQuestion(GLOSSARY_TEXT)).toBe(false);
    expect(asksQuestion(`Добавь термины в глоссарий:\n${UNMARKED_GLOSSARY}`)).toBe(false);
    expect(asksQuestion('```bash\ngrep "?" /etc/hosts\n```')).toBe(false);
  });
});

/** Пункты «проблема: решение» без заголовка страницы. */
const FAQ_ITEMS = FAQ_TEXT.split('\n').slice(1).join('\n');

describe('пометка словаря, строки, которые сервер не взял, и подписи страниц', () => {
  it('словарь статьёй не сохраняется и под нейтральным названием, частые проблемы клиентов — сохраняются', () => {
    const list = parseGlossaryText(GLOSSARY_TEXT)
      .map((t) => `- **${t.term}** — ${t.explain}`)
      .join('\n');
    expect(isGlossaryArticle('Основы VPN', UNMARKED_GLOSSARY)).toBe(true);
    expect(isGlossaryArticle('Основы VPN', list)).toBe(true);
    expect(isGlossaryArticle('Азбука VPN', `# Азбука VPN\n${list}`)).toBe(true);
    expect(isGlossaryArticle('Частые проблемы клиентов', FAQ_TEXT)).toBe(false);
    expect(isGlossaryArticle('Частые проблемы клиентов', `# Частые проблемы клиентов\n\n${FAQ_ITEMS}`)).toBe(
      false,
    );
  });
  it('пункт «проблема: решение» — не определение: его объяснение начинается с совета «сделайте…»', () => {
    expect(parseGlossaryText(FAQ_TEXT)).toEqual([]);
    expect(
      parseTermLine('Отваливается через пару минут: смените порт на 443 и проверьте батарею'),
    ).toBeNull();
    expect(parseTermLine('- **Медленно** — попробуйте другой сервер из списка в приложении')).toBeNull();
    // Определения владельца так не начинаются; такое окончание в середине объяснения («задействуете») не мешает.
    expect(parseGlossaryText(GLOSSARY_TEXT)).toHaveLength(GLOSSARY_TEXT_TERMS);
  });
  it('строки словаря, которые сервер не взял, молча не пропадают: такой текст разбирает модель', () => {
    const text = `${GLOSSARY_TEXT}\n${MACHINE_LIKE_LINES.join('\n')}`;
    const auto = autoGlossary(text);
    expect(auto?.terms).toHaveLength(GLOSSARY_TEXT_TERMS);
    expect(auto?.rejected).toEqual(MACHINE_LIKE_TERMS);
    expect(auto?.pure).toBe(false);
    expect(isPureGlossary(text)).toBe(false);
    // Заголовки с коротким пояснением («Панель: что с чем связано») — не отброшенные определения.
    expect(autoGlossary(GLOSSARY_TEXT)?.rejected).toEqual([]);
  });
  it('определения вне помеченного раздела не теряются: такой текст — не «чистый словарь»', () => {
    const before = [
      'Мост: промежуточный сервер, через который трафик идёт дальше к выходу.',
      'Выход: сервер за границей, откуда трафик уходит в интернет.',
    ].join('\n');
    const auto = autoGlossary(`${before}\n## Глоссарий\n${UNMARKED_GLOSSARY}`);
    expect(auto?.terms).toHaveLength(GLOSSARY_TEXT_TERMS);
    expect(auto?.pure).toBe(false);
    expect(autoGlossary(`## Глоссарий\n${UNMARKED_GLOSSARY}`)?.pure).toBe(true);
  });
  it('пометка словаря — строка, которая со слова «Термины» или «Глоссарий» начинается, а не любое упоминание', () => {
    for (const first of [
      'Главная · Гайды · Термины · Дорожная карта',
      'Частые проблемы и термины',
      'Понятия не имею, что отвечать клиентам',
      '## Частые проблемы и термины',
    ]) {
      expect(autoGlossary(`${first}\n${UNMARKED_GLOSSARY}`), first).toBeNull();
      expect(autoGlossary(`${first}\n${FAQ_ITEMS}`), first).toBeNull();
    }
    for (const first of [
      'Термины',
      'Глоссарий VPN',
      'Словарь терминов',
      'Основные понятия',
      'Ключевые термины',
      '## 5. Термины',
      '**Глоссарий:**',
    ])
      expect(autoGlossary(`${first}\n${UNMARKED_GLOSSARY}`)?.pure, first).toBe(true);
  });
  it('под «Термины» больше строк, которые сервер не взял, чем терминов: пометке не верим, решает модель', () => {
    const eight = UNMARKED_GLOSSARY.split('\n')
      .filter((l) => parseTermLine(l))
      .slice(0, 8)
      .join('\n');
    expect(autoGlossary(`Термины\n${eight}`)?.terms).toHaveLength(8);
    expect(autoGlossary(`Термины\n${eight}\n${FAQ_ITEMS}`)).toBeNull();
    expect(autoGlossary(`Термины\n${FAQ_ITEMS}`)).toBeNull();
  });
  it('подпись страницы «Остались вопросы?» отдельной строкой — не вопрос Джарвису', () => {
    for (const footer of [
      'Остались вопросы?',
      'Не нашли термин?',
      'Есть вопросы?',
      'Нужна помощь?',
      '**Остались вопросы?**',
    ]) {
      const text = `${GLOSSARY_TEXT}\n${footer}`;
      expect(asksQuestion(text), footer).toBe(false);
      expect(autoGlossary(text)?.pure, footer).toBe(true);
    }
    // Вопрос владельца после словаря — по-прежнему вопрос, отвечает модель.
    for (const q of ['Всё верно?', 'Чего тут не хватает?', 'Не нашли термин? Что с этим делать?'])
      expect(asksQuestion(`${GLOSSARY_TEXT}\n${q}`), q).toBe(true);
  });
  it('заголовок словаря может стоять второй или третьей строкой: под просьбой или меню сайта', () => {
    for (const pre of ['Добавь в пояснения:', 'Главная / Гайды', 'Главная\nГайды'])
      expect(autoGlossary(`${pre}\n${GLOSSARY_TEXT}`)?.pure, pre).toBe(true);
    // Просьба добавить термины сама служит пометкой; «Пояснения» — так глоссарий называется в панели.
    for (const ask of ['Добавь в пояснения:', 'Добавьте эти термины', 'Внеси в глоссарий:'])
      expect(autoGlossary(`${ask}\n${UNMARKED_GLOSSARY}`)?.pure, ask).toBe(true);
    // Ниже третьей строки или после определений заголовок пометкой не считается: решает модель.
    expect(autoGlossary(`Главная\nГайды\nТарифы\n${GLOSSARY_TEXT}`)).toBeNull();
    expect(
      autoGlossary(`Мост: промежуточный сервер, через который трафик идёт дальше.\n${GLOSSARY_TEXT}`),
    ).toBeNull();
  });
});

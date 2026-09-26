import { describe, expect, it } from 'vitest';

import { GLOSSARY_TEXT, GLOSSARY_TEXT_TERMS } from './glossary-import.fixture.js';
import {
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

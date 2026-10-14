import { z } from 'zod';

/**
 * Понятные русские тексты ошибок проверки для полей, у схем которых нет своего сообщения. Без них zod пишет
 * по-английски («Too big: expected number to be <=65535»), а его встроенная русская локаль — техническими словами
 * («ожидалось, что number будет <=65535»). Свои сообщения схем (`.min(1, 'Введите название')`) важнее этих.
 * Подключается при загрузке пакета — одинаково в браузере и на сервере.
 */

/** Родительный падеж после «не больше / не длиннее N»: 1 символа, 2 символов, 5 символов, 21 символа. */
const genitive = (n: number, one: string, many: string): string =>
  Math.abs(n) % 10 === 1 && Math.abs(n) % 100 !== 11 ? one : many;

const FORMATS: Record<string, string> = {
  url: 'Неверный адрес: нужен вид https://example.com',
  email: 'Неверный адрес почты',
  uuid: 'Неверный идентификатор',
  guid: 'Неверный идентификатор',
  ipv4: 'Неверный IPv4-адрес',
  ipv6: 'Неверный IPv6-адрес',
  cidrv4: 'Неверная подсеть IPv4',
  cidrv6: 'Неверная подсеть IPv6',
  datetime: 'Неверные дата и время',
  date: 'Неверная дата',
  time: 'Неверное время',
  starts_with: 'Неверное начало значения',
  ends_with: 'Неверный конец значения',
  includes: 'Не хватает обязательной части',
};

const NUMBER_ORIGINS = new Set(['number', 'int', 'bigint']);
const LIST_ORIGINS = new Set(['array', 'set', 'map']);

export const zodRuError: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined || issue.input === null || issue.input === '') return 'Заполните поле';
      if (issue.expected === 'number' || issue.expected === 'int' || issue.expected === 'bigint')
        return 'Введите число';
      if (issue.expected === 'boolean') return 'Выберите «да» или «нет»';
      if (issue.expected === 'date') return 'Неверная дата';
      return 'Неверное значение';
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return `Не длиннее ${max} ${genitive(max, 'символа', 'символов')}`;
      if (LIST_ORIGINS.has(issue.origin)) return `Не больше ${max} ${genitive(max, 'элемента', 'элементов')}`;
      if (NUMBER_ORIGINS.has(issue.origin)) return issue.inclusive ? `Не больше ${max}` : `Меньше ${max}`;
      if (issue.origin === 'date') return 'Слишком поздняя дата';
      if (issue.origin === 'file') return 'Файл слишком большой';
      return 'Слишком большое значение';
    }
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string')
        return min <= 1 ? 'Заполните поле' : `Не короче ${min} ${genitive(min, 'символа', 'символов')}`;
      if (LIST_ORIGINS.has(issue.origin))
        return min <= 1
          ? 'Выберите хотя бы один вариант'
          : `Не меньше ${min} ${genitive(min, 'элемента', 'элементов')}`;
      if (NUMBER_ORIGINS.has(issue.origin)) return issue.inclusive ? `Не меньше ${min}` : `Больше ${min}`;
      if (issue.origin === 'date') return 'Слишком ранняя дата';
      return 'Слишком маленькое значение';
    }
    case 'invalid_format':
      return FORMATS[issue.format] ?? 'Неверный формат';
    case 'not_multiple_of':
      return `Должно делиться на ${issue.divisor}`;
    case 'invalid_value':
      return issue.values.length > 1 ? 'Выберите один из вариантов' : 'Неверное значение';
    case 'unrecognized_keys':
      return `Лишние поля: ${issue.keys.join(', ')}`;
    default:
      return 'Неверное значение';
  }
};

z.config({ localeError: zodRuError });

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Маскирование до отправки модели: ключи, пароли, токены, длинные секретоподобные строки, uuid, адреса и почта.
 * Возвращает и число замен, чтобы показать администратору, что что-то было скрыто. Порядок правил важен.
 */
export function maskSecrets(
  input: string,
  options: { privateData?: boolean } = {},
): { text: string; count: number } {
  let count = 0;
  const hit = (replacement: string) => () => {
    count += 1;
    return replacement;
  };
  let t = input;
  // Приватные ключи целиком; оборванный блок (вывод обрезан) скрываем до конца текста.
  t = t.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    hit('[приватный ключ скрыт]'),
  );
  // Пароль иногда по ошибке вводят как команду; это правило должно идти до общего «ключ: значение».
  t = t.replace(/^(\s*)[^:\s]{6,}(: command not found\s*)$/gim, (_m, indent: string, tail: string) => {
    count += 1;
    return `${indent}[скрыто]${tail}`;
  });
  // «password=…», «"token": "…"», «api_key: …»: имя поля с секретным словом и любое значение.
  t = t.replace(
    /([A-Za-z0-9_.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|psk)s?)(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    (_m, k: string, sep: string) => {
      count += 1;
      return `${k}${sep}[скрыто]`;
    },
  );
  // Заголовки и флаги командной строки.
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, (_m, kind: string) => {
    count += 1;
    return `${kind} [скрыто]`;
  });
  t = t.replace(/(--(?:pass(?:word)?|token|secret|api-key|key)\b[= ]+)\S+/gi, (_m, flag: string) => {
    count += 1;
    return `${flag}[скрыто]`;
  });
  // DATABASE_URL и похожие URI: скрываем только пароль, оставляя протокол, пользователя и адрес полезными.
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, (_m, prefix: string) => {
    count += 1;
    return `${prefix}[скрыто]@`;
  });
  // Распространённые формы пароля в командах, которые не выглядят как --password.
  t = t.replace(
    /(\bcurl\b[^\n]*?(?:\s-u|\s--user)\s+)([^:\s]+):\S+/gi,
    (_m, prefix: string, user: string) => {
      count += 1;
      return `${prefix}${user}:[скрыто]`;
    },
  );
  t = t.replace(/(\bmysql\b[^\n]*?\s-p)(\s*)(?!-)(\S+)/gi, (_m, prefix: string, gap: string) => {
    count += 1;
    return `${prefix}${gap}[скрыто]`;
  });
  t = t.replace(/(\bsshpass\b[^\n]*?\s-p\s+)\S+/gi, (_m, prefix: string) => {
    count += 1;
    return `${prefix}[скрыто]`;
  });
  t = t.replace(
    /(\becho\s+(?:-n\s+)?)(\S+)(\s*\|\s*sudo\s+-S\b)/gi,
    (_m, prefix: string, _secret: string, tail: string) => {
      count += 1;
      return `${prefix}[скрыто]${tail}`;
    },
  );
  // Идентификаторы пользователей VLESS и подобное.
  if (options.privateData !== false)
    t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, hit('[uuid]'));
  // Длинные строки из base64/hex: ключи Reality, хэши, токены.
  t = t.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, hit('[длинная строка скрыта]'));
  if (options.privateData !== false) {
    // Адреса: публичный IPv4 до подсети, IPv6 целиком, почта.
    t = t.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\b/g, (m, net: string) => {
      if (PRIVATE_IPV4.test(m)) return m;
      count += 1;
      return `${net}.x`;
    });
    t = t.replace(/\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{0,4}\b/g, hit('[ipv6 скрыт]'));
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, hit('[email]'));
  }
  return { text: t, count };
}

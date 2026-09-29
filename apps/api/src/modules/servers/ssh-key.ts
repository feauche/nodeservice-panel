import { utils } from 'ssh2';

/**
 * Приватный ключ, вставленный руками, часто приходит испорченным: с отступами (из заметок и мессенджеров),
 * склеенным в одну строку, с окончаниями строк Windows. ssh2 такой не читает. Собираем обратно:
 * заголовок, служебные строки (Proc-Type / DEK-Info у PEM с паролем), пустая строка, тело по 64 знака.
 */
export function normalizePrivateKey(raw: string): string {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  const m = /^(-----BEGIN ([A-Z0-9 ]+)-----)([\s\S]*?)(-----END \2-----)$/.exec(text);
  if (!m) {
    // Не PEM — только убираем отступы у строк.
    return `${text
      .split('\n')
      .map((l) => l.trim())
      .join('\n')}\n`;
  }
  const [, begin, , middle = '', end] = m;
  const tokens = middle.split(/\s+/).filter(Boolean);
  const headers: string[] = [];
  const body: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    // «Proc-Type: 4,ENCRYPTED», «DEK-Info: AES-128-CBC,…» — имя с двоеточием и значение следующим словом.
    if (/^[A-Za-z-]+:$/.test(t) && i + 1 < tokens.length) {
      headers.push(`${t} ${tokens[i + 1]}`);
      i += 1;
    } else body.push(t);
  }
  const b64 = body.join('');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `${[begin, ...headers, ...(headers.length ? [''] : []), ...lines, end].join('\n')}\n`;
}

/** Причина, по которой ключ не читается, — по-русски; null — ключ в порядке. */
export function privateKeyProblem(key: string, passphrase?: string): string | null {
  const parsed = utils.parseKey(key, passphrase);
  if (!(parsed instanceof Error)) return null;
  const msg = parsed.message;
  const encrypted = /Proc-Type: 4,ENCRYPTED/.test(key) || /passphrase/i.test(msg);
  if (/no passphrase given/i.test(msg) || (encrypted && !passphrase))
    return 'Ключ защищён паролем — введите его в поле «Пароль от ключа».';
  if (/bad passphrase|decrypt|passphrase/i.test(msg) || (encrypted && passphrase))
    return 'Пароль ключа не подошёл.';
  return 'Ключ не читается: вставьте его целиком, вместе со строками «-----BEGIN …-----» и «-----END …-----». Подходят форматы OpenSSH и PEM, в том числе «BEGIN RSA PRIVATE KEY».';
}

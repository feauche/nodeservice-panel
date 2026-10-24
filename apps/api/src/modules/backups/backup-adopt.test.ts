import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import { reencryptText } from './backup-adopt.js';

const crypto = (key: string, version = 1) => {
  const values: Record<string, unknown> = {
    ENCRYPTION_KEY: key,
    ENCRYPTION_KEY_VERSION: version,
    APP_SECRET: 'x'.repeat(64),
  };
  return new CryptoService({ get: (k: string) => values[k] } as unknown as ConfigService<Env, true>);
};

describe('перешифровка данных копии другой установки', () => {
  const old = crypto('ab'.repeat(32));
  const mine = crypto('cd'.repeat(32));

  it('шифротекст целиком в поле — ключом этой панели', () => {
    const r = reencryptText(old.encrypt('секрет Remnawave'), old, mine);
    expect(r).toMatchObject({ reencrypted: 1, unreadable: 0 });
    expect(mine.decrypt(r.text)).toBe('секрет Remnawave');
    expect(() => old.decrypt(r.text)).toThrow();
  });

  it('несколько шифротекстов внутри настроек: каждый перешифрован, остальное не тронуто', () => {
    const settings = JSON.stringify({
      baseUrl: 'https://panel.example.com',
      apiKeyEnc: old.encrypt('ключ'),
      destinations: [{ name: 'чат', tokenEnc: old.encrypt('токен'), note: 'v1:не шифротекст' }],
      empty: old.encrypt(''),
    });
    const r = reencryptText(settings, old, mine);
    expect(r).toMatchObject({ reencrypted: 2, unreadable: 0 });
    const back = JSON.parse(r.text);
    expect(back.baseUrl).toBe('https://panel.example.com');
    expect(mine.decrypt(back.apiKeyEnc)).toBe('ключ');
    expect(mine.decrypt(back.destinations[0].tokenEnc)).toBe('токен');
    expect(back.destinations[0].note).toBe('v1:не шифротекст');
    // Пустую строку панель и сама не расшифровывает — значение остаётся как было.
    expect(back.empty).toBe(JSON.parse(settings).empty);
  });

  it('шифротекст, который ключ копии не читает, остаётся как был и считается', () => {
    const stranger = crypto('ef'.repeat(32)).encrypt('чужое');
    const r = reencryptText(`${stranger}`, old, mine);
    expect(r).toEqual({ text: stranger, reencrypted: 0, unreadable: 1 });
  });

  it('похожее на шифротекст внутри другого слова не трогается', () => {
    const inside = `id${old.encrypt('a')}`;
    expect(reencryptText(inside, old, mine)).toEqual({ text: inside, reencrypted: 0, unreadable: 0 });
  });

  it('версия ключа копии сохраняется в расшифровке, новая запись — с версией этой панели', () => {
    const v2 = crypto('ab'.repeat(32), 2);
    const r = reencryptText(v2.encrypt('s'), v2, mine);
    expect(r.text.startsWith('v1:')).toBe(true);
    expect(mine.decrypt(r.text)).toBe('s');
  });
});

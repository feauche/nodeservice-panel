import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema.js';

const valid = {
  APP_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: 'a'.repeat(64),
};

describe('validateEnv', () => {
  it('подставляет значения по умолчанию', () => {
    const env = validateEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it('приводит строки к числам', () => {
    const env = validateEnv({ ...valid, PORT: '8080', TRUST_PROXY: '0' });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(0);
  });

  it('падает с понятным списком проблем', () => {
    expect(() => validateEnv({ ENCRYPTION_KEY: 'short' })).toThrowError(/APP_SECRET/);
    expect(() => validateEnv({ ENCRYPTION_KEY: 'short' })).toThrowError(/ENCRYPTION_KEY: ожидается 64 hex/);
  });

  it('не принимает кривые URL и порт вне диапазона', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'not a url' })).toThrow();
    expect(() => validateEnv({ ...valid, PORT: '70000' })).toThrow();
    expect(() => validateEnv({ ...valid, AGENT_PUBLIC_URL: 'not a url' })).toThrow();
    expect(() => validateEnv({ ...valid, AGENT_FALLBACK_URLS: 'https://one.test,not-a-url' })).toThrow();
    expect(() =>
      validateEnv({
        ...valid,
        AGENT_FALLBACK_URLS: 'https://1.test,https://2.test,https://3.test,https://4.test',
      }),
    ).toThrow(/не больше трёх/);
  });

  it('принимает отдельный внешний адрес агентов', () => {
    expect(validateEnv({ ...valid, AGENT_PUBLIC_URL: 'https://agents.example.net' }).AGENT_PUBLIC_URL).toBe(
      'https://agents.example.net',
    );
  });

  it('разбирает запасные адреса, убирает пробелы и повторы', () => {
    expect(
      validateEnv({
        ...valid,
        AGENT_FALLBACK_URLS: ' https://one.test,https://two.test/, https://one.test ',
      }).AGENT_FALLBACK_URLS,
    ).toEqual(['https://one.test', 'https://two.test/']);
  });
});

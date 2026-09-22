import { describe, expect, it } from 'vitest';

import {
  createServerRequestSchema,
  hostSchema,
  sshAuthSchema,
  tagsSchema,
  updateServerRequestSchema,
} from './servers.js';

describe('servers contract', () => {
  it('host: IP и домен проходят, протокол и пробелы — нет', () => {
    expect(hostSchema.safeParse('203.0.113.7').success).toBe(true);
    expect(hostSchema.safeParse('node-1.example.com').success).toBe(true);
    expect(hostSchema.safeParse('https://x.com').success).toBe(false);
    expect(hostSchema.safeParse('a b').success).toBe(false);
  });
  it('auth: три способа, лишние поля не проходят', () => {
    expect(sshAuthSchema.safeParse({ method: 'password', password: 'x' }).success).toBe(true);
    expect(sshAuthSchema.safeParse({ method: 'key', privateKey: 'PEM' }).success).toBe(true);
    expect(sshAuthSchema.safeParse({ method: 'panel-key' }).success).toBe(true);
    expect(sshAuthSchema.safeParse({ method: 'password' }).success).toBe(false);
  });
  it('create: дефолты порта, тегов и installPanelKey', () => {
    const r = createServerRequestSchema.parse({
      name: 'de-fra-01',
      host: '203.0.113.7',
      sshUser: 'root',
      auth: { method: 'password', password: 'secret' },
    });
    expect(r).toMatchObject({ port: 22, tags: [], installPanelKey: true });
    expect(tagsSchema.safeParse(Array.from({ length: 11 }, (_, i) => `t${i}`)).success).toBe(false);
  });
  it('update: default не протекает — PATCH c одним полем не трогает порт и теги', () => {
    const r = updateServerRequestSchema.parse({ name: 'new-name' });
    expect(r).toEqual({ name: 'new-name' });
    expect('port' in r).toBe(false);
    expect('tags' in r).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { maskSecrets } from './mask-secrets.js';

describe('maskSecrets', () => {
  it('приватные ключи целиком и оборванные', () => {
    const full = maskSecrets(
      'a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\nZZZ\n-----END OPENSSH PRIVATE KEY-----\nb',
    );
    expect(full.text).toBe('a\n[приватный ключ скрыт]\nb');
    const cut = maskSecrets('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow');
    expect(cut.text).toBe('x\n[приватный ключ скрыт]');
    expect(full.count).toBe(1);
  });
  it('пароли в URI и типовых командах не уходят модели', () => {
    const cases: Array<[string, string]> = [
      [
        'DATABASE_URL=postgresql://postgres:S3cretPass@db:5432/app',
        'DATABASE_URL=postgresql://postgres:[скрыто]@db:5432/app',
      ],
      ['REDIS_URL=redis://:redisPass@cache:6379', 'REDIS_URL=redis://:[скрыто]@cache:6379'],
      ['curl -u admin:curlPass https://example.com', 'curl -u admin:[скрыто] https://example.com'],
      ['mysql -uroot -pMysqlPass db', 'mysql -uroot -p[скрыто] db'],
      ['mysql -u root -p MysqlPass db', 'mysql -u root -p [скрыто] db'],
      ['sshpass -p SshPass ssh root@host', 'sshpass -p [скрыто] ssh root@host'],
      ['echo SudoPass | sudo -S id', 'echo [скрыто] | sudo -S id'],
      ['Sup3rSecret: command not found', '[скрыто]: command not found'],
    ];
    for (const [input, expected] of cases) expect(maskSecrets(input).text, input).toBe(expected);
  });
  it('пароли, токены и ключи в разных записях', () => {
    const cases: Array<[string, string]> = [
      ['DB_PASSWORD=hunter2', 'DB_PASSWORD=[скрыто]'],
      ['"token": "abc123xyz"', '"token": [скрыто]'],
      ['api_key: sk-live-9999', 'api_key: [скрыто]'],
      ["secret='a b c'", 'secret=[скрыто]'],
      ['Authorization: Bearer eyJhbGciOi.payload.sig', 'Authorization: Bearer [скрыто]'],
      ['mysql --password=toor -u root', 'mysql --password=[скрыто] -u root'],
    ];
    for (const [input, expected] of cases) {
      const r = maskSecrets(input);
      expect(r.text, input).toBe(expected);
      expect(r.count, input).toBeGreaterThan(0);
    }
  });
  it('uuid, длинные ключи, публичные IP и почта; частные адреса остаются', () => {
    const r = maskSecrets(
      'id 3f6c1a2e-9b7d-4c1e-8a55-0123456789ab key 4fFEwQWYtKJ3yPqvnH6mXo2LdRz8aVbTcUeGiMhNsKw ip 203.0.113.77 lan 10.0.0.5 lo 127.0.0.1 me admin@example.com v6 2001:db8:1:2::9',
    );
    expect(r.text).toContain('[uuid]');
    expect(r.text).toContain('[длинная строка скрыта]');
    expect(r.text).toContain('203.0.113.x');
    expect(r.text).toContain('10.0.0.5');
    expect(r.text).toContain('127.0.0.1');
    expect(r.text).toContain('[email]');
    expect(r.text).toContain('[ipv6 скрыт]');
    expect(r.text).not.toContain('hunter');
    expect(r.text).not.toContain('203.0.113.77');
  });
  it('для истории терминала сохраняет адреса, но всё равно убирает секреты', () => {
    const r = maskSecrets('ip 203.0.113.77 email admin@example.com token=secret-value', {
      privateData: false,
    });
    expect(r.text).toBe('ip 203.0.113.77 email admin@example.com token=[скрыто]');
  });
  it('обычный вывод не портится', () => {
    const t =
      'Total: 84213\nTCP:   81102 (estab 79880)\n[812345.6] nf_conntrack: table full, dropping packet';
    expect(maskSecrets(t)).toEqual({ text: t, count: 0 });
  });
});

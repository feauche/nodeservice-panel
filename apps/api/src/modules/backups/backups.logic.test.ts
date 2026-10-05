import { describe, expect, it } from 'vitest';

import {
  backupName,
  envValues,
  installEnv,
  installEnvText,
  isBackupDue,
  keyFingerprint,
  nextBackupAt,
  telegramBackupParts,
  telegramMergeCommand,
  timeFromName,
  versionLess,
  willRetryBackup,
} from './backups.logic.js';

const omsk = 'Asia/Omsk';

describe('расписание копий', () => {
  it('каждый день в 04:00 по Омску', () => {
    const now = new Date('2026-09-29T20:00:00Z'); // 02:00 30 сентября по Омску
    expect(nextBackupAt(now, { frequency: 'day', weekday: 7, time: '04:00' }, omsk)).toEqual(
      new Date('2026-09-29T22:00:00Z'),
    );
  });

  it('раз в неделю — в выбранный день', () => {
    const now = new Date('2026-09-29T09:00:00Z'); // вторник
    expect(nextBackupAt(now, { frequency: 'week', weekday: 7, time: '04:00' }, omsk)).toEqual(
      new Date('2026-10-03T22:00:00Z'),
    );
  });

  it('пора: момент наступил и копии после него не было; через 6 часов — уже не догоняем', () => {
    const s = { auto: true, frequency: 'day' as const, weekday: 7, time: '04:00' };
    const slot = new Date('2026-09-29T22:00:00Z');
    expect(isBackupDue(new Date(slot.getTime() + 60_000), s, omsk, null)).toBe(true);
    expect(isBackupDue(new Date(slot.getTime() + 60_000), s, omsk, new Date(slot.getTime() + 30_000))).toBe(
      false,
    );
    expect(isBackupDue(new Date(slot.getTime() + 7 * 3_600_000), s, omsk, null)).toBe(false);
    expect(isBackupDue(new Date(slot.getTime() + 60_000), { ...s, auto: false }, omsk, null)).toBe(false);
  });

  it('неудачная попытка в 04:00 не повторяется в 04:01: повтор — через час, и только пока не вышли 6 часов', () => {
    const s = { auto: true, frequency: 'day' as const, weekday: 7, time: '04:00' };
    const slot = new Date('2026-09-29T22:00:00Z');
    const at = (min: number) => new Date(slot.getTime() + min * 60_000);
    // Попытка в 04:00 не дала копии (lastAutoAt — вчерашняя).
    const yesterday = new Date(slot.getTime() - 24 * 3_600_000);
    expect(isBackupDue(at(1), s, omsk, yesterday, at(0))).toBe(false);
    expect(isBackupDue(at(59), s, omsk, yesterday, at(0))).toBe(false);
    expect(isBackupDue(at(60), s, omsk, yesterday, at(0))).toBe(true);
    // Вторая попытка в 05:00 тоже не вышла — следующая в 06:00.
    expect(isBackupDue(at(61), s, omsk, yesterday, at(60))).toBe(false);
    expect(isBackupDue(at(120), s, omsk, yesterday, at(60))).toBe(true);
    // Через 6 часов после момента расписания больше не пробуем.
    expect(isBackupDue(at(6 * 60 + 1), s, omsk, yesterday, at(5 * 60))).toBe(false);
    // Попытка до этого момента расписания (вчерашняя) не мешает сегодняшней копии.
    expect(isBackupDue(at(0), s, omsk, yesterday, new Date(slot.getTime() - 23 * 3_600_000))).toBe(true);
    // Копия получилась — попытки больше не нужны.
    expect(isBackupDue(at(120), s, omsk, at(60), at(60))).toBe(false);
  });

  it('повтор обещаем, только если он уложится в шесть часов после момента расписания', () => {
    const slot = new Date('2026-09-29T22:00:00Z');
    const at = (min: number) => new Date(slot.getTime() + min * 60_000);
    expect(willRetryBackup(at(0), slot)).toBe(true);
    expect(willRetryBackup(at(4 * 60 + 58), slot)).toBe(true);
    // Следующая проверка расписания будет уже за границей шести часов.
    expect(willRetryBackup(at(5 * 60), slot)).toBe(false);
    expect(willRetryBackup(at(5 * 60 + 30), slot)).toBe(false);
  });

  it('имя файла как у консольного бэкапа и обратно', () => {
    const at = new Date('2026-09-29T04:00:07Z');
    expect(backupName(at, false)).toBe('nodeservice-backup-20260929-040007.tar.gz');
    expect(backupName(at, true)).toBe('nodeservice-backup-20260929-040007.tar.gz.enc');
    expect(timeFromName('nodeservice-backup-20260929-040007.tar.gz')).toEqual(at);
    expect(versionLess('0.38.1', '0.39.0')).toBe(true);
    expect(versionLess('0.39.0', '0.38.9')).toBe(false);
  });

  it('архив для Telegram делится на последовательные части по 49 МБ', () => {
    const name = 'nodeservice-backup-20261005-120001.tar.gz.enc';
    const mib = 1024 * 1024;
    const parts = telegramBackupParts(name, 60 * mib);
    expect(parts).toEqual([
      { name: `${name}.part-01-of-02`, start: 0, end: 49 * mib - 1, size: 49 * mib, number: 1, total: 2 },
      {
        name: `${name}.part-02-of-02`,
        start: 49 * mib,
        end: 60 * mib - 1,
        size: 11 * mib,
        number: 2,
        total: 2,
      },
    ]);
    expect(telegramMergeCommand(name)).toBe(`cat ${name}.part-* > ${name}`);
  });
});

describe('ключи установки в копии', () => {
  const keys = {
    ENCRYPTION_KEY: 'ab'.repeat(32),
    ENCRYPTION_KEY_VERSION: '1',
    APP_SECRET: 'cd'.repeat(32),
    PASSWORD_PEPPER: 'ef'.repeat(32),
  };
  const at = new Date('2026-09-29T22:00:07Z');

  it('значения берутся из настроек работающей панели: домен и пароль базы — из переменных установки', () => {
    const v = installEnv({
      keys,
      publicUrl: 'https://panel.example.com',
      databaseUrl: 'postgres://nodeservice:from-url@postgres:5432/nodeservice',
      env: {
        PANEL_DOMAIN: 'panel.example.com',
        ACME_EMAIL: 'admin@example.com',
        NODESERVICE_VERSION: 'abc1234',
        POSTGRES_PASSWORD: 'pg-secret',
      },
    });
    expect(v).toEqual({
      PANEL_DOMAIN: 'panel.example.com',
      ACME_EMAIL: 'admin@example.com',
      NODESERVICE_VERSION: 'abc1234',
      POSTGRES_PASSWORD: 'pg-secret',
      APP_SECRET: keys.APP_SECRET,
      ENCRYPTION_KEY: keys.ENCRYPTION_KEY,
      ENCRYPTION_KEY_VERSION: '1',
      PASSWORD_PEPPER: keys.PASSWORD_PEPPER,
    });
  });

  it('переменных установки нет — домен из адреса панели, пароль базы из адреса базы', () => {
    const v = installEnv({
      keys: { ...keys, ENCRYPTION_KEY_VERSION: '', PASSWORD_PEPPER: '' },
      publicUrl: 'https://panel.example.com',
      databaseUrl: 'postgres://nodeservice:p%40ss@postgres:5432/nodeservice',
      env: {},
    });
    expect(v.PANEL_DOMAIN).toBe('panel.example.com');
    expect(v.POSTGRES_PASSWORD).toBe('p@ss');
    // Версия ключа по умолчанию — 1: пустая строка в .env не дала бы панели запуститься.
    expect(v.ENCRYPTION_KEY_VERSION).toBe('1');
    expect(v.ACME_EMAIL).toBeUndefined();
    expect(v.PASSWORD_PEPPER).toBeUndefined();
  });

  it('файл env — строки КЛЮЧ=значение без кавычек, как их читает консольное восстановление', () => {
    const v = installEnv({
      keys,
      publicUrl: 'https://panel.example.com',
      databaseUrl: 'postgres://nodeservice:pg-secret@postgres:5432/nodeservice',
      env: { PANEL_DOMAIN: 'panel.example.com', ACME_EMAIL: 'admin@example.com' },
    });
    const { text, missing } = installEnvText(v, at);
    expect(missing).toEqual([]);
    expect(text.endsWith('\n')).toBe(true);
    // Так значение достают install.sh и restore.sh: grep '^КЛЮЧ=' | head -1 | cut -d= -f2-
    const shell = (key: string) =>
      text
        .split('\n')
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1);
    expect(shell('PANEL_DOMAIN')).toBe('panel.example.com');
    expect(shell('ACME_EMAIL')).toBe('admin@example.com');
    expect(shell('POSTGRES_PASSWORD')).toBe('pg-secret');
    expect(shell('APP_SECRET')).toBe(keys.APP_SECRET);
    expect(shell('ENCRYPTION_KEY')).toBe(keys.ENCRYPTION_KEY);
    expect(shell('ENCRYPTION_KEY_VERSION')).toBe('1');
    expect(shell('PASSWORD_PEPPER')).toBe(keys.PASSWORD_PEPPER);
    // И так же их читает сама панель при проверке архива.
    expect(envValues(text)).toMatchObject({
      ENCRYPTION_KEY: keys.ENCRYPTION_KEY,
      PANEL_DOMAIN: 'panel.example.com',
    });
    // Кроме строк КЛЮЧ=значение — только пояснения: install.sh переносит «прочие» строки в новый .env как есть.
    const other = text.split('\n').filter((l) => l && !l.startsWith('#') && !/^[A-Z_]+=/.test(l));
    expect(other).toEqual([]);
  });

  it('нет ключа шифрования, секрета панели или пароля базы — копия без них не считается полной', () => {
    expect(installEnvText({ ...keys, ENCRYPTION_KEY: '' }, at).missing).toEqual([
      'POSTGRES_PASSWORD',
      'ENCRYPTION_KEY',
    ]);
    expect(
      installEnvText({ POSTGRES_PASSWORD: 'x', APP_SECRET: '', ENCRYPTION_KEY: keys.ENCRYPTION_KEY }, at)
        .missing,
    ).toEqual(['APP_SECRET']);
    // Значение с переводом строки сломало бы файл — такое в него не пишется и считается отсутствующим.
    const broken = installEnvText(
      { ...keys, POSTGRES_PASSWORD: 'x', APP_SECRET: 'a\nENCRYPTION_KEY=подмена' },
      at,
    );
    expect(broken.missing).toEqual(['APP_SECRET']);
    expect(broken.text).not.toContain('подмена');
  });

  it('отпечаток ключа: одинаковый для одного ключа в любом регистре, сам ключ из него не виден', () => {
    const print = keyFingerprint(keys.ENCRYPTION_KEY);
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(print).not.toContain(keys.ENCRYPTION_KEY.slice(0, 16));
    expect(keyFingerprint(keys.ENCRYPTION_KEY.toUpperCase())).toBe(print);
    expect(keyFingerprint('12'.repeat(32))).not.toBe(print);
    expect(keyFingerprint('')).toBe('');
  });
});

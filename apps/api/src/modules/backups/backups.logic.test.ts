import { describe, expect, it } from 'vitest';

import { backupName, isBackupDue, nextBackupAt, timeFromName, versionLess } from './backups.logic.js';

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

  it('имя файла как у консольного бэкапа и обратно', () => {
    const at = new Date('2026-09-29T04:00:07Z');
    expect(backupName(at, false)).toBe('nodeservice-backup-20260929-040007.tar.gz');
    expect(backupName(at, true)).toBe('nodeservice-backup-20260929-040007.tar.gz.enc');
    expect(timeFromName('nodeservice-backup-20260929-040007.tar.gz')).toEqual(at);
    expect(versionLess('0.38.1', '0.39.0')).toBe(true);
    expect(versionLess('0.39.0', '0.38.9')).toBe(false);
  });
});

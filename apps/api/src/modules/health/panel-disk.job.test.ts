import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { PanelDiskJob } from './panel-disk.job.js';

const GB = 1024 ** 3;
const BSIZE = 4096;

/** Раздел как его отдаёт statfs: свободно и всего — в блоках по 4 КБ. */
const disk = (freeGb: number, totalGb: number) => ({
  bsize: BSIZE,
  bavail: Math.round((freeGb * GB) / BSIZE),
  blocks: Math.round((totalGb * GB) / BSIZE),
});

function make(disks: Record<string, ReturnType<typeof disk> | Error>, hostRoot = '') {
  const alerts: Array<{ freeBytes: number; totalBytes: number }> = [];
  const asked: string[] = [];
  const job = new PanelDiskJob(
    {
      get: (k: string) => (k === 'BACKUPS_DIR' ? '/data/backups' : k === 'HOST_ROOT' ? hostRoot : undefined),
    } as never,
    {
      diskLow: async (d: { freeBytes: number; totalBytes: number }) => {
        alerts.push(d);
      },
    } as never,
  );
  job.statfs = async (path: string) => {
    asked.push(path);
    const d = disks[path];
    if (!d || d instanceof Error) throw d ?? new Error(`ENOENT: ${path}`);
    return d;
  };
  return { job, alerts, asked };
}

const BACKUPS = resolve('/data/backups');

describe('место на разделе данных сервера панели', () => {
  it('места достаточно — молчим', async () => {
    const { job, alerts } = make({ [BACKUPS]: disk(12, 80) });
    await job.check();
    expect(alerts).toHaveLength(0);
  });

  it('свободно меньше 10 % — оповещение, сколько свободно', async () => {
    const { job, alerts } = make({ [BACKUPS]: disk(7, 100) });
    await job.check();
    expect(alerts).toEqual([{ freeBytes: 7 * GB, totalBytes: 100 * GB }]);
  });

  it('свободно меньше 2 ГБ, хотя это больше 10 % маленького диска, — тоже оповещение', async () => {
    const { job, alerts } = make({ [BACKUPS]: disk(1.5, 10) });
    await job.check();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.freeBytes).toBe(1.5 * GB);
  });

  it('не удалось посмотреть — ничего не утверждаем', async () => {
    const { job, alerts } = make({ [BACKUPS]: new Error('EACCES') });
    await job.check();
    expect(alerts).toHaveLength(0);
  });

  it('первая проверка — через минуту после запуска, а не через 10: панель, которая падает от нехватки места, столько не живёт', async () => {
    const env = process.env.NODE_ENV;
    vi.useFakeTimers();
    try {
      process.env.NODE_ENV = 'production';
      const { job, alerts } = make({ [BACKUPS]: disk(1, 50) });
      job.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(alerts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(alerts).toHaveLength(1);
    } finally {
      process.env.NODE_ENV = env;
      vi.useRealTimers();
    }
  });

  it('в контейнере смотрим и раздел с данными Docker (база, метрики, образы): мало места там — оповещение о нём', async () => {
    const docker = resolve('/host/var/lib/docker');
    const { job, alerts, asked } = make({ [BACKUPS]: disk(30, 80), [docker]: disk(3, 120) }, '/host');
    await job.check();
    expect(asked.sort()).toEqual([BACKUPS, docker].sort());
    expect(alerts).toEqual([{ freeBytes: 3 * GB, totalBytes: 120 * GB }]);
  });
});

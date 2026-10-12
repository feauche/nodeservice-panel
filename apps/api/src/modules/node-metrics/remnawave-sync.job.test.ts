import { MONITORING_DEFAULTS } from '@nodeservice/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemnawaveSyncJob } from './remnawave-sync.job.js';

describe('RemnawaveSyncJob', () => {
  const prevEnv = process.env.NODE_ENV;

  it('в тестовом окружении не тикает', async () => {
    process.env.NODE_ENV = 'test';
    const syncQuiet = vi.fn();
    await new RemnawaveSyncJob(
      { syncQuiet } as never,
      { get: async () => MONITORING_DEFAULTS } as never,
    ).tick();
    expect(syncQuiet).not.toHaveBeenCalled();
    process.env.NODE_ENV = prevEnv;
  });

  it('вне теста зовёт syncQuiet и не запускает второй тик, пока первый не закончился', async () => {
    process.env.NODE_ENV = 'development';
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    let calls = 0;
    const syncQuiet = vi.fn(async () => {
      calls += 1;
      await gate;
    });
    const job = new RemnawaveSyncJob(
      { syncQuiet } as never,
      { get: async () => MONITORING_DEFAULTS } as never,
    );
    const first = job.tick();
    await job.tick();
    await Promise.resolve();
    expect(calls).toBe(1);
    resolve();
    await first;
    process.env.NODE_ENV = prevEnv;
  });
});

describe('расписание без дрейфа', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = previous;
  });
  const setup = () => {
    process.env.NODE_ENV = 'development';
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cfg = { ...MONITORING_DEFAULTS, enabled: true, pollSeconds: 60 };
    const starts: number[] = [];
    const syncQuiet = vi.fn(async () => {
      starts.push(Date.now());
      vi.setSystemTime(Date.now() + 2000);
    });
    const collect = vi.fn(async () => undefined);
    const job = new RemnawaveSyncJob(
      { syncQuiet } as never,
      { get: async () => cfg } as never,
      { collect } as never,
    );
    return { job, starts, cfg, syncQuiet, collect };
  };
  it('запрос 2 секунды не превращает интервал 60 в 70; сохраняет замер сразу', async () => {
    const { job, starts, collect } = setup();
    for (let t = 0; t <= 420000; t += 10000) {
      vi.setSystemTime(t);
      await job.tick();
    }
    expect(starts).toEqual([0, 60000, 120000, 180000, 240000, 300000, 360000, 420000]);
    expect(collect).toHaveBeenCalledTimes(8);
  });
  it('опоздание таймера не накапливается', async () => {
    const { job, starts } = setup();
    for (const t of [0, 60015, 120002, 180001]) {
      vi.setSystemTime(t);
      await job.tick();
    }
    expect(starts).toHaveLength(4);
  });
  it('не догоняет долгий простой пачкой, изменение интервала учитывается', async () => {
    const { job, starts, cfg } = setup();
    await job.tick();
    vi.setSystemTime(300000);
    await job.tick();
    await job.tick();
    expect(starts).toEqual([0, 300000]);
    cfg.pollSeconds = 30;
    vi.setSystemTime(330000);
    await job.tick();
    expect(starts.at(-1)).toBe(330000);
  });
  it('после ошибки не повторяет запрос каждую секунду', async () => {
    const { job, syncQuiet, collect } = setup();
    syncQuiet.mockRejectedValueOnce(new Error('upstream'));
    await expect(job.tick()).rejects.toThrow('upstream');
    vi.setSystemTime(1000);
    await job.tick();
    expect(syncQuiet).toHaveBeenCalledTimes(1);
    expect(collect).not.toHaveBeenCalled();
    vi.setSystemTime(60000);
    await job.tick();
    expect(syncQuiet).toHaveBeenCalledTimes(2);
  });
  it('после отключения и включения проверяет сразу', async () => {
    const { job, cfg, starts } = setup();
    await job.tick();
    cfg.enabled = false;
    vi.setSystemTime(10000);
    await job.tick();
    cfg.enabled = true;
    await job.tick();
    expect(starts).toEqual([0, 10000]);
  });
});

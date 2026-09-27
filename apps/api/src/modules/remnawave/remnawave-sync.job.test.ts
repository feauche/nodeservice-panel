import { describe, expect, it, vi } from 'vitest';

import { RemnawaveSyncJob } from './remnawave-sync.job.js';

describe('RemnawaveSyncJob', () => {
  const prevEnv = process.env.NODE_ENV;

  it('в тестовом окружении не тикает', async () => {
    process.env.NODE_ENV = 'test';
    const syncQuiet = vi.fn();
    await new RemnawaveSyncJob({ syncQuiet } as never).tick();
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
    const job = new RemnawaveSyncJob({ syncQuiet } as never);
    const first = job.tick();
    await job.tick();
    expect(calls).toBe(1);
    resolve();
    await first;
    process.env.NODE_ENV = prevEnv;
  });
});

import { describe, expect, it } from 'vitest';

import { PanelPulse } from '../health/panel-pulse.js';
import { IncidentsJob } from './incidents.job.js';

/** Задача поиска инцидентов с подставными серверами и правилами; отметка живости — настоящая. */
function make(opts: { servers?: string[]; evaluate?: () => Promise<void> } = {}) {
  const pulse = new PanelPulse();
  pulse.startedAt = Date.now() - 10 * 60_000;
  let evaluated = 0;
  const job = new IncidentsJob(
    {
      evaluate: async () => {
        evaluated += 1;
        await opts.evaluate?.();
      },
    } as never,
    { latest: async () => ({ cpu: new Map(), mem: new Map(), disk: new Map() }) } as never,
    { list: async () => (opts.servers ?? ['s1']).map((id) => ({ id })) } as never,
    pulse,
  );
  return { job, pulse, evaluated: () => evaluated };
}

describe('поиск инцидентов: отметка удачного прохода для /api/health/ready', () => {
  it('проход удался — отметка свежая', async () => {
    const { job, pulse, evaluated } = make();
    expect(pulse.incidentsSilentMs()).toBeGreaterThan(9 * 60_000);
    await job.run();
    expect(evaluated()).toBe(1);
    expect(pulse.incidentsSilentMs()).toBeLessThan(1_000);
  });

  it('серверов нет — проверять нечего, но задача работает: отметка ставится', async () => {
    const { job, pulse, evaluated } = make({ servers: [] });
    await job.run();
    expect(evaluated()).toBe(0);
    expect(pulse.incidentsSilentMs()).toBeLessThan(1_000);
  });

  it('проход упал — отметка не обновляется, ошибка наружу не вылетает', async () => {
    const { job, pulse } = make({
      evaluate: async () => {
        throw new Error('база не отвечает');
      },
    });
    await expect(job.run()).resolves.toBeUndefined();
    expect(pulse.incidentsSilentMs()).toBeGreaterThan(9 * 60_000);
  });

  it('прошлый проход завис — новые не запускаются и отметку не ставят: готовность это заметит', async () => {
    let release: () => void = () => undefined;
    const { job, pulse, evaluated } = make({
      evaluate: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const first = job.run();
    await new Promise((r) => setTimeout(r, 0));
    await job.run();
    expect(evaluated()).toBe(1);
    expect(pulse.incidentsSilentMs()).toBeGreaterThan(9 * 60_000);
    release();
    await first;
    expect(pulse.incidentsSilentMs()).toBeLessThan(1_000);
  });
});

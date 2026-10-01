import type { AgentMetrics } from '@nodeservice/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { METRICS_DOWN_AFTER_MS, VmWriterService } from './vm.service.js';

const METRICS: AgentMetrics = {
  cpuPct: 12,
  load1: 0.4,
  memUsedMb: 900,
  memTotalMb: 2000,
  diskUsedMb: 10_000,
  diskTotalMb: 40_000,
  netRxBps: 1000,
  netTxBps: 2000,
  netRxPps: 10,
  netTxPps: 20,
  uptimeSec: 3600,
  conntrackCount: null,
} as AgentMetrics;

const T0 = new Date('2026-10-01T00:00:00Z').getTime();

/** Писатель метрик с подменённой VictoriaMetrics: `vm.ok` — принимает ли она запись. */
function make() {
  const vm = { ok: true, status: 204 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (!vm.ok) throw new TypeError('fetch failed');
    return new Response(null, { status: vm.status });
  });
  const down: Date[] = [];
  let up = 0;
  const svc = new VmWriterService(
    { get: () => 'http://vm.test:8428' } as never,
    {
      metricsDown: async (since: Date) => {
        down.push(since);
      },
      metricsUp: async () => {
        up += 1;
      },
      quietly: (_what: string, run: () => Promise<void>) => {
        void run();
      },
    } as never,
  );
  /** Одна запись в момент `min` минут от начала. */
  const write = async (min: number) => {
    vi.setSystemTime(T0 + min * 60_000);
    await svc.write('s1', 'Германия-1', METRICS);
  };
  return { svc, vm, down, up: () => up, write };
}

describe('запись метрик в VictoriaMetrics: счётчик неудач подряд', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('порог — 10 минут подряд', () => {
    expect(METRICS_DOWN_AFTER_MS).toBe(10 * 60_000);
  });

  it('не записывается дольше 10 минут подряд — одно оповещение с началом сбоя; дальше молчим', async () => {
    const { vm, down, write } = make();
    await write(0);
    vm.ok = false;
    for (let m = 1; m <= 10; m += 1) await write(m);
    expect(down).toHaveLength(0);
    await write(11);
    expect(down).toEqual([new Date(T0 + 60_000)]);
    for (let m = 12; m <= 40; m += 1) await write(m);
    expect(down).toHaveLength(1);
  });

  it('снова записывается — одно «снова записываются», дальше молчим', async () => {
    const { vm, up, write } = make();
    await write(0);
    expect(up()).toBe(1); // первая удачная запись после запуска — сверить, не говорили ли о сбое до перезапуска
    vm.ok = false;
    for (let m = 1; m <= 12; m += 1) await write(m);
    vm.ok = true;
    await write(13);
    await write(14);
    expect(up()).toBe(2);
  });

  it('удачная запись посреди неудач обнуляет счёт: два сбоя по 9 минут — не «10 минут подряд»', async () => {
    const { vm, down, write } = make();
    vm.ok = false;
    for (let m = 0; m <= 9; m += 1) await write(m);
    vm.ok = true;
    await write(9.5);
    vm.ok = false;
    for (let m = 10; m <= 18; m += 1) await write(m);
    expect(down).toHaveLength(0);
  });

  it('ответ хранилища с ошибкой — тоже неудача', async () => {
    const { vm, down, write } = make();
    vm.status = 500;
    for (let m = 0; m <= 10; m += 1) await write(m);
    expect(down).toEqual([new Date(T0)]);
  });

  it('о сбое уже сказали, панель перезапустилась, сбой продолжается — повторное «не записываются» решает отметка раз в сутки', async () => {
    const { vm, down, up, write } = make();
    vm.ok = false;
    for (let m = 0; m <= 10; m += 1) await write(m);
    expect(down).toHaveLength(1);
    expect(up()).toBe(0);
  });
});

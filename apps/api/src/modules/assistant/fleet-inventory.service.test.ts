import { HttpException } from '@nestjs/common';
import type { Server } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import { FleetInventoryService } from './fleet-inventory.service.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const srv = (id: string, over: Partial<Server> = {}) =>
  ({ id, name: id, sshOk: true, inventory: null, ...over }) as unknown as Server;
const inv = (hoursAgo: number) => ({
  at: new Date(NOW - hoursAgo * HOUR).toISOString(),
  docker: true,
  containers: [],
  ports: [],
});

function make(list: Server[], probeOver: Record<string, unknown> = {}) {
  const saved: Array<{ id: string; inv: unknown }> = [];
  const servers = {
    get: vi.fn(async (id: string) => list.find((s) => s.id === id) ?? srv(id)),
    list: vi.fn(async () => list),
    saveInventory: vi.fn(async (id: string, inventory: unknown) => {
      saved.push({ id, inv: inventory });
      return srv(id);
    }),
  };
  const probe = {
    containers: vi.fn(async () => ({
      docker: true,
      containers: [
        {
          name: 'remnanode',
          state: 'running',
          restarts: 1,
          image: 'x',
          exitCode: 0,
          oomKilled: false,
          startedAt: null,
          finishedAt: null,
          health: null,
        },
      ],
      attention: [],
    })),
    ports: vi.fn(async () => ({
      available: true,
      ports: [{ proto: 'tcp', address: '0.0.0.0', port: 443, process: 'xray', exposed: true }],
    })),
    ...probeOver,
  };
  const service = new FleetInventoryService(servers as never, probe as never);
  return { service, servers, probe, saved };
}

describe('FleetInventoryService', () => {
  it('снимок собирается из контейнеров и портов и сохраняется без лишних полей', async () => {
    const { service, saved } = make([srv('a')]);
    await service.refresh('a');
    expect(saved[0]?.inv).toEqual({
      docker: true,
      containers: [{ name: 'remnanode', state: 'running', restarts: 1 }],
      ports: [{ proto: 'tcp', port: 443, process: 'xray', exposed: true }],
    });
  });

  it('ошибка SSH: понятный текст и статус 424, а не 5xx (иначе текст подменится общим)', async () => {
    const { service } = make([srv('a')], {
      containers: async () => {
        throw new Error('таймаут');
      },
    });
    const err = await service.refresh('a').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(424);
    expect(JSON.stringify((err as HttpException).getResponse())).toContain(
      'Не удалось прочитать состояние сервера',
    );
  });

  it('суточный проход: берёт без снимка и со старым, пропускает свежие и серверы без рабочего SSH', async () => {
    const list = [
      srv('none'),
      srv('old', { inventory: inv(30) }),
      srv('fresh', { inventory: inv(5) }),
      srv('down', { sshOk: false }),
      srv('unknown', { sshOk: null }),
    ];
    const { service, saved } = make(list);
    vi.useFakeTimers();
    const run = service.refreshStale(NOW);
    await vi.runAllTimersAsync();
    const done = await run;
    vi.useRealTimers();
    expect(done).toBe(3);
    expect(saved.map((s) => s.id).sort()).toEqual(['none', 'old', 'unknown']);
  });

  it('ошибка у одного сервера не останавливает проход; параллельный запуск не стартует', async () => {
    let calls = 0;
    const { service } = make([srv('bad'), srv('good')], {
      containers: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ssh');
        return { docker: true, containers: [], attention: [] };
      },
    });
    vi.useFakeTimers();
    const first = service.refreshStale(NOW);
    const second = await service.refreshStale(NOW);
    await vi.runAllTimersAsync();
    expect(await first).toBe(1);
    expect(second).toBe(0);
    vi.useRealTimers();
  });
});

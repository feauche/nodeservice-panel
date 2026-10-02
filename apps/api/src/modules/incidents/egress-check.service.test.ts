import { describe, expect, it, vi } from 'vitest';

import { EgressCheckService } from './egress-check.service.js';

const report = {
  via: 'Германия - 1',
  results: [],
  panelPing: null,
};

describe('EgressCheckService: прямой вход и запасной путь', () => {
  const make = () => new EgressCheckService({} as never, {} as never, {} as never);

  it('свежий прямой вход сработал — встречные проверки не запускает', async () => {
    const service = make();
    vi.spyOn(service, 'check').mockResolvedValue({ ...report, via: null });
    const discover = vi.fn(async () => ['Германия - 1']);

    await expect(service.checkWithFallback({ id: 'target' }, [], discover, { force: true })).resolves.toEqual(
      {
        ...report,
        via: null,
      },
    );
    expect(discover).not.toHaveBeenCalled();
    expect(service.check).toHaveBeenCalledTimes(1);
    expect(service.check).toHaveBeenCalledWith({ id: 'target' }, [], [], { force: true });
  });

  it('старая зелёная отметка SSH не мешает после прямой неудачи войти через сервер парка', async () => {
    const service = make();
    vi.spyOn(service, 'check').mockResolvedValueOnce(null).mockResolvedValueOnce(report);
    const discover = vi.fn(async () => ['Германия - 1', 'Нидерланды - 1']);

    await expect(service.checkWithFallback({ id: 'target' }, [], discover)).resolves.toBe(report);
    expect(discover).toHaveBeenCalledOnce();
    expect(service.check).toHaveBeenNthCalledWith(1, { id: 'target' }, [], [], {});
    expect(service.check).toHaveBeenNthCalledWith(
      2,
      { id: 'target' },
      [],
      ['Германия - 1', 'Нидерланды - 1'],
      { force: true },
    );
  });

  it('ни один сервер парка не видит порт — честно возвращает null без ложной второй попытки', async () => {
    const service = make();
    vi.spyOn(service, 'check').mockResolvedValue(null);

    await expect(service.checkWithFallback({ id: 'target' }, [], async () => [])).resolves.toBeNull();
    expect(service.check).toHaveBeenCalledTimes(1);
  });

  it('полная проверка получает отдельный таймаут больше максимального времени параллельных целей', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '0 closed\nping fail\n', stderr: '' }));
    const end = vi.fn();
    const service = new EgressCheckService(
      { sshTargetFor: async () => ({ target: { host: '1.2.3.4' } }) } as never,
      { connect: async () => ({ exec, end }) } as never,
      {
        get: (key: string) => (key === 'PUBLIC_URL' ? 'https://panel.example.com' : undefined),
      } as never,
    );

    const result = await service.check({ id: 'target' }, [], [], { force: true });
    expect(result?.results[0]?.open).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('wait'),
      expect.objectContaining({ timeoutMs: 15_000, label: 'проверка выхода с сервера' }),
    );
    expect(end).toHaveBeenCalledOnce();
  });
});

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
});

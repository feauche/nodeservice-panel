import { describe, expect, it, vi } from 'vitest';

import { RussiaAccessCheckService } from './russia-access-check.service.js';

const panelServer = {
  id: 's-target',
  name: 'Нидерланды - 1',
  host: '1.2.3.4',
  port: 5492,
  nodeLink: 'auto',
};
const node = { uuid: 'n-1', name: 'Нидерланды - 1', address: '1.2.3.4' };

function setup(linked = true) {
  const all = [panelServer, { id: 'ru-1', name: 'Россия - 1', host: '5.6.7.8' }];
  const check = vi.fn(async () => ({ verdict: 'ok' }));
  const checkServer = vi.fn(async () => ({ verdict: 'ok' }));
  const refresh = vi.fn(async () => ({ nodes: [node] }));
  const nodeInbound = vi.fn(async () => ({ port: 443, sni: 'mask.example', failed: false }));
  const service = new RussiaAccessCheckService(
    { list: async () => all } as never,
    { refresh, nodeInbound } as never,
    {
      resolve: async () => ({
        nodeOf: () => (linked ? node : undefined),
        machineIds: () => ['s-target', 's-twin'],
      }),
    } as never,
    { check, checkServer } as never,
  );
  return { service, check, checkServer, refresh, nodeInbound, all };
}

describe('ручная проверка доступности из России', () => {
  it('берёт свежую ноду Remnawave и исключает все записи проверяемой машины', async () => {
    const { service, check, refresh, nodeInbound, all } = setup();
    await expect(service.run('s-target')).resolves.toEqual({ verdict: 'ok' });

    expect(refresh).toHaveBeenCalledOnce();
    expect(nodeInbound).toHaveBeenCalledWith('n-1');
    expect(check).toHaveBeenCalledWith(
      'Нидерланды - 1',
      '1.2.3.4',
      443,
      'mask.example',
      ['s-target', 's-twin'],
      all,
      false,
      { protocol: null, network: null },
    );
  });

  it('без связанной ноды проверяет SSH-порт самого сервера', async () => {
    const { service, check, checkServer, nodeInbound, all } = setup(false);
    await expect(service.run('s-target')).resolves.toEqual({ verdict: 'ok' });
    expect(check).not.toHaveBeenCalled();
    expect(nodeInbound).not.toHaveBeenCalled();
    expect(checkServer).toHaveBeenCalledWith('Нидерланды - 1', '1.2.3.4', 5492, 's-target', all);
  });

  it('при явном «ноды нет» не обращается к Remnawave', async () => {
    const { service, checkServer, refresh } = setup(false);
    panelServer.nodeLink = 'none';
    try {
      await service.run('s-target');
      expect(refresh).not.toHaveBeenCalled();
      expect(checkServer).toHaveBeenCalledOnce();
    } finally {
      panelServer.nodeLink = 'auto';
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  computeDrift,
  DEFAULT_SERVER_PROFILE,
  normalizeProfilePatch,
  serverProfilePatchSchema,
} from './server-profile.js';

const inv = (over: Partial<Parameters<typeof computeDrift>[1] & object> = {}) => ({
  docker: true,
  containers: [
    { name: 'remnanode', state: 'running', restarts: 0 },
    { name: 'nginx', state: 'exited', restarts: 2 },
  ],
  ports: [
    { proto: 'tcp' as const, port: 443, process: 'xray', exposed: true },
    { proto: 'tcp' as const, port: 22, process: 'sshd', exposed: true },
  ],
  ...over,
});

describe('computeDrift', () => {
  it('без снимка сравнивать не с чем: пусто', () => {
    expect(computeDrift({ expectedContainers: ['remnanode'], expectedPorts: [443] }, null)).toEqual([]);
  });
  it('всё ожидаемое на месте: пусто; лишние контейнеры и порты не в счёт', () => {
    expect(computeDrift({ expectedContainers: ['remnanode'], expectedPorts: [443, 22] }, inv())).toEqual([]);
    expect(computeDrift({ expectedContainers: [], expectedPorts: [] }, inv())).toEqual([]);
  });
  it('нет контейнера, контейнер не работает, порт не слушают', () => {
    const d = computeDrift(
      { expectedContainers: ['remnanode', 'nginx', 'grafana'], expectedPorts: [443, 8443] },
      inv(),
    );
    expect(d.map((x) => `${x.kind}:${x.subject}`)).toEqual([
      'container_not_running:nginx',
      'container_missing:grafana',
      'port_not_listening:8443',
    ]);
    expect(d[0]?.detail).toContain('exited');
    expect(d[2]?.detail).toBe('Порт 8443 никто не слушает.');
  });
  it('имя контейнера сравнивается без учёта регистра; без Docker называется причина', () => {
    expect(computeDrift({ expectedContainers: ['RemnaNode'], expectedPorts: [] }, inv())).toEqual([]);
    const d = computeDrift(
      { expectedContainers: ['remnanode'], expectedPorts: [] },
      inv({ docker: false, containers: [] }),
    );
    expect(d[0]?.detail).toContain('не найден Docker');
  });
});

describe('профиль: проверка и приведение', () => {
  it('по умолчанию профиль пуст, важность обычная', () => {
    expect(DEFAULT_SERVER_PROFILE).toEqual({
      roles: [],
      importance: 'normal',
      maintenanceWindow: null,
      expectedContainers: [],
      expectedPorts: [],
    });
  });
  it('схема принимает верное и отвергает неверное', () => {
    expect(
      serverProfilePatchSchema.safeParse({ roles: ['entry', 'exit'], expectedPorts: ['443', 22] }).success,
    ).toBe(true);
    for (const bad of [
      { roles: ['boss'] },
      { roles: 'entry' },
      { importance: 'high' },
      { expectedPorts: [0] },
      { expectedPorts: [70000] },
      { expectedContainers: ['a b'] },
      { expectedContainers: ['-x'] },
      { expectedContainers: Array.from({ length: 21 }, (_, i) => `c${i}`) },
      { maintenanceWindow: 'x'.repeat(121) },
    ])
      expect(serverProfilePatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it('порты и имена без повторов и по порядку, пустое окно обслуживания становится null', () => {
    const n = normalizeProfilePatch({
      expectedPorts: [443, 22, 443],
      expectedContainers: ['nginx', 'remnanode', 'nginx'],
      maintenanceWindow: '   ',
    });
    expect(n).toEqual({
      expectedPorts: [22, 443],
      expectedContainers: ['nginx', 'remnanode'],
      maintenanceWindow: null,
    });
    expect(normalizeProfilePatch({ maintenanceWindow: ' ночью по Москве ' }).maintenanceWindow).toBe(
      'ночью по Москве',
    );
    expect(normalizeProfilePatch({ roles: ['exit', 'entry', 'exit'] })).toEqual({ roles: ['entry', 'exit'] });
  });
});

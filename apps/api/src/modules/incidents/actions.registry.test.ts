import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { ACTION_SPECS, FIND_NODE, SH } from './actions.registry.js';

/**
 * Настоящий запуск поиска контейнера ноды: вместо `docker ps` — подставной список «имя|образ» (Docker
 * выводит новые контейнеры сверху). Возвращает имя, которое панель сочтёт нодой; пусто — ноды нет.
 */
function findNode(listing: string[]): string {
  const script = `docker() { printf '%s\\n' ${listing.map((l) => `'${l}'`).join(' ')}; }; ${FIND_NODE}; printf '%s' "$N"`;
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' });
}

/** Одинарная кавычка в теле рвёт `sh -c '…'`: шелл получает мусор и отвечает 127. */
describe('actions.registry', () => {
  it('SH экранирует одинарные кавычки внутри тела', () => {
    expect(SH("echo 'привет'")).toBe(`sh -c 'echo '\\''привет'\\'''`);
    expect(SH('echo "привет"')).toBe(`sh -c 'echo "привет"'`);
  });

  describe('поиск контейнера ноды', () => {
    it('сервер «панель + нода»: нодой считается контейнер с образом ноды, а не самый новый с «remna» в имени', () => {
      // Панель Remnawave обновили позже ноды — её контейнеры в списке выше.
      expect(
        findNode([
          'remnawave|remnawave/backend:latest',
          'remnawave-redis|valkey/valkey:8-alpine',
          'remnawave-db|postgres:17',
          'remnanode|remnawave/node:latest',
        ]),
      ).toBe('remnanode');
    });

    it('сервер только с панелью Remnawave — ноды на нём нет', () => {
      expect(
        findNode([
          'remnawave|remnawave/backend:latest',
          'remnawave-subscription-page|remnawave/subscription-page:latest',
          'remnawave-db|postgres:17',
          'remnawave-redis|valkey/valkey:8-alpine',
          'remnawave-nginx|nginx:1.27',
        ]),
      ).toBe('');
    });

    it('образ ноды из другого реестра и с другим именем контейнера — тоже нода', () => {
      expect(findNode(['nginx|nginx:1.27', 'my-vpn|ghcr.io/remnawave/node:2.1.0'])).toBe('my-vpn');
      expect(findNode(['node-1|remnawave/node@sha256:abcdef'])).toBe('node-1');
    });

    it('свой образ: нода находится по привычному имени контейнера', () => {
      for (const name of ['remnanode', 'remnawave-node', 'remna_node', 'RemnaNode', 'remnanode-2'])
        expect(findNode(['nginx|nginx:1.27', `${name}|local/my-node:1`]), name).toBe(name);
    });

    it('образ важнее имени, а чужие образы с похожим названием нодой не считаются', () => {
      expect(findNode(['remnanode-old|local/archive:1', 'x|remnawave/node:latest'])).toBe('x');
      expect(findNode(['a|remnawave/node-exporter:1', 'b|someone/remnawave/nodes:1'])).toBe('');
    });

    it('Docker не ответил или контейнеров нет — пусто', () => {
      expect(findNode([])).toBe('');
    });
  });

  it('все команды реестра — корректно закрытая строка sh -c', () => {
    for (const [key, spec] of Object.entries(ACTION_SPECS)) {
      const cmd = spec?.command;
      if (!cmd) continue;
      expect(cmd.startsWith("sh -c '"), key).toBe(true);
      expect(cmd.endsWith("'"), key).toBe(true);
      // Внутри обёртки все кавычки идут только в виде '\'' — иначе строка закроется раньше времени.
      const body = cmd.slice(7, -1);
      expect(body.replaceAll(`'\\''`, ''), key).not.toContain("'");
    }
  });
});

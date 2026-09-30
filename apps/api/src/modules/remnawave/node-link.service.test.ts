import type { Server } from '@nodeservice/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeLinkService } from './node-link.service.js';

const server = (name: string, host: string, nodeLink = 'auto') =>
  ({ id: `s-${name}`, name, host, nodeLink, facts: { addresses: [] } }) as unknown as Server;
const node = (name: string, address: string) =>
  ({ uuid: `n-${name}`, name, address }) as never as import('@nodeservice/shared').RemnawaveNode;

describe('NodeLinkService', () => {
  afterEach(() => vi.useRealTimers());

  it('домены разрешаются один раз и помнятся: следующая сверка в DNS не ходит', async () => {
    const asked: string[] = [];
    const svc = new NodeLinkService({
      resolve: async (h) => {
        asked.push(h);
        return ['201.34.145.175'];
      },
    });
    const servers = [server('Нидерланды - 1', 'nl1.example.com')];
    const nodes = [node('nl', '201.34.145.175')];
    expect((await svc.resolve(servers, nodes)).byOf('s-Нидерланды - 1')).toBe('ip');
    expect((await svc.resolve(servers, nodes)).byOf('s-Нидерланды - 1')).toBe('ip');
    expect(asked).toEqual(['nl1.example.com']);
  });

  it('DNS перестал отвечать — связь держится на прежнем ответе, а не рвётся', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-30T10:00:00Z') });
    let alive = true;
    const svc = new NodeLinkService({ resolve: async () => (alive ? ['5.5.5.5'] : []) });
    const servers = [server('de', 'de.example.com')];
    const nodes = [node('de', '5.5.5.5')];
    expect((await svc.resolve(servers, nodes)).nodeOf('s-de')?.uuid).toBe('n-de');
    alive = false;
    vi.setSystemTime(Date.parse('2026-09-30T10:30:00Z'));
    expect((await svc.resolve(servers, nodes)).nodeOf('s-de')?.uuid).toBe('n-de');
  });

  it('домен не разрешился — через минуту панель спросит снова', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-30T10:00:00Z') });
    let calls = 0;
    const svc = new NodeLinkService({
      resolve: async () => {
        calls += 1;
        return calls > 1 ? ['5.5.5.5'] : [];
      },
    });
    const servers = [server('de', 'de.example.com')];
    const nodes = [node('de', '5.5.5.5')];
    expect((await svc.resolve(servers, nodes)).nodeOf('s-de')).toBeUndefined();
    vi.setSystemTime(Date.parse('2026-09-30T10:00:30Z'));
    expect((await svc.resolve(servers, nodes)).nodeOf('s-de')).toBeUndefined();
    vi.setSystemTime(Date.parse('2026-09-30T10:01:01Z'));
    expect((await svc.resolve(servers, nodes)).nodeOf('s-de')?.uuid).toBe('n-de');
  });

  it('annotate: у ноды — её серверы и способ связи; у ноды без сервера — пусто', async () => {
    const svc = new NodeLinkService({ resolve: async () => [] });
    const out = await svc.annotate(
      [server('а', '1.1.1.1'), server('б', '2.2.2.2', 'n-ручная')],
      [node('своя', '1.1.1.1'), node('ручная', '9.9.9.9'), node('чужая', '8.8.8.8')],
    );
    expect(out.map((n) => [n.name, n.serverIds, n.linkedBy])).toEqual([
      ['своя', ['s-а'], 'address'],
      ['ручная', ['s-б'], 'manual'],
      ['чужая', [], null],
    ]);
  });
});

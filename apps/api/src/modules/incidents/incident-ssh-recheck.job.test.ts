import { afterEach, describe, expect, it } from 'vitest';

import { IncidentSshRecheckJob } from './incident-ssh-recheck.job.js';

describe('IncidentSshRecheckJob', () => {
  const prevEnv = process.env.NODE_ENV;

  function make() {
    const openIncidents: Array<{ kind: string; serverId: string | null; detail?: string }> = [];
    const servers = new Map<
      string,
      { id: string; name: string; lastSshCheckAt: Date | null; sshOk?: boolean | null }
    >();
    const checked: string[] = [];
    const incidentsRepo = { list: async () => openIncidents };
    const serversRepo = {
      findById: async (id: string) => servers.get(id),
      list: async () => [...servers.values()],
    };
    const serversSvc = {
      autocheck: async (row: { id: string }) => {
        checked.push(row.id);
      },
    };
    const job = new IncidentSshRecheckJob(incidentsRepo as never, serversRepo as never, serversSvc as never);
    return { job, openIncidents, servers, checked };
  }

  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
  });

  it('tick() в тестовом окружении ничего не делает; run() — настоящая логика', async () => {
    process.env.NODE_ENV = 'test';
    const ctx = make();
    ctx.openIncidents.push({ kind: 'ssh_down', serverId: 's1' });
    ctx.servers.set('s1', { id: 's1', name: 'x', lastSshCheckAt: null });
    await ctx.job.tick();
    expect(ctx.checked).toEqual([]);
    await ctx.job.run();
    expect(ctx.checked).toEqual(['s1']);
  });

  it('без открытых «SSH недоступен» ничего не проверяет', async () => {
    const ctx = make();
    ctx.openIncidents.push({ kind: 'cpu_high', serverId: 's1' });
    await ctx.job.run();
    expect(ctx.checked).toEqual([]);
  });

  it('перепроверяет каждый сервер с открытым «SSH недоступен», без дублей по инцидентам', async () => {
    const ctx = make();
    ctx.openIncidents.push(
      { kind: 'ssh_down', serverId: 's1' },
      { kind: 'ssh_down', serverId: 's1' },
      { kind: 'ssh_down', serverId: 's2' },
    );
    ctx.servers.set('s1', { id: 's1', name: 'a', lastSshCheckAt: null });
    ctx.servers.set('s2', { id: 's2', name: 'b', lastSshCheckAt: null });
    await ctx.job.run();
    expect(ctx.checked.sort()).toEqual(['s1', 's2']);
  });

  it('не долбит SSH чаще минимального промежутка', async () => {
    const ctx = make();
    ctx.openIncidents.push({ kind: 'ssh_down', serverId: 's1' });
    ctx.servers.set('s1', { id: 's1', name: 'a', lastSshCheckAt: new Date() });
    await ctx.job.run();
    expect(ctx.checked).toEqual([]);
    (ctx.servers.get('s1') as { lastSshCheckAt: Date | null }).lastSshCheckAt = new Date(Date.now() - 20_000);
    await ctx.job.run();
    expect(ctx.checked).toEqual(['s1']);
  });

  it('второй запуск не стартует, пока первый не закончился', async () => {
    const ctx = make();
    ctx.openIncidents.push({ kind: 'ssh_down', serverId: 's1' });
    ctx.servers.set('s1', { id: 's1', name: 'a', lastSshCheckAt: null });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const svc = ctx.job.servers as { autocheck: (row: { id: string }) => Promise<void> };
    const orig = svc.autocheck.bind(svc);
    svc.autocheck = async (row: { id: string }) => {
      await gate;
      return orig(row);
    };
    const first = ctx.job.run();
    await ctx.job.run();
    expect(ctx.checked).toEqual([]);
    release();
    await first;
    expect(ctx.checked).toEqual(['s1']);
  });

  it('ошибка проверки одного сервера не прерывает остальные и не роняет запуск', async () => {
    const ctx = make();
    ctx.openIncidents.push({ kind: 'ssh_down', serverId: 's1' }, { kind: 'ssh_down', serverId: 's2' });
    ctx.servers.set('s1', { id: 's1', name: 'a', lastSshCheckAt: null });
    ctx.servers.set('s2', { id: 's2', name: 'b', lastSshCheckAt: null });
    const svc = ctx.job.servers as { autocheck: (row: { id: string }) => Promise<void> };
    const realAutocheck = svc.autocheck.bind(svc);
    svc.autocheck = async (row: { id: string }) => {
      if (row.id === 's1') throw new Error('таймаут');
      return realAutocheck(row);
    };
    await expect(ctx.job.run()).resolves.toBeUndefined();
    expect(ctx.checked).toEqual(['s2']);
  });

  it('SSH не ответил, а дела ещё нет: перепроверяем сразу — неудачу нужно подтвердить или снять', async () => {
    const ctx = make();
    ctx.servers.set('s1', {
      id: 's1',
      name: 'a',
      lastSshCheckAt: new Date(Date.now() - 20_000),
      sshOk: false,
    });
    // SSH в порядке или ещё не проверялся — ускоренная проверка не нужна.
    ctx.servers.set('s2', { id: 's2', name: 'b', lastSshCheckAt: null, sshOk: true });
    ctx.servers.set('s3', { id: 's3', name: 'c', lastSshCheckAt: null, sshOk: null });
    await ctx.job.run();
    expect(ctx.checked).toEqual(['s1']);
  });

  it('неподтверждённую неудачу тоже не перепроверяем чаще минимального промежутка', async () => {
    const ctx = make();
    ctx.servers.set('s1', { id: 's1', name: 'a', lastSshCheckAt: new Date(), sshOk: false });
    await ctx.job.run();
    expect(ctx.checked).toEqual([]);
  });

  it('открыто «Недоступен из части сетей» — молчание SSH уже объяснено, ускоренной проверки нет', async () => {
    const ctx = make();
    ctx.openIncidents.push({
      kind: 'node_blocked',
      serverId: 's1',
      detail: 'Недоступен из части сетей: агент не выходит на связь…',
    });
    // «Похоже на блокировку» по падению онлайна SSH не объясняет — такой сервер перепроверяется.
    ctx.openIncidents.push({ kind: 'node_blocked', serverId: 's2', detail: 'Онлайн: 396 → 0 за 10 минут.' });
    ctx.servers.set('s1', { id: 's1', name: 'a', lastSshCheckAt: null, sshOk: false });
    ctx.servers.set('s2', { id: 's2', name: 'b', lastSshCheckAt: null, sshOk: false });
    await ctx.job.run();
    expect(ctx.checked).toEqual(['s2']);
  });

  it('сервер удалили — тихо пропускается', async () => {
    const ctx = make();
    ctx.openIncidents.push({ kind: 'ssh_down', serverId: 'ghost' });
    await expect(ctx.job.run()).resolves.toBeUndefined();
    expect(ctx.checked).toEqual([]);
  });
});

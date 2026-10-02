import { afterEach, describe, expect, it } from 'vitest';

import { AgentService } from './agent.service.js';
import { AgentOfflineJob } from './agent-offline.job.js';

interface Row {
  id: string;
  name: string;
  agentStatus: string;
  agentVersion: string | null;
  agentLastSeenAt: Date | null;
}

/** Служба агентов на памяти: запись сервера — объект, Журнал — список. */
function make(row: Row | null, agentPublicUrl?: string) {
  const journal: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const repo = {
    findById: async () => (row ? { ...row } : undefined),
    list: async () => (row ? [{ ...row }] : []),
    update: async (_id: string, patch: Partial<Row>) => {
      if (!row) return undefined;
      // Как в базе: ответ приходит не мгновенно, соседние сообщения агента успевают вклиниться.
      await new Promise((r) => setTimeout(r, 1));
      Object.assign(row, patch);
      return { ...row };
    },
  };
  const audit = {
    record: async (e: { action: string; metadata?: Record<string, unknown> }) => {
      await new Promise((r) => setTimeout(r, 1));
      journal.push(e);
    },
  };
  const autochecks = { get: async () => ({ agentOfflineEnabled: true, agentOfflineAfterSeconds: 30 }) };
  const written: string[] = [];
  const vm = { write: async (id: string) => void written.push(id) };
  const agents = new AgentService(
    repo as never,
    {} as never,
    audit as never,
    autochecks as never,
    vm as never,
    {
      get: (key: string) => ({ PUBLIC_URL: 'https://panel.test/', AGENT_PUBLIC_URL: agentPublicUrl })[key],
    } as never,
  );
  const job = new AgentOfflineJob(repo as never, agents, autochecks as never);
  const online = () => journal.filter((e) => e.action === 'server.agent.online');
  const offline = () => journal.filter((e) => e.action === 'server.agent.offline');
  return { agents, job, journal, online, offline, written };
}

const server = (patch: Partial<Row> = {}): Row => ({
  id: 's1',
  name: 'de-1',
  agentStatus: 'online',
  agentVersion: '0.5.4',
  agentLastSeenAt: new Date(),
  ...patch,
});

describe('AgentService: сигнал по открытому соединению возвращает «в сети»', () => {
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
  });

  it('сеть подвисла дольше порога, соединение выжило: сигналы возобновились — статус снова «в сети», в Журнале одна запись', async () => {
    const row = server({ agentLastSeenAt: new Date(Date.now() - 35_000) });
    const ctx = make(row);
    // Джоба тикает только вне тестового окружения — здесь проверяем её настоящую работу.
    process.env.NODE_ENV = 'production';
    await ctx.job.tick();
    expect(row.agentStatus).toBe('offline');
    expect(ctx.offline()).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) expect(await ctx.agents.touch('s1', '0.5.4')).toBe(true);
    expect(row.agentStatus).toBe('online');
    expect(ctx.online()).toHaveLength(1);
    expect(ctx.online()[0]?.metadata).toMatchObject({ version: '0.5.4' });
    // Почему статус вернулся без переподключения — словами, по-русски.
    expect(String(ctx.online()[0]?.metadata?.reason)).toMatch(/возобновились/);

    // Следующий тик джобы: сигнал свежий — статус не дёргается, новых записей нет.
    await ctx.job.tick();
    expect(row.agentStatus).toBe('online');
    expect(ctx.offline()).toHaveLength(1);
    expect(ctx.online()).toHaveLength(1);
  });

  it('метрики возвращают статус так же, как сигнал', async () => {
    const row = server({ agentStatus: 'offline' });
    const ctx = make(row);
    await ctx.agents.handleMetrics(row as never, '0.5.4', {} as never);
    expect(row.agentStatus).toBe('online');
    expect(ctx.online()).toHaveLength(1);
    expect(ctx.written).toEqual(['s1']);
  });

  it('сигнал и метрика пришли разом — запись «вышел на связь» одна', async () => {
    const row = server({ agentStatus: 'offline' });
    const ctx = make(row);
    await Promise.all([
      ctx.agents.touch('s1', '0.5.4'),
      ctx.agents.handleMetrics(row as never, '0.5.4', {} as never),
      ctx.agents.touch('s1', '0.5.4'),
    ]);
    expect(row.agentStatus).toBe('online');
    expect(ctx.online()).toHaveLength(1);
  });

  it('«Ожидает агента» при живом соединении тоже становится «в сети»', async () => {
    const row = server({ agentStatus: 'pending' });
    const ctx = make(row);
    await ctx.agents.touch('s1', '0.5.4');
    expect(row.agentStatus).toBe('online');
  });

  it('пока идёт установка, сигнал прежнего агента статус не трогает', async () => {
    const row = server({ agentStatus: 'installing', agentLastSeenAt: null });
    const ctx = make(row);
    expect(await ctx.agents.touch('s1', '0.5.4')).toBe(true);
    expect(row.agentStatus).toBe('installing');
    expect(row.agentLastSeenAt).not.toBeNull();
    expect(ctx.journal).toEqual([]);
  });

  it('агент на связи — сигнал только обновляет время, в Журнал ничего не пишет', async () => {
    const row = server({ agentLastSeenAt: new Date(Date.now() - 9_000) });
    const ctx = make(row);
    await ctx.agents.touch('s1', '0.5.4');
    expect(Date.now() - (row.agentLastSeenAt?.getTime() ?? 0)).toBeLessThan(2_000);
    expect(ctx.journal).toEqual([]);
  });

  it('сервера уже нет — сигнал сообщает об этом, а не пишет в пустоту', async () => {
    const ctx = make(null);
    expect(await ctx.agents.touch('s1', '0.5.4')).toBe(false);
    expect(ctx.journal).toEqual([]);
  });

  it('джоба не помечает «не в сети», если сигнал успел прийти, пока она шла по списку', async () => {
    const row = server({ agentLastSeenAt: new Date(Date.now() - 35_000) });
    const ctx = make(row);
    // Снимок из списка устарел: к моменту отметки агент уже подал сигнал.
    const stale = { ...row };
    row.agentLastSeenAt = new Date();
    await ctx.agents.markOffline(stale as never, 'сигнала нет', new Date(Date.now() - 30_000));
    expect(row.agentStatus).toBe('online');
    expect(ctx.journal).toEqual([]);
    // Без свежего сигнала — помечает, как раньше.
    row.agentLastSeenAt = new Date(Date.now() - 35_000);
    await ctx.agents.markOffline(stale as never, 'сигнала нет', new Date(Date.now() - 30_000));
    expect(row.agentStatus).toBe('offline');
  });

  it('причина в Журнале — по-русски, без слова heartbeat', async () => {
    const row = server({ agentLastSeenAt: new Date(Date.now() - 35_000) });
    const ctx = make(row);
    process.env.NODE_ENV = 'production';
    await ctx.job.tick();
    expect(ctx.offline()[0]?.metadata?.reason).toBe('сигнала от агента нет дольше 30 с');
  });
});

describe('AgentService: адрес WebSocket', () => {
  it('использует отдельный внешний маршрут агентов и убирает завершающий слеш', () => {
    expect(make(server(), 'https://agents.example.net/').agents.wsUrl()).toBe(
      'wss://agents.example.net/api/agent/v1/ws',
    );
    expect(make(server()).agents.wsUrl()).toBe('wss://panel.test/api/agent/v1/ws');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  name: string;
  host: string;
  port: number;
  agentStatus: string;
  agentPubkey: string | null;
  agentListenPort?: number | null;
  agentAccessKeyEnc?: string | null;
  agentTlsCert?: string | null;
  sshOk: boolean | null;
}

/** Джоба на памяти. Модуль загружаем заново под нужным окружением: пауза в 3 минуты берётся при загрузке. */
async function make(env: 'test' | 'production', opts: { explainFails?: boolean } = {}) {
  vi.resetModules();
  process.env.NODE_ENV = env;
  const { AgentPendingJob } = await import('./agent-pending.job.js');
  const row: Row = {
    id: 's1',
    name: 'kz-1',
    host: '203.0.113.7',
    port: 22,
    agentStatus: 'pending',
    agentPubkey: null,
    sshOk: true,
  };
  const pushed: Array<{ title: string; body?: string }> = [];
  const journal: Array<{ action: string; result?: string; metadata?: Record<string, unknown> }> = [];
  const hooks: {
    duringExplain?: () => void;
    installedAt?: number;
    installRunning?: boolean;
    updateFails?: boolean;
    countryChecks?: number;
  } = {};
  const servers = {
    list: async () => [{ ...row }],
    agentInstalledAt: () => hooks.installedAt,
    agentInstallRunning: () => hooks.installRunning === true,
  };
  const serversRepo = {
    findById: async () => ({ ...row }),
    update: async (_id: string, patch: Partial<Row>) => {
      if (hooks.updateFails) throw new Error('база недоступна');
      return { ...Object.assign(row, patch) };
    },
  };
  const egress = {
    checkWithFallback: async (_server: unknown, _all: unknown, discover: () => Promise<unknown>) => {
      hooks.duringExplain?.();
      if (opts.explainFails) throw new Error('сбой проверки');
      await discover();
      return null;
    },
  };
  const job = new AgentPendingJob(
    servers as never,
    serversRepo as never,
    { snapshot: async () => Promise.reject(new Error('таймаут подключения к агенту')) } as never,
    egress as never,
    {
      countryReach: async () => {
        hooks.countryChecks = (hooks.countryChecks ?? 0) + 1;
        return { results: [], blind: 'no_probers' };
      },
    } as never,
    { push: async (n: { title: string; body?: string }) => void pushed.push(n) } as never,
    { record: async (e: { action: string }) => void journal.push(e) } as never,
  );
  const offline = () => journal.filter((e) => e.action === 'server.agent.offline');
  return { job, row, pushed, journal, offline, hooks };
}

describe('AgentPendingJob: «Ожидает агента» не висит вечно', () => {
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
  });

  it('три минуты ждём молча; потом — причина в колокольчик и статус «Агент не в сети», один раз', async () => {
    const ctx = await make('production');
    const t0 = Date.now();
    await ctx.job.run(t0);
    await ctx.job.run(t0 + 179_000);
    expect(ctx.row.agentStatus).toBe('pending');
    expect(ctx.pushed).toEqual([]);

    await ctx.job.run(t0 + 181_000);
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.offline()).toHaveLength(1);
    expect(ctx.offline()[0]?.metadata).toEqual({ reason: 'не вышел на связь за 3 минуты после установки' });
    // Даже при прошлой зелёной отметке SSH после прямой неудачи ищется свежий запасной путь.
    expect(ctx.hooks.countryChecks).toBe(1);

    // Дальше сервер ведёт детекция инцидентов — джоба к нему не возвращается.
    await ctx.job.run(t0 + 400_000);
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.offline()).toHaveLength(1);
  });

  it('для нового агента проверяет входящий порт и не ставит ошибочный диагноз про исходящий маршрут', async () => {
    const ctx = await make('test');
    ctx.row.agentListenPort = 23456;
    ctx.row.agentAccessKeyEnc = 'enc:key';
    ctx.row.agentTlsCert = 'cert';
    await ctx.job.run();
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.pushed[0]?.title).toContain('Панель не получает ответ');
    expect(ctx.pushed[0]?.body).toContain('HTTPS-порту 23456');
    expect(ctx.pushed[0]?.body).toContain('Исходящий доступ сервера');
    expect(ctx.hooks.countryChecks).toBeUndefined();
  });

  it('агент вышел на связь, пока панель выясняла причину, — статус не трогаем', async () => {
    const ctx = await make('test');
    ctx.hooks.duringExplain = () => {
      ctx.row.agentStatus = 'online';
    };
    await ctx.job.run();
    expect(ctx.row.agentStatus).toBe('online');
    expect(ctx.offline()).toEqual([]);
  });

  it('выяснить причину не удалось — статус всё равно перестаёт быть «Ожидает агента»', async () => {
    const ctx = await make('test', { explainFails: true });
    await ctx.job.run();
    expect(ctx.pushed).toEqual([]);
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.offline()).toHaveLength(1);
  });

  it('статус не записался (сбой базы) — следующий запуск повторяет перевод, причину второй раз не пишет', async () => {
    const ctx = await make('test');
    ctx.hooks.updateFails = true;
    await ctx.job.run();
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.row.agentStatus).toBe('pending');
    ctx.hooks.updateFails = false;
    await ctx.job.run();
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.pushed).toHaveLength(1);
    expect(ctx.offline()).toHaveLength(1);
  });

  it('«Агент устанавливается…» без идущей установки (панель перезапускали посреди неё) не висит вечно', async () => {
    const ctx = await make('test');
    const installs = () => ctx.journal.filter((e) => e.action === 'server.agent.install');
    ctx.row.agentStatus = 'installing';
    // Установка идёт прямо сейчас — статус её, не трогаем.
    ctx.hooks.installRunning = true;
    await ctx.job.run();
    expect(ctx.row.agentStatus).toBe('installing');
    expect(ctx.journal).toEqual([]);

    // Установки в этом процессе нет: статус остался от оборванной. Агент ни разу не привязывался.
    ctx.hooks.installRunning = false;
    await ctx.job.run();
    expect(ctx.row.agentStatus).toBe('not_installed');
    expect(installs()).toHaveLength(1);
    expect(installs()[0]).toMatchObject({ result: 'failed' });
    expect(String(installs()[0]?.metadata?.reason)).toMatch(/установка оборвалась/);
    expect(ctx.pushed).toEqual([]);

    // Агент был привязан раньше — честнее «не в сети».
    ctx.row.agentStatus = 'installing';
    ctx.row.agentPubkey = 'pubkey';
    await ctx.job.run();
    expect(ctx.row.agentStatus).toBe('offline');
  });

  it('агента переустановили между запусками джобы — три минуты отсчитываются от новой установки', async () => {
    const ctx = await make('production');
    const t0 = Date.now();
    await ctx.job.run(t0);
    // Через две с половиной минуты владелец переустановил агента; «устанавливается» джоба не застала.
    ctx.hooks.installedAt = t0 + 150_000;
    await ctx.job.run(t0 + 181_000);
    expect(ctx.row.agentStatus).toBe('pending');
    expect(ctx.pushed).toEqual([]);
    await ctx.job.run(t0 + 329_000);
    expect(ctx.row.agentStatus).toBe('pending');
    await ctx.job.run(t0 + 331_000);
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.pushed).toHaveLength(1);
  });

  it('повторная установка — отсчёт заново', async () => {
    const ctx = await make('production');
    const t0 = Date.now();
    await ctx.job.run(t0);
    await ctx.job.run(t0 + 181_000);
    expect(ctx.row.agentStatus).toBe('offline');
    await ctx.job.run(t0 + 200_000);
    // Владелец переустановил агента: снова «Ожидает агента».
    ctx.row.agentStatus = 'pending';
    await ctx.job.run(t0 + 260_000);
    await ctx.job.run(t0 + 400_000);
    expect(ctx.row.agentStatus).toBe('pending');
    await ctx.job.run(t0 + 445_000);
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.pushed).toHaveLength(2);
  });
});

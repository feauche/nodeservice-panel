import { describe, expect, it } from 'vitest';

import { errorText } from '../../common/filters/problem-details.filter.js';
import { agentInstallCommand } from './agent-install.js';
import { serverProblems } from './servers.problems.js';
import { ServersService } from './servers.service.js';
import type { SshExecStreamOptions } from './ssh.service.js';

const TOKEN = 'nse_SECRET-token';

type Exec = (command: string, opts: SshExecStreamOptions) => Promise<{ code: number }>;

/** Служба серверов на памяти: одна запись сервера, SSH-сессия — заглушка с заданным исходом установки. */
function make(agentStatus: string, exec: Exec, connect?: () => Promise<never>, agentPublicUrl?: string) {
  const now = new Date();
  const row: Record<string, unknown> = {
    id: 's1',
    name: 'de-1',
    host: '203.0.113.5',
    port: 22,
    sshUser: 'root',
    authMethod: 'panel-key',
    sshPrivateKeyEnc: null,
    hostKeyFp: 'SHA256:x',
    tags: [],
    notes: null,
    providerId: null,
    nodeWatch: 'auto',
    country: null,
    countrySource: 'auto',
    countryStatus: 'ok',
    roles: [],
    importance: 'normal',
    maintenanceWindow: null,
    expectedContainers: [],
    expectedPorts: [],
    upstream: null,
    inventory: null,
    inventoryAt: null,
    agentStatus,
    agentVersion: null,
    agentLastSeenAt: null,
    sshOk: true,
    lastSshCheckAt: now,
    lastSshOkAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const journal: Array<{ action: string; result?: string; metadata?: Record<string, unknown> }> = [];
  const revoked: string[] = [];
  const calls: Array<{ command: string; opts: SshExecStreamOptions }> = [];
  let deleted = false;
  const repo = {
    findById: async () => (deleted ? undefined : { ...row }),
    update: async (_id: string, patch: Record<string, unknown>) => ({ ...Object.assign(row, patch) }),
    delete: async () => {
      deleted = true;
      return true;
    },
    revokeActiveTokens: async () => 0,
    insertEnrollmentToken: async (v: Record<string, unknown>) => ({ id: 'tok-1', ...v }),
    revokeToken: async (id: string) => void revoked.push(id),
  };
  const session = {
    hostKeyFp: 'SHA256:x',
    execStream: (command: string, opts: SshExecStreamOptions = {}) => {
      calls.push({ command, opts });
      return exec(command, opts);
    },
    end: () => {},
  };
  const ssh = { connect: connect ?? (async () => session) };
  const svc = new ServersService(
    repo as never,
    ssh as never,
    { get: async () => ({ privateKeyOpenSsh: 'KEY' }) } as never,
    { randomToken: () => TOKEN.slice(4), sha256Hex: (v: string) => `hash:${v}` } as never,
    { record: async (e: never) => void journal.push(e) } as never,
    {
      get: (k: string) =>
        ({
          PUBLIC_URL: 'https://panel.test',
          AGENT_PUBLIC_URL: agentPublicUrl,
          AGENT_REPO: 'feauche/nodeservice-agent',
        })[k],
    } as never,
    {} as never,
  );
  const installs = () => journal.filter((e) => e.action === 'server.agent.install');
  return { svc, row, journal, installs, revoked, calls };
}

/** Текст всего, что уходит наружу при неудаче: ответ интерфейсу и запись в Журнале. */
const outward = (err: unknown, ctx: ReturnType<typeof make>) =>
  `${errorText(err)}\n${JSON.stringify(ctx.installs())}`;

describe('ServersService: установка агента', () => {
  it('скрипт завершился с ошибкой: установка не засчитана, причина названа, токен отозван', async () => {
    const ctx = make('offline', async (_c, o) => {
      o.onData?.('→ скачиваю nodeservice-agent_linux_amd64 (latest)\n✗ не скачался бинарь\n');
      return { code: 1 };
    });
    const err = await ctx.svc.installAgent('s1').catch((e: unknown) => e);
    expect(errorText(err)).toBe(
      'Команда на сервере не выполнилась (установка агента): → скачиваю nodeservice-agent_linux_amd64 (latest)\n✗ не скачался бинарь',
    );
    // Статус вернулся к прежнему, а не остался «Ожидает агента».
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.installs()).toHaveLength(1);
    expect(ctx.installs()[0]).toMatchObject({ result: 'failed' });
    expect(String(ctx.installs()[0]?.metadata?.reason)).toContain('не скачался бинарь');
    expect(outward(err, ctx)).not.toContain(TOKEN);
    expect(ctx.revoked).toEqual(['tok-1']);
  });

  it('на установку даётся несколько минут; таймаут не раскрывает команду и токен, токен отзывается', async () => {
    const ctx = make('not_installed', async (command, o) => {
      // Как SshService: в ошибке — имя команды, если его дали, иначе её начало.
      throw serverProblems.sshCommand(o.label ?? command.slice(0, 60), 'таймаут 300 с');
    });
    const err = await ctx.svc.installAgent('s1').catch((e: unknown) => e);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]?.opts.timeoutMs).toBeGreaterThanOrEqual(3 * 60_000);
    expect(ctx.calls[0]?.command).toContain(`--token '${TOKEN}'`);
    expect(errorText(err)).toBe('Команда на сервере не выполнилась (установка агента): таймаут 300 с');
    for (const secret of [TOKEN, 'curl', 'install.sh', 'github'])
      expect(outward(err, ctx)).not.toContain(secret);
    expect(ctx.row.agentStatus).toBe('not_installed');
    expect(ctx.revoked).toEqual(['tok-1']);
  });

  it('панель не зашла на сервер: токен этой установки тоже отозван', async () => {
    const ctx = make(
      'offline',
      async () => ({ code: 0 }),
      async () => {
        throw serverProblems.sshUnreachable('203.0.113.5', 'таймаут');
      },
    );
    await expect(ctx.svc.installAgent('s1')).rejects.toMatchObject({ status: 502 });
    expect(ctx.row.agentStatus).toBe('offline');
    expect(ctx.revoked).toEqual(['tok-1']);
    expect(ctx.installs()).toHaveLength(1);
  });

  it('установка прошла: «Ожидает агента», токен действует, в Журнале — успех', async () => {
    const ctx = make('offline', async () => ({ code: 0 }));
    const dto = await ctx.svc.installAgent('s1');
    expect(dto.agentStatus).toBe('pending');
    expect(ctx.revoked).toEqual([]);
    expect(ctx.installs()).toHaveLength(1);
    expect(ctx.installs()[0]?.result).toBeUndefined();
    expect(JSON.stringify(ctx.journal)).not.toContain(TOKEN);
  });

  it('агент вышел на связь раньше, чем вернулась команда, — статус «в сети» не затирается', async () => {
    const ok = make('offline', async () => {
      ok.row.agentStatus = 'online';
      return { code: 0 };
    });
    expect((await ok.svc.installAgent('s1')).agentStatus).toBe('online');

    // И при неудаче: агент на связи — возвращать устаревшее «не в сети» нельзя.
    const failed = make('offline', async () => {
      failed.row.agentStatus = 'online';
      return { code: 1 };
    });
    await expect(failed.svc.installAgent('s1')).rejects.toBeDefined();
    expect(failed.row.agentStatus).toBe('online');
  });

  it('неудача поверх оборванной установки: «Агент устанавливается…» не остаётся висеть', async () => {
    const never = make('installing', async () => ({ code: 1 }));
    await expect(never.svc.installAgent('s1')).rejects.toBeDefined();
    expect(never.row.agentStatus).toBe('not_installed');
    // Агент когда-то был привязан — честнее «не в сети», чем «не установлен».
    const bound = make('installing', async () => ({ code: 1 }));
    bound.row.agentPubkey = 'pubkey';
    await expect(bound.svc.installAgent('s1')).rejects.toBeDefined();
    expect(bound.row.agentStatus).toBe('offline');
  });

  it('переустановка работавшего агента: прежний остановлен — ждём нового, а не показываем «в сети»', async () => {
    const ctx = make('online', async () => {
      // Скрипт остановил прежнего агента: шлюз отметил «не в сети».
      ctx.row.agentStatus = 'offline';
      return { code: 0 };
    });
    expect((await ctx.svc.installAgent('s1')).agentStatus).toBe('pending');
  });

  it('команда для ручной установки: скачивание в файл, привязка откладывается только после него', async () => {
    const ctx = make('not_installed', async () => ({ code: 0 }));
    const issued = await ctx.svc.issueEnrollmentToken('s1');
    expect(issued.token).toBe(TOKEN);
    expect(issued.installCommand).toBe(
      agentInstallCommand({ repo: 'feauche/nodeservice-agent', token: TOKEN, panel: 'https://panel.test' }),
    );
    const at = (piece: string) => issued.installCommand.indexOf(piece);
    expect(at('curl')).toBeGreaterThan(0);
    expect(at('curl')).toBeLessThan(at('mv -f "$S" "$S.prev"'));
    // Привязку не удаляем до скачивания: прежнего «rm -f …state.json» в начале команды больше нет.
    expect(issued.installCommand).not.toMatch(/rm -f \/var\/lib/);
  });

  it('отдельный внешний вход агентов используется при установке вместо адреса интерфейса', async () => {
    const ctx = make('not_installed', async () => ({ code: 0 }), undefined, 'https://agents.example.net');
    const issued = await ctx.svc.issueEnrollmentToken('s1');
    expect(issued.installCommand).toBe(
      agentInstallCommand({
        repo: 'feauche/nodeservice-agent',
        token: TOKEN,
        panel: 'https://agents.example.net',
      }),
    );
  });
});

describe('ServersService: удаление сервера', () => {
  it('слушатели узнают об удалении (шлюз закрывает соединение агента); их сбой удалению не мешает', async () => {
    const ctx = make('online', async () => ({ code: 0 }));
    const seen: string[] = [];
    ctx.svc.onDeleted(() => {
      throw new Error('сбой слушателя');
    });
    ctx.svc.onDeleted((id) => void seen.push(id));
    await ctx.svc.delete('s1');
    expect(seen).toEqual(['s1']);
    expect(ctx.journal.some((e) => e.action === 'server.deleted')).toBe(true);
  });
});

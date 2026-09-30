import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentGateway, CLOSE_SERVER_DELETED } from './agent.gateway.js';

type Denied = { action: string; target: { id: string }; metadata: { code: string; attempts: number } };

/** Шлюз без сети: Журнал — список, служба серверов запоминает слушателей удаления. */
function make() {
  const journal: Denied[] = [];
  const deleteListeners: Array<(id: string) => void> = [];
  const offline: string[] = [];
  const gateway = new AgentGateway(
    { markOffline: async (s: { id: string }) => void offline.push(s.id) } as never,
    {} as never,
    { record: async (e: Denied) => void journal.push(e) } as never,
    { onDeleted: (l: (id: string) => void) => void deleteListeners.push(l) } as never,
  );
  const inner = gateway as unknown as {
    authFailed: (code: string, serverId: string, name: string | null) => Promise<void>;
    active: Map<string, unknown>;
  };
  return { gateway, inner, journal, deleteListeners, offline };
}

describe('AgentGateway: отказы агентам в Журнале', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('агент стучится каждые 5 секунд — запись раз в час, в ней число попыток с прошлой записи', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-30T00:00:00Z') });
    const ctx = make();
    // Сутки перезапусков удалённого сервера: 17 280 попыток.
    for (let i = 0; i < 17_280; i += 1) {
      await ctx.inner.authFailed('unknown-server', 'srv-1', null);
      vi.advanceTimersByTime(5_000);
    }
    expect(ctx.journal).toHaveLength(24);
    expect(ctx.journal[0]?.metadata).toEqual({ code: 'unknown-server', attempts: 1 });
    expect(ctx.journal[1]?.metadata).toEqual({ code: 'unknown-server', attempts: 720 });
    expect(ctx.journal.reduce((n, e) => n + e.metadata.attempts, 0)).toBe(17_280 - 719);
  });

  it('серверы считаются порознь', async () => {
    const ctx = make();
    for (const id of ['a', 'b', 'a', 'b', 'a']) await ctx.inner.authFailed('auth-failed', id, id);
    expect(ctx.journal.map((e) => e.target.id)).toEqual(['a', 'b']);
  });

  it('поток выдуманных серверов не раздувает ни память, ни Журнал', async () => {
    const ctx = make();
    for (let i = 0; i < 5_000; i += 1) await ctx.inner.authFailed('unknown-server', `ghost-${i}`, null);
    // По отдельности помним 500 серверов, остальные делят одну запись в час.
    expect(ctx.journal).toHaveLength(501);
    expect((ctx.gateway as unknown as { authFailures: Map<string, unknown> }).authFailures.size).toBe(501);
  });
});

describe('AgentGateway: удаление сервера', () => {
  it('соединение агента закрывается с причиной и особым кодом; «пропал со связи» не пишется', () => {
    const ctx = make();
    ctx.gateway.onModuleInit();
    const sent: string[] = [];
    const closed: Array<[number, string]> = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => void sent.push(raw),
      close: (code: number, reason: string) => void closed.push([code, reason]),
    };
    ctx.inner.active.set('srv-1', ws);
    // Удаление чужого сервера это соединение не трогает.
    for (const l of ctx.deleteListeners) l('srv-2');
    expect(closed).toEqual([]);

    for (const l of ctx.deleteListeners) l('srv-1');
    expect(closed).toEqual([[CLOSE_SERVER_DELETED, 'server deleted']]);
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      type: 'error',
      payload: { code: 'unknown-server', message: 'Сервер удалён из панели' },
    });
    expect(ctx.inner.active.has('srv-1')).toBe(false);
    expect(ctx.offline).toEqual([]);
    // Повторное удаление (соединения уже нет) — тихо.
    for (const l of ctx.deleteListeners) l('srv-1');
    expect(closed).toHaveLength(1);
  });
});

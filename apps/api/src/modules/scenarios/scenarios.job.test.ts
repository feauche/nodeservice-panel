import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameHost, ScenariosJob } from './scenarios.job.js';

const node = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Нода',
  address: '8.8.8.8',
  isConnected: false,
  isDisabled: false,
};
const rule = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Скрыть при потере связи',
  scope: 'all' as const,
  enabled: true,
  nodes: [],
  trigger: 'offline' as const,
  holdMinutes: 5,
  conditions: [],
  conditionMode: 'all' as const,
  actions: ['hide_host'] as ['hide_host'],
  renameMode: 'append' as const,
  renameText: '',
  hostBindings: [],
  autoRestore: true,
  cooldownMinutes: 30,
};
function fixture(
  host?: Record<string, unknown>,
  links?: string[],
  opts: {
    /** Ответ Remnawave на PATCH: код и как она сохраняет тело (например, обрезает пробелы в имени). */
    patchStatus?: number;
    patchApply?: (body: Record<string, unknown>) => Record<string, unknown>;
    incident?: { id: string; title: string } | null;
  } = {},
) {
  const data = new Map<string, unknown>();
  let rules = [{ ...rule }],
    current = {
      domain: 'panel.test',
      error: null,
      checkedAt: new Date().toISOString(),
      nodes: [{ ...node }],
    };
  let h = host ?? { uuid: 'host', nodes: [node.uuid], isDisabled: false, updatedAt: 'v1', remark: 'Host' };
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (opts.patchStatus && opts.patchStatus >= 400)
          return new Response(JSON.stringify({ message: 'Forbidden' }), { status: opts.patchStatus });
        h = { ...h, ...(opts.patchApply ? opts.patchApply(body) : body), updatedAt: `v${calls.length + 1}` };
        return new Response(JSON.stringify({ response: h }));
      }
      return new Response(JSON.stringify({ response: [h] }));
    }),
  );
  const store = {
    scope: () => 'scope',
    list: async () => rules,
    read: async (k: string) => data.get(k) ?? null,
    write: async (k: string, v: unknown) => {
      data.set(k, structuredClone(v));
    },
    remove: async (k: string) => {
      data.delete(k);
    },
  };
  const permissions = {
    observe: vi.fn(async (_scope: string, _c: unknown, action: () => Promise<unknown>) => action()),
  };
  const incidents = {
    forNode: vi.fn(async () => opts.incident ?? null),
    note: vi.fn(async () => {}),
  };
  const events = { append: vi.fn() },
    notify = { push: vi.fn() },
    tcp = { checkNode: vi.fn() };
  const job = new ScenariosJob(
    { execute: async () => ({ rows: [] }) } as never,
    store as never,
    { status: async () => current } as never,
    { credentials: async () => ({ domain: 'panel.test', apiKey: 'secret' }) } as never,
    {
      get: async () => ({
        enabled: true,
        staleAfterMinutes: 5,
        recoverySamples: 3,
        checkHostEnabled: true,
        checkHostPort: 5492,
        checkHostCooldownMinutes: 15,
      }),
    } as never,
    tcp as never,
    events as never,
    notify as never,
    links ? ({ get: async () => ({ hosts: [{ id: 'host', nodeUuids: links }] }) } as never) : undefined,
    permissions as never,
    incidents as never,
  );
  return {
    job,
    permissions,
    incidents,
    store,
    data,
    events,
    notify,
    tcp,
    calls,
    getHost: () => h,
    setHost: (v: Record<string, unknown>) => {
      h = v;
    },
    current,
    setRules: (r: typeof rules) => {
      rules = r;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('Сценарии: реальные правила владения Host', () => {
  it('не включает выключенный сценарий и не выполняет сеть', async () => {
    const f = fixture();
    f.setRules([{ ...rule, enabled: false }]);
    await f.job.run();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('общий Host нескольких нод не скрывается', async () => {
    const f = fixture({ uuid: 'host', nodes: [node.uuid, 'another'], isDisabled: false });
    expect(await f.job.hide('panel.test', 'scope', rule as never, node as never)).toContain(
      'общих Host пропущено: 1',
    );
    expect(f.calls).toEqual([]);
  });
  it('общий профиль не мешает уникальной связи по адресу из топологии', async () => {
    const f = fixture(
      { uuid: 'host', nodes: [], inbound: { configProfileUuid: 'shared' }, isDisabled: false },
      [node.uuid],
    );
    await f.job.hide('panel.test', 'scope', rule as never, node as never);
    expect(f.calls).toEqual([{ uuid: 'host', isDisabled: true }]);
    expect((await f.job.previewHosts()).hosts[0].nodes).toEqual([node.uuid]);
  });
  it('общий профиль без уникальной связи не изменяет Host', async () => {
    const f = fixture({
      uuid: 'host',
      nodes: [],
      inbound: { configProfileUuid: 'shared' },
      isDisabled: false,
    });
    await f.job.hide('panel.test', 'scope', rule as never, node as never);
    expect(f.calls).toEqual([]);
  });
  it('неоднозначный профиль разрешается явной привязкой Host к ноде сценария', async () => {
    const f = fixture({ uuid: 'host', nodes: [], isDisabled: false });
    const r = { ...rule, hostBindings: [{ hostUuid: 'host', nodeUuid: node.uuid }] };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    expect(f.calls).toEqual([{ uuid: 'host', isDisabled: true }]);
  });
  it('ручная привязка не переопределяет явный общий Host', async () => {
    const f = fixture({ uuid: 'host', nodes: [node.uuid, 'another'], isDisabled: false });
    const r = { ...rule, hostBindings: [{ hostUuid: 'host', nodeUuid: node.uuid }] };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    expect(f.calls).toEqual([]);
  });
  it('восстановившаяся нода не вызывает изменение Host', async () => {
    const f = fixture();
    f.current.nodes[0].isConnected = true;
    await expect(f.job.hide('panel.test', 'scope', rule as never, node as never)).rejects.toThrow('Условия');
    expect(f.calls).toEqual([]);
  });
  it('скрывает только включённый Host и восстанавливает только собственный неизменённый', async () => {
    const f = fixture();
    await f.job.hide('panel.test', 'scope', rule as never, node as never);
    expect(f.calls).toEqual([{ uuid: 'host', isDisabled: true }]);
    f.current.nodes[0].isConnected = true;
    await f.job.restore('panel.test', 'scope', rule as never, node as never);
    expect(f.calls.at(-1)).toEqual({ uuid: 'host', isDisabled: false });
  });
  it('ручное изменение Host запрещает автоматическое восстановление', async () => {
    const f = fixture();
    await f.job.hide('panel.test', 'scope', rule as never, node as never);
    f.current.nodes[0].isConnected = true;
    f.setHost({ ...f.getHost(), updatedAt: 'manual-change' });
    await f.job.restore('panel.test', 'scope', rule as never, node as never);
    expect(f.calls).toHaveLength(1);
  });
  it('изначально выключенный Host не принадлежит сценарию', async () => {
    const f = fixture({ uuid: 'host', nodes: [node.uuid], isDisabled: true, updatedAt: 'v1' });
    await f.job.hide('panel.test', 'scope', rule as never, node as never);
    expect(f.calls).toEqual([]);
    expect(f.data.size).toBe(0);
  });
  it('не скрывает Host после выключения правила перед действием', async () => {
    const f = fixture();
    f.setRules([{ ...rule, enabled: false }]);
    await expect(f.job.hide('panel.test', 'scope', rule as never, node as never)).rejects.toThrow(
      'изменились',
    );
    expect(f.calls).toEqual([]);
  });
  it('после неоднозначного PATCH автоматическое восстановление запрещено', async () => {
    const f = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') throw new Error('timeout');
        return new Response(JSON.stringify({ response: [f.getHost()] }));
      }),
    );
    await expect(f.job.hide('panel.test', 'scope', rule as never, node as never)).rejects.toThrow();
    f.current.nodes[0].isConnected = true;
    await f.job.restore('panel.test', 'scope', rule as never, node as never);
    expect(f.calls).toEqual([]);
  });
  it('пять минут устойчивого условия, один запуск на сбой, без повторного PATCH', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture();
    await f.job.run();
    expect(f.calls).toEqual([]);
    for (let i = 1; i <= 6; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
    expect(f.calls).toHaveLength(1);
    vi.setSystemTime(start + 601000);
    f.current.checkedAt = new Date().toISOString();
    await f.job.run();
    expect(f.calls).toHaveLength(1);
  });
  it('И: потеря связи + TCP недоступен проверяется без прежнего инцидента и не дублирует запросы', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture();
    const r = { ...rule, conditions: ['offline', 'tcp_unreachable'], conditionMode: 'all' };
    f.setRules([r as never]);
    f.tcp.checkNode.mockResolvedValue({
      verdict: 'port_unreachable',
      checkedAt: new Date(start).toISOString(),
      target: '198.51.100.9:5492',
      link: null,
      observations: [],
      error: null,
    });
    for (let i = 0; i <= 6; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
    expect(f.tcp.checkNode).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(1);
    expect(f.events.append).toHaveBeenCalledWith(
      'panel.test',
      expect.objectContaining({ type: 'tcp_check' }),
    );
  });
  it('неполный TCP не подтверждает условие', async () => {
    const f = fixture();
    const r = { ...rule, conditions: ['tcp_unreachable'], conditionMode: 'all' };
    f.setRules([r as never]);
    f.tcp.checkNode.mockResolvedValue({
      verdict: 'unknown',
      checkedAt: new Date().toISOString(),
      target: '198.51.100.9:5492',
      link: null,
      observations: [],
      error: null,
    });
    await f.job.run();
    expect(f.calls).toEqual([]);
    expect(f.tcp.checkNode).toHaveBeenCalledTimes(1);
  });
  it('пропуск наблюдений сбрасывает время подтверждения', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture();
    await f.job.run();
    vi.setSystemTime(start + 600000);
    f.current.checkedAt = new Date().toISOString();
    await f.job.run();
    expect(f.calls).toEqual([]);
  });
  it('восстановление ожидает три свежих здоровых снимка', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture();
    await f.job.run();
    for (let i = 1; i <= 6; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
    expect(f.calls).toHaveLength(1);
    f.current.nodes[0].isConnected = true;
    for (let i = 7; i <= 8; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
      expect(f.calls).toHaveLength(1);
    }
    vi.setSystemTime(start + 9 * 60000);
    f.current.checkedAt = new Date().toISOString();
    await f.job.run();
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    ['replace', '🇩🇪 Нода', 'Резерв', ' Резерв '],
    ['prepend', '🇩🇪 Нода', '🔴', '🇩🇪 🔴 Нода'],
    ['prepend', 'Нода', '🔴', ' 🔴 Нода'],
    ['append', '🇩🇪 Нода', '🔴', '🇩🇪 Нода 🔴 '],
  ])('имя Host: %s', (mode, name, text, result) =>
    expect(renameHost(name, mode as 'replace' | 'prepend' | 'append', text)).toBe(result),
  );
  it('изменение имени и скрытие одним PATCH; откат обоих исходных параметров', async () => {
    const f = fixture();
    const r = {
      ...rule,
      actions: ['rename_host', 'hide_host'] as ['rename_host', 'hide_host'],
      renameText: '🔴',
    };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    expect(f.calls[0]).toEqual({ uuid: 'host', isDisabled: true, remark: 'Host 🔴 ' });
    f.current.nodes[0].isConnected = true;
    await f.job.restore('panel.test', 'scope', r as never, node as never);
    expect(f.calls[1]).toEqual({ uuid: 'host', isDisabled: false, remark: 'Host' });
  });
  it('нет права изменять Host: понятная причина, Host не заблокирован, отказ отмечен у права ключа', async () => {
    const f = fixture(undefined, undefined, { patchStatus: 403 });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '⚠️' };
    f.setRules([r as never]);
    await expect(f.job.hide('panel.test', 'scope', r as never, node as never)).rejects.toThrow(
      'нет права «Изменение Host»',
    );
    expect(f.permissions.observe).toHaveBeenCalledWith(
      'hosts:update',
      expect.anything(),
      expect.any(Function),
    );
    // Отказ — изменение точно не применено: запись о владении снята, «не подтверждено» не висит.
    expect([...f.data.keys()].filter((k) => k.startsWith('scenarios.host.'))).toEqual([]);
    expect((await f.job.previewHosts()).hosts[0].restoration).toBeNull();
  });
  it('неподтверждённая попытка, после которой Host не изменился, не мешает следующей', async () => {
    const f = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') throw new Error('timeout');
        return new Response(JSON.stringify({ response: [f.getHost()] }));
      }),
    );
    await expect(f.job.hide('panel.test', 'scope', rule as never, node as never)).rejects.toThrow();
    expect((await f.job.previewHosts()).hosts[0].restoration).toBeNull();
    const g = fixture();
    for (const [k, v] of f.data) g.data.set(k, v);
    await g.job.hide('panel.test', 'scope', rule as never, node as never);
    expect(g.calls).toEqual([{ uuid: 'host', isDisabled: true }]);
  });
  it('новое имя длиннее 100 знаков — понятная причина и ни одного запроса на изменение', async () => {
    const f = fixture({
      uuid: 'host',
      nodes: [node.uuid],
      isDisabled: false,
      updatedAt: 'v1',
      remark: 'Х'.repeat(98),
    });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '⚠️' };
    f.setRules([r as never]);
    await expect(f.job.hide('panel.test', 'scope', r as never, node as never)).rejects.toThrow(
      'длиннее 100 знаков',
    );
    expect(f.calls).toEqual([]);
  });
  it('переименование передаёт «выключен» как есть: выключенный Host не включится', async () => {
    const f = fixture({
      uuid: 'host',
      nodes: [node.uuid],
      isDisabled: true,
      updatedAt: 'v1',
      remark: 'Host',
    });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '🔴' };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    expect(f.calls).toEqual([{ uuid: 'host', isDisabled: true, remark: 'Host 🔴 ' }]);
  });
  it('Remnawave не отдаёт версию Host: имя возвращается, если его не трогали, итог — в событии ноды', async () => {
    const incident = { id: 'inc-1', title: 'Нода не на связи · {server}' };
    const f = fixture({ uuid: 'host', nodes: [node.uuid], isDisabled: false, remark: 'Host' }, undefined, {
      incident,
    });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '⚠️' };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    expect(f.getHost().remark).toBe('Host ⚠️ ');
    f.current.nodes[0].isConnected = true;
    expect(await f.job.restore('panel.test', 'scope', r as never, node as never)).toBe('done');
    expect(f.calls.at(-1)).toEqual({ uuid: 'host', isDisabled: false, remark: 'Host' });
    expect(f.incidents.note).toHaveBeenLastCalledWith(
      'inc-1',
      'Сценарий «Скрыть при потере связи»: Host «Host» возвращён после восстановления ноды',
      'helped',
    );
  });
  it('имя изменили вручную после сценария — не возвращаем и говорим об этом в событии', async () => {
    const f = fixture({ uuid: 'host', nodes: [node.uuid], isDisabled: false, remark: 'Host' }, undefined, {
      incident: { id: 'inc-1', title: 'Нода не на связи' },
    });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '⚠️' };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    f.setHost({ ...f.getHost(), remark: 'Своё имя' });
    f.current.nodes[0].isConnected = true;
    await f.job.restore('panel.test', 'scope', r as never, node as never);
    expect(f.calls).toHaveLength(1);
    expect(f.incidents.note).toHaveBeenLastCalledWith(
      'inc-1',
      expect.stringContaining('не возвращён: после сценария его изменили вручную'),
      'failed',
    );
  });
  it('Host уже вернули вручную — запросов нет, в событии «уже в исходном виде»', async () => {
    const f = fixture({ uuid: 'host', nodes: [node.uuid], isDisabled: false, remark: 'Host' }, undefined, {
      incident: { id: 'inc-1', title: 'Нода не на связи' },
    });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '⚠️' };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    f.setHost({ ...f.getHost(), remark: 'Host' });
    f.current.nodes[0].isConnected = true;
    await f.job.restore('panel.test', 'scope', r as never, node as never);
    expect(f.calls).toHaveLength(1);
    expect(f.incidents.note).toHaveBeenLastCalledWith(
      'inc-1',
      'Сценарий «Скрыть при потере связи»: Host «Host» уже в исходном виде — его вернули вручную',
      'helped',
    );
  });
  it('возврат выключен в сценарии — в событии строка, что Host остаётся изменённым', async () => {
    const f = fixture(undefined, undefined, { incident: { id: 'inc-1', title: 'Нода не на связи' } });
    const r = { ...rule, autoRestore: false };
    f.setRules([r as never]);
    await f.job.hide('panel.test', 'scope', r as never, node as never);
    f.current.nodes[0].isConnected = true;
    await f.job.restore('panel.test', 'scope', r as never, node as never);
    expect(f.calls).toHaveLength(1);
    expect(f.incidents.note).toHaveBeenLastCalledWith(
      'inc-1',
      expect.stringContaining('остаётся изменённым: возврат выключен в сценарии'),
      'failed',
    );
  });
  it('Remnawave не ответила на возврат — попытка повторяется на следующем опросе', async () => {
    const f = fixture();
    await f.job.hide('panel.test', 'scope', rule as never, node as never);
    f.current.nodes[0].isConnected = true;
    const ok = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') throw new Error('timeout');
        return (ok as typeof fetch)(u, init);
      }),
    );
    expect(await f.job.restore('panel.test', 'scope', rule as never, node as never)).toBe('retry');
    vi.stubGlobal('fetch', ok);
    expect(await f.job.restore('panel.test', 'scope', rule as never, node as never)).toBe('done');
    expect(f.calls.at(-1)).toEqual({ uuid: 'host', isDisabled: false });
  });
  it('Remnawave обрезает пробелы в имени — изменение всё равно подтверждено', async () => {
    const f = fixture(undefined, undefined, {
      patchApply: (b) => (typeof b.remark === 'string' ? { ...b, remark: b.remark.trim() } : b),
    });
    const r = { ...rule, actions: ['rename_host'] as ['rename_host'], renameText: '⚠️' };
    f.setRules([r as never]);
    expect(await f.job.hide('panel.test', 'scope', r as never, node as never)).toBe(
      'Изменено имя Host: «Host» → «Host ⚠️»',
    );
    expect(f.getHost().remark).toBe('Host ⚠️');
  });
  it('«Записать событие» дописывает срабатывание и итог в открытое событие ноды', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture(undefined, undefined, {
      incident: { id: 'inc-1', title: 'Нода не на связи · {server}' },
    });
    const r = { ...rule, actions: ['record_event', 'hide_host'] as ['record_event', 'hide_host'] };
    f.setRules([r as never]);
    for (let i = 0; i <= 6; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
    expect(f.incidents.note).toHaveBeenCalledTimes(1);
    expect(f.incidents.note).toHaveBeenCalledWith(
      'inc-1',
      'Сценарий «Скрыть при потере связи»: записано в событие «Нода не на связи»; Скрыто Host: «Host»',
      'applied',
    );
  });
});

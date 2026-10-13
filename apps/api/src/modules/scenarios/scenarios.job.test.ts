import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameHost, ScenariosJob, telegramStepLine } from './scenarios.job.js';

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
    /** Уйдёт ли сообщение в Telegram сейчас (TelegramService.outlook). */
    telegram?: 'send' | 'quiet' | 'off' | 'event_off';
  } = {},
) {
  const data = new Map<string, unknown>();
  /** Открытые события нод, как их видит сценарий (node_uuid, kind). */
  let incidentRows: Array<{ node_uuid: string; kind: string }> = [];
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
    addRun: vi.fn(async () => {}),
  };
  const permissions = {
    observe: vi.fn(async (_scope: string, _c: unknown, action: () => Promise<unknown>) => action()),
  };
  const incidents = {
    forNode: vi.fn(async () => opts.incident ?? null),
    note: vi.fn(async () => {}),
  };
  const events = { append: vi.fn() },
    notify = { push: vi.fn(), telegramOutlook: vi.fn(async () => opts.telegram ?? 'send') },
    tcp = { checkNode: vi.fn() };
  const job = new ScenariosJob(
    { execute: async () => ({ rows: incidentRows }) } as never,
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
    setIncidents: (rows: typeof incidentRows) => {
      incidentRows = rows;
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
  describe('«Частично недоступен из РФ» в условии «TCP недоступен»', () => {
    /** Сценарий «TCP недоступен» прогоняется 6 минут (держится 5); проверка порта отдаёт `report`. */
    async function runPartial(report: Record<string, unknown>, onlineDrop: boolean) {
      vi.useFakeTimers();
      const start = Date.parse('2026-10-12T00:00:00Z');
      vi.setSystemTime(start);
      const f = fixture();
      f.setRules([{ ...rule, conditions: ['tcp_unreachable'], conditionMode: 'all' } as never]);
      if (onlineDrop) f.setIncidents([{ node_uuid: node.uuid, kind: 'node_blocked' }]);
      f.tcp.checkNode.mockResolvedValue({
        checkedAt: new Date(start).toISOString(),
        target: '198.51.100.9:5492',
        link: null,
        observations: [],
        error: null,
        ...report,
      });
      for (let i = 0; i <= 6; i++) {
        vi.setSystemTime(start + i * 60000);
        f.current.checkedAt = new Date().toISOString();
        await f.job.run();
        await f.job.idle();
      }
      return f;
    }
    it('подтверждён повтором и онлайн упал — условие срабатывает', async () => {
      const f = await runPartial({ verdict: 'russia_partial', confirmed: true }, true);
      expect(f.calls).toHaveLength(1);
    });
    it('без падения онлайна — не срабатывает: сбойная точка Check-Host в РФ сама сценарий не запускает', async () => {
      const f = await runPartial({ verdict: 'russia_partial', confirmed: true }, false);
      expect(f.calls).toEqual([]);
    });
    it('без повтора — не срабатывает даже при падении онлайна', async () => {
      const f = await runPartial({ verdict: 'russia_partial' }, true);
      expect(f.calls).toEqual([]);
    });
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
    expect(f.store.addRun).toHaveBeenLastCalledWith(
      'panel.test',
      expect.objectContaining({
        kind: 'restore',
        failed: false,
        steps: [expect.objectContaining({ tone: 'ok', word: 'вернули', detail: '«Host»' })],
      }),
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
    // Возврат выключен намеренно — это не сбой: в журнале жёлтым «не возвращали», а не красным.
    expect(f.store.addRun).toHaveBeenLastCalledWith(
      'panel.test',
      expect.objectContaining({
        kind: 'restore',
        steps: [expect.objectContaining({ tone: 'warn', word: 'не возвращали' })],
      }),
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
  it('каждое срабатывание попадает в журнал: шаги с итогом и уведомление в Telegram', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture(undefined, undefined, { incident: { id: 'inc-1', title: 'Нода не на связи' } });
    const r = {
      ...rule,
      holdMinutes: 1,
      actions: ['record_event', 'hide_host', 'notify'] as ['record_event', 'hide_host', 'notify'],
    };
    f.setRules([r as never]);
    for (let i = 0; i <= 3; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
    expect(f.store.addRun).toHaveBeenCalledTimes(1);
    expect(f.store.addRun).toHaveBeenCalledWith(
      'panel.test',
      expect.objectContaining({
        kind: 'run',
        ruleName: 'Скрыть при потере связи',
        title: 'Сработал: нода потеряла связь, 1 мин',
        failed: false,
        condition: 'нода потеряла связь',
        holdMinutes: 1,
        steps: [
          {
            action: 'record_event',
            n: 1,
            tone: 'info',
            word: 'записано',
            detail: 'в «Нода не на связи»',
            incidentId: 'inc-1',
            text: 'Записано в событие «Нода не на связи»',
          },
          {
            action: 'hide_host',
            n: 2,
            tone: 'change',
            word: 'скрыт',
            detail: '«Host»',
            text: 'Скрыт Host: «Host»',
          },
          { action: 'notify', n: 3, tone: 'info', word: 'отправлено', text: 'Уведомление в Telegram' },
        ],
      }),
    );
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
      'Сценарий «Скрыть при потере связи»: записано в событие «Нода не на связи»; Скрыт Host: «Host»',
      'applied',
    );
  });
  /** Сработать один раз: условие держится минуту, опросы раз в минуту. */
  async function fire(f: ReturnType<typeof fixture>, actions: string[], extra: Record<string, unknown> = {}) {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    f.setRules([{ ...rule, holdMinutes: 1, renameText: '⚠️', actions, ...extra } as never]);
    for (let i = 0; i <= 2; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
    return (
      f.store.addRun.mock.calls.at(-1) as unknown as [string, { steps: Array<Record<string, unknown>> }]
    )[1];
  }
  it('шаг не вышел: красный «не вышло» с причиной, следующие шаги «не выполнялся», уведомление всё равно', async () => {
    const f = fixture(undefined, undefined, { patchStatus: 403 });
    const run = await fire(f, ['rename_host', 'hide_host', 'record_event', 'notify']);
    expect(run).toMatchObject({ failed: true });
    expect(run.steps.map((x) => [x.n, x.word])).toEqual([
      [1, 'не вышло'],
      [2, 'не выполнялся'],
      [3, 'не выполнялся'],
      [4, 'отправлено'],
    ]);
    expect(run.steps[0]).toMatchObject({ action: 'rename_host', tone: 'crit', failed: true });
    expect(run.steps[1]).toMatchObject({ action: 'hide_host', skipped: true, detail: 'шаг 1 не вышел' });
  });
  it('«Уведомить в Telegram» не пишет «отправлено», если Telegram не подключён или тихие часы', async () => {
    const off = await fire(fixture(undefined, undefined, { telegram: 'off' }), ['hide_host', 'notify']);
    expect(off.steps.at(-1)).toMatchObject({
      action: 'notify',
      tone: 'warn',
      word: 'не отправлено',
      detail: 'Telegram не подключён — добавьте чат в «Настройки → Уведомления»',
    });
    const quiet = await fire(fixture(undefined, undefined, { telegram: 'quiet' }), ['hide_host', 'notify']);
    expect(quiet.steps.at(-1)).toMatchObject({
      word: 'отложено',
      detail: 'тихие часы — придёт в утренней сводке',
    });
  });
  it('скрытие и новое имя одним изменением — в журнале два шага со своими номерами', async () => {
    const f = fixture();
    const run = await fire(f, ['hide_host', 'rename_host']);
    expect(run.steps).toEqual([
      expect.objectContaining({ action: 'hide_host', n: 1, word: 'скрыт', detail: '«Host»' }),
      expect.objectContaining({ action: 'rename_host', n: 2, word: 'изменено', detail: '«Host» → «Host ⚠️»' }),
    ]);
  });
  it('у ноды нет своих Host — «не скрыт» и почему, жёлтым', async () => {
    const f = fixture({ uuid: 'host', nodes: [node.uuid, 'another'], isDisabled: false, remark: 'Host' });
    const run = await fire(f, ['hide_host']);
    expect(run.steps).toEqual([
      expect.objectContaining({
        word: 'не скрыт',
        tone: 'warn',
        detail: 'у ноды только общие Host (1) — их не трогаем',
      }),
    ]);
  });
  /** Опросы раз в минуту с i-й по j-ю минуту от start. */
  async function polls(f: ReturnType<typeof fixture>, start: number, from: number, to: number) {
    for (let i = from; i <= to; i++) {
      vi.setSystemTime(start + i * 60000);
      f.current.checkedAt = new Date().toISOString();
      await f.job.run();
    }
  }
  it('Host возвращается по своим здоровым опросам, не дожидаясь закрытия «нода не на связи»; при падении онлайна — ждёт', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    const f = fixture();
    await polls(f, start, 0, 6);
    expect(f.calls).toHaveLength(1);
    f.current.nodes[0].isConnected = true;
    // Событие «нода не на связи» ещё открыто — его закроет мониторинг своими опросами; Host ждать его не должен.
    f.setIncidents([{ node_uuid: node.uuid, kind: 'node_down' }]);
    await polls(f, start, 7, 8);
    expect(f.calls).toHaveLength(1);
    await polls(f, start, 9, 9);
    expect(f.calls).toHaveLength(2);

    const g = fixture();
    await polls(g, start, 0, 6);
    g.current.nodes[0].isConnected = true;
    // Нода на связи, но открыто падение онлайна: пользователей обратно не отправляем.
    g.setIncidents([{ node_uuid: node.uuid, kind: 'node_blocked' }]);
    await polls(g, start, 7, 11);
    expect(g.calls).toHaveLength(1);
    g.setIncidents([]);
    await polls(g, start, 12, 14);
    expect(g.calls).toHaveLength(2);
  });
  it('проверка порта не задерживает смену Host; не вышла — замечание, остальные шаги выполнены', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    const f = fixture();
    let release: (v: unknown) => void = () => undefined;
    f.tcp.checkNode.mockImplementation(() => new Promise((r) => (release = r)));
    f.setRules([
      { ...rule, holdMinutes: 1, renameText: '⚠️', actions: ['check_tcp', 'rename_host', 'notify'] } as never,
    ]);
    await polls(f, start, 0, 2);
    // Check-Host ещё отвечает, а имя Host уже изменено; журнал и сообщение дождутся проверки.
    expect(f.calls).toHaveLength(1);
    expect(f.store.addRun).not.toHaveBeenCalled();
    release({
      verdict: 'reachable',
      checkedAt: new Date().toISOString(),
      target: '8.8.8.8:5492',
      link: null,
      observations: [],
      error: null,
    });
    await f.job.idle();
    const run = (
      f.store.addRun.mock.calls.at(-1) as unknown as [
        string,
        { steps: Array<Record<string, unknown>>; failed: boolean },
      ]
    )[1];
    expect(run.steps.map((x) => [x.n, x.action])).toEqual([
      [1, 'check_tcp'],
      [2, 'rename_host'],
      [3, 'notify'],
    ]);
    expect(run.steps[0]).toMatchObject({ tone: 'ok' });
    // Сообщение в Telegram (витрина telegram-2026-10, сценарий A): условие, строка на шаг со значком итога,
    // таблица портов — из той же проверки; строки «Нода: …» нет — нода под заголовком.
    const sent = f.notify.push.mock.calls.at(-1)?.[0] as unknown as {
      body: string;
      telegram: { ports: unknown };
    };
    const lines = sent.body.split('\n');
    expect(lines[0]).toMatch(/^Условие: /);
    expect(lines.slice(1, 3)).toEqual(['', '✅ TCP: доступен']);
    expect(lines[3]).toMatch(/^✅ Имя Host: «Host» → «Host.*⚠️»$/);
    expect(lines).toHaveLength(4);
    expect(sent.telegram.ports).toMatchObject({ verdict: 'reachable', target: '8.8.8.8:5492' });

    const g = fixture();
    g.tcp.checkNode.mockRejectedValue(new Error('Check-Host не ответил'));
    g.setRules([
      { ...rule, holdMinutes: 1, renameText: '⚠️', actions: ['check_tcp', 'rename_host'] } as never,
    ]);
    await polls(g, start, 0, 2);
    await g.job.idle();
    expect(g.calls).toHaveLength(1);
    const failed = (
      g.store.addRun.mock.calls.at(-1) as unknown as [
        string,
        { steps: Array<Record<string, unknown>>; failed: boolean },
      ]
    )[1];
    expect(failed.failed).toBe(false);
    expect(failed.steps[0]).toMatchObject({
      action: 'check_tcp',
      tone: 'warn',
      word: 'не проверили',
      detail: 'Check-Host не ответил',
    });
    expect(failed.steps[1]).toMatchObject({ action: 'rename_host', word: 'изменено' });
  });
  it('условие «TCP недоступен» проверяется в фоне: сценарии не ждут Check-Host', async () => {
    const f = fixture();
    f.setRules([{ ...rule, conditions: ['tcp_unreachable'], conditionMode: 'all' } as never]);
    f.tcp.checkNode.mockImplementation(() => new Promise(() => undefined));
    // Проверка не закончится никогда — проход всё равно завершается.
    await f.job.run();
    expect(f.tcp.checkNode).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([]);
  });
  it('устаревшая проверка порта действует, пока новая идёт в фоне: отсчёт «держится» не сбрасывается', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-12T00:00:00Z');
    vi.setSystemTime(start);
    const f = fixture();
    f.setRules([
      { ...rule, conditions: ['offline', 'tcp_unreachable'], conditionMode: 'all', holdMinutes: 10 } as never,
    ]);
    // Проверка была 20 минут назад (запас — 15): устарела, но тот же адрес и порт.
    f.data.set(`scenarios.tcp.scope.${node.uuid}`, {
      target: `${node.address}:5492:`,
      report: {
        verdict: 'port_unreachable',
        checkedAt: new Date(start - 20 * 60000).toISOString(),
        target: `${node.address}:5492`,
        link: null,
        observations: [],
        error: null,
      },
    });
    f.data.set(`scenarios.state.scope.${rule.id}.${node.uuid}`, {
      since: start - 9 * 60000,
      stamp: start - 15000,
      latched: false,
      lastRun: 0,
    });
    f.tcp.checkNode.mockImplementation(() => new Promise(() => undefined));
    await f.job.run();
    // Новая проверка ушла в фон, а отсчёт «держится» (9 минут из 10) сохранился.
    expect(f.tcp.checkNode).toHaveBeenCalledTimes(1);
    expect((f.data.get(`scenarios.state.scope.${rule.id}.${node.uuid}`) as { since: number }).since).toBe(
      start - 9 * 60000,
    );
  });
});

describe('строка шага в сообщении Telegram', () => {
  const report = (verdict: string) =>
    ({ verdict, checkedAt: '', target: '8.8.8.8:5492', link: null, observations: [], error: null }) as never;
  it('значок по итогу: сделано, замечание, не вышло; TCP — по выводу проверки', () => {
    expect(
      telegramStepLine(
        { action: 'check_tcp', n: 1, tone: 'crit', word: 'частично недоступен из РФ', text: '' },
        report('russia_partial'),
      ),
    ).toBe('🟠 TCP: частично недоступен из РФ');
    expect(
      telegramStepLine(
        {
          action: 'check_tcp',
          n: 1,
          tone: 'warn',
          word: 'не проверили',
          text: 'TCP не проверили: Check-Host не ответил',
        },
        null,
      ),
    ).toBe('🟠 TCP не проверили: Check-Host не ответил');
    expect(
      telegramStepLine(
        {
          action: 'rename_host',
          n: 2,
          tone: 'crit',
          failed: true,
          word: 'не вышло',
          detail: 'у ключа Remnawave нет права «Изменение Host»',
          text: 'у ключа Remnawave нет права «Изменение Host»',
        },
        null,
      ),
    ).toBe('❌ Имя Host не изменено: у ключа Remnawave нет права «Изменение Host»');
    expect(
      telegramStepLine(
        {
          action: 'rename_host',
          n: 2,
          tone: 'info',
          word: 'не изменено',
          text: 'Имя Host не изменено: метка уже есть в имени',
        },
        null,
      ),
    ).toBe('🟠 Имя Host не изменено: метка уже есть в имени');
    expect(
      telegramStepLine(
        {
          action: 'record_event',
          n: 3,
          tone: 'info',
          word: 'события нет',
          text: 'Открытого события у ноды нет — запись только в «Метриках»',
        },
        null,
      ),
    ).toBe('🟠 Открытого события у ноды нет — запись только в «Метриках»');
    expect(
      telegramStepLine(
        { action: 'notify', n: 4, tone: 'info', word: 'отправлено', text: 'Уведомление в Telegram' },
        null,
      ),
    ).toBeNull();
    expect(
      telegramStepLine(
        { action: 'hide_host', n: 5, tone: 'info', skipped: true, word: 'не выполнялся', text: '' },
        null,
      ),
    ).toBeNull();
  });
});

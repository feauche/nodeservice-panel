import { HttpException } from '@nestjs/common';
import { type AssistantChange, DEFAULT_SERVER_PROFILE, type Server } from '@nodeservice/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AssistantChangeRow } from '../../../infra/db/schema/index.js';
import { ChangesService } from './changes.service.js';

const SRV = '0192c000-0000-7000-8000-0000000000a1';
const OTHER = '0192c000-0000-7000-8000-0000000000a2';
const PROV_A = '0192c000-0000-7000-8000-0000000000b1';
const PROV_B = '0192c000-0000-7000-8000-0000000000b2';
const INC = '0192c000-0000-7000-8000-0000000000c1';

const server = (over: Partial<Server> = {}): Server =>
  ({
    id: SRV,
    name: 'ru-entry-1',
    providerId: PROV_A,
    tags: ['prod', 'de'],
    notes: null,
    nodeWatch: 'auto',
    profile: { ...DEFAULT_SERVER_PROFILE },
    ...over,
  }) as Server;

class FakeRepo {
  rows = new Map<string, AssistantChangeRow>();
  n = 0;
  async insert(v: Partial<AssistantChangeRow>): Promise<AssistantChangeRow> {
    this.n += 1;
    const row = {
      id: `0192c000-0000-7000-8000-${String(this.n).padStart(12, '0')}`,
      conversationId: null,
      reason: null,
      note: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date(),
      ...v,
    } as AssistantChangeRow;
    this.rows.set(row.id, row);
    return row;
  }
  async find(id: string) {
    return this.rows.get(id);
  }
  async update(id: string, patch: Partial<AssistantChangeRow>) {
    const row = this.rows.get(id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  }
  async findPending(conversationId: string, operation: string) {
    return [...this.rows.values()].filter(
      (r) => r.conversationId === conversationId && r.operation === operation && r.status === 'proposed',
    );
  }
  async countsSince() {
    const counts = new Map<string, number>();
    for (const r of this.rows.values()) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts].map(([status, n]) => ({ status, n }));
  }
}

interface World {
  servers: Server[];
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  failUpdate: Error | null;
  /** «Применили, но значение не поменялось»: проверка результата должна это поймать. */
  swallowUpdate: boolean;
  incident: { status: 'open' | 'acknowledged' | 'resolved'; title: string; attempts: unknown[] };
  policy: { autofixEnabled: boolean; pausedUntil: string | null };
  audit: Array<Record<string, unknown>>;
}

function make() {
  const world: World = {
    servers: [server(), server({ id: OTHER, name: 'nl-exit-2', providerId: null, tags: [] })],
    updates: [],
    failUpdate: null,
    swallowUpdate: false,
    incident: { status: 'open', title: 'Диск', attempts: [] },
    policy: { autofixEnabled: true, pausedUntil: null },
    audit: [],
  };
  const repo = new FakeRepo();
  const servers = {
    list: async () => world.servers.map((s) => structuredClone(s)),
    update: async (id: string, patch: Record<string, unknown>) => {
      if (world.failUpdate) throw world.failUpdate;
      world.updates.push({ id, patch });
      if (world.swallowUpdate) return;
      const s = world.servers.find((x) => x.id === id) as Server;
      const { profile, ...rest } = patch;
      Object.assign(s, rest);
      if (profile) Object.assign(s.profile, profile);
    },
  };
  const providers = {
    list: async () => [
      { id: PROV_A, name: 'Hetzner' },
      { id: PROV_B, name: 'Aéza' },
    ],
  };
  const incidents = {
    get: async (id: string) => {
      if (id !== INC) throw new HttpException('нет', 404);
      return { id: INC, ...world.incident };
    },
    resolveManual: async () => {
      world.incident.status = 'resolved';
    },
    policy: async () => ({ ...world.policy }),
    updatePolicy: async (p: { pauseMinutes?: number }) => {
      if (p.pauseMinutes !== undefined)
        world.policy.pausedUntil =
          p.pauseMinutes > 0 ? new Date(Date.now() + p.pauseMinutes * 60_000).toISOString() : null;
    },
  };
  const audit = { record: async (e: Record<string, unknown>) => void world.audit.push(e) };
  const cls = { isActive: () => true, get: () => ({ id: 'u1', login: 'admin' }) };
  const svc = new ChangesService(
    repo as never,
    servers as never,
    providers as never,
    incidents as never,
    audit as never,
    cls as never,
  );
  return { svc, repo, world };
}

const propose = async (
  svc: ChangesService,
  operation: string,
  args: unknown,
  conversationId: string | null = null,
): Promise<AssistantChange> => {
  const out = await svc.propose({ operation, args, reason: 'Потому что.', conversationId });
  if ('problem' in out) throw new Error(`отказ: ${out.problem}`);
  return out.change;
};
const refusal = async (svc: ChangesService, operation: string, args: unknown): Promise<string> => {
  const out = await svc.propose({ operation, args, reason: null, conversationId: null });
  if (!('problem' in out)) throw new Error('ожидался отказ');
  return out.problem;
};

describe('ChangesService: предложение', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make();
  });

  it('предложение ничего не меняет и показывает «было → станет» по живому состоянию', async () => {
    const c = await propose(ctx.svc, 'server.provider', { server: 'ru-entry-1', provider: 'aéza' });
    expect(c.status).toBe('proposed');
    expect(c.rows).toEqual([{ label: 'Провайдер', before: 'Hetzner', after: 'Aéza' }]);
    expect(c.target).toEqual({ type: 'server', id: SRV, label: 'ru-entry-1' });
    expect(c.level).toBe('T1');
    expect(c.reversible).toBe(true);
    expect(c.reason).toBe('Потому что.');
    expect(ctx.world.updates).toEqual([]);
    expect(ctx.world.audit).toEqual([]);
  });

  it('сервер находится по имени без учёта регистра и по id; чужого сервера нет — отказ с подсказкой', async () => {
    expect((await propose(ctx.svc, 'server.notes', { server: 'RU-ENTRY-1', notes: 'x' })).target.id).toBe(
      SRV,
    );
    expect((await propose(ctx.svc, 'server.notes', { server: OTHER, notes: 'x' })).target.id).toBe(OTHER);
    expect(await refusal(ctx.svc, 'server.notes', { server: 'нет-такого', notes: 'x' })).toContain(
      'get_fleet_status',
    );
  });

  it('неизвестная операция и негодные аргументы отклоняются понятным текстом, карточки нет', async () => {
    expect(await refusal(ctx.svc, 'server.delete', {})).toContain('Доступные:');
    expect(await refusal(ctx.svc, 'server.rename', { server: 'ru-entry-1' })).toContain(
      'Аргументы не подходят',
    );
    expect(await refusal(ctx.svc, 'autofix.pause', { minutes: 5000 })).toContain('Аргументы не подходят');
    expect(ctx.repo.rows.size).toBe(0);
  });

  it('то, что уже так стоит, не предлагается', async () => {
    expect(
      await refusal(ctx.svc, 'server.provider', { server: 'ru-entry-1', provider: 'Hetzner' }),
    ).toContain('Менять нечего');
    expect(await refusal(ctx.svc, 'server.tags', { server: 'ru-entry-1', add: ['prod'] })).toContain(
      'Менять нечего',
    );
    expect(await refusal(ctx.svc, 'server.nodeWatch', { server: 'ru-entry-1', mode: 'auto' })).toContain(
      'Менять нечего',
    );
    expect(
      await refusal(ctx.svc, 'server.profile', { server: 'ru-entry-1', importance: 'normal' }),
    ).toContain('Менять нечего');
    expect(await refusal(ctx.svc, 'server.rename', { server: 'ru-entry-1', name: 'ru-entry-1' })).toContain(
      'Менять нечего',
    );
  });

  it('повторная карточка в той же беседе не создаётся, а в другой создаётся', async () => {
    const a = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' }, 'conv-1');
    const again = await ctx.svc.propose({
      operation: 'server.notes',
      args: { server: 'ru-entry-1', notes: 'Заметка' },
      reason: null,
      conversationId: 'conv-1',
    });
    expect(again).toMatchObject({ reused: true, change: { id: a.id } });
    const other = await ctx.svc.propose({
      operation: 'server.notes',
      args: { server: 'ru-entry-1', notes: 'Заметка' },
      reason: null,
      conversationId: 'conv-2',
    });
    expect('change' in other && other.reused).toBe(false);
    expect(ctx.repo.rows.size).toBe(2);
  });

  it('теги: добавить и убрать, регистр не различается, лимит и формат проверяются', async () => {
    const c = await propose(ctx.svc, 'server.tags', { server: 'ru-entry-1', add: ['vip'], remove: ['DE'] });
    expect(c.rows[0]).toMatchObject({
      before: 'prod, de',
      after: 'prod, vip',
      added: ['vip'],
      removed: ['de'],
    });
    expect(await refusal(ctx.svc, 'server.tags', { server: 'ru-entry-1', add: ['плохой тег!'] })).toContain(
      'Тег',
    );
    expect(await refusal(ctx.svc, 'server.tags', { server: 'ru-entry-1' })).toContain('add');
    (ctx.world.servers[0] as Server).tags = Array.from({ length: 10 }, (_, i) => `t${i}`);
    expect(await refusal(ctx.svc, 'server.tags', { server: 'ru-entry-1', add: ['лишний'] })).toContain(
      'больше 10',
    );
  });

  it('переименование: занятое имя и неверный формат отклоняются', async () => {
    expect(await refusal(ctx.svc, 'server.rename', { server: 'ru-entry-1', name: 'NL-EXIT-2' })).toContain(
      'занято',
    );
    const c = await propose(ctx.svc, 'server.rename', { server: 'ru-entry-1', name: 'ru-entry-9' });
    expect(c.rows[0]).toEqual({ label: 'Название', before: 'ru-entry-1', after: 'ru-entry-9' });
    expect(c.consequence).toContain('Журнала');
  });

  it('профиль: только меняющиеся поля, списки приводятся к порядку, критичность объясняется', async () => {
    const c = await propose(ctx.svc, 'server.profile', {
      server: 'ru-entry-1',
      roles: ['entry'],
      importance: 'critical',
      maintenanceWindow: ' ночью 03:00–05:00 ',
      expectedContainers: ['remnanode', 'nginx', 'nginx'],
      expectedPorts: [443, 22],
    });
    expect(c.rows.map((r) => r.label)).toEqual([
      'Функции сервера',
      'Важность',
      'Окно обслуживания',
      'Ожидаемые контейнеры',
      'Ожидаемые порты',
    ]);
    expect(c.rows[2]).toMatchObject({ after: 'ночью 03:00–05:00' });
    expect(c.rows[3]).toMatchObject({ after: 'nginx, remnanode', added: ['nginx', 'remnanode'] });
    expect(c.rows[4]).toMatchObject({ after: '22, 443' });
    expect(c.consequence).toContain('критичного');
    expect(c.consequence).toContain('расхождения');
    expect(await refusal(ctx.svc, 'server.profile', { server: 'ru-entry-1' })).toContain('ни одного поля');
    expect(
      await refusal(ctx.svc, 'server.profile', { server: 'ru-entry-1', expectedPorts: [70000] }),
    ).toContain('Аргументы не подходят');
  });

  it('провайдер: нет такого — перечисляются существующие, сброс в «пусто» разрешён', async () => {
    expect(await refusal(ctx.svc, 'server.provider', { server: 'ru-entry-1', provider: 'Vultr' })).toContain(
      'Hetzner, Aéza',
    );
    const c = await propose(ctx.svc, 'server.provider', { server: 'ru-entry-1', provider: null });
    expect(c.rows[0]).toEqual({ label: 'Провайдер', before: 'Hetzner', after: '—' });
  });

  it('закрытие инцидента: T2, необратимо; закрытый и несуществующий отклоняются', async () => {
    const c = await propose(ctx.svc, 'incident.resolve', { incidentId: INC });
    expect(c).toMatchObject({ level: 'T2', reversible: false, target: { type: 'incident', label: 'Диск' } });
    expect(c.consequence).toContain('заведёт новый инцидент');
    ctx.world.incident.status = 'resolved';
    expect(await refusal(ctx.svc, 'incident.resolve', { incidentId: INC })).toContain('уже закрыт');
    expect(await refusal(ctx.svc, 'incident.resolve', { incidentId: OTHER })).toContain('не найден');
  });

  it('пауза автопочинки: выключенная автопочинка и лишнее снятие отклоняются', async () => {
    ctx.world.policy.autofixEnabled = false;
    expect(await refusal(ctx.svc, 'autofix.pause', { minutes: 60 })).toContain('выключена');
    ctx.world.policy.autofixEnabled = true;
    expect(await refusal(ctx.svc, 'autofix.pause', { minutes: 0 })).toContain('не на паузе');
    const c = await propose(ctx.svc, 'autofix.pause', { minutes: 90 });
    expect(c.title).toBe('Поставить автопочинку на паузу');
    expect(c.rows[0]).toEqual({ label: 'Автопочинка', before: 'Работает', after: 'На паузе на 90 мин' });
  });
});

describe('ChangesService: применение', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make();
  });

  it('применяет, проверяет результат и пишет в Журнал, кто применил и что было и стало', async () => {
    const c = await propose(ctx.svc, 'server.provider', { server: 'ru-entry-1', provider: 'Aéza' });
    const done = await ctx.svc.apply(c.id);
    expect(done).toMatchObject({ status: 'applied', decidedBy: 'admin' });
    expect(done.note).toBe('Проверено: Провайдер: Aéza.');
    expect(ctx.world.servers[0]?.providerId).toBe(PROV_B);
    expect(ctx.world.audit).toHaveLength(1);
    expect(ctx.world.audit[0]).toMatchObject({
      action: 'assistant.change.applied',
      result: 'ok',
      target: { type: 'server', id: SRV, display: 'ru-entry-1' },
      metadata: {
        operation: 'server.provider',
        reason: 'Потому что.',
        rows: [{ label: 'Провайдер', before: 'Hetzner', after: 'Aéza' }],
      },
    });
  });

  it('повторное «Применить» не применяет дважды и не падает', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    await ctx.svc.apply(c.id);
    const again = await ctx.svc.apply(c.id);
    expect(again.status).toBe('applied');
    expect(ctx.world.updates).toHaveLength(1);
    expect(ctx.world.audit).toHaveLength(1);
  });

  it('два одновременных нажатия: применяется один раз, второе получает 409', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    const [a, b] = await Promise.allSettled([ctx.svc.apply(c.id), ctx.svc.apply(c.id)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect((rejected.reason as HttpException).getStatus()).toBe(409);
    expect(ctx.world.updates).toHaveLength(1);
  });

  it('состояние изменилось после предложения: ничего не применяется, объясняется, что сейчас', async () => {
    const c = await propose(ctx.svc, 'server.provider', { server: 'ru-entry-1', provider: 'Aéza' });
    (ctx.world.servers[0] as Server).providerId = null;
    const r = await ctx.svc.apply(c.id);
    expect(r.status).toBe('stale');
    expect(r.note).toContain('Состояние изменилось');
    expect(r.note).toContain('Провайдер: —');
    expect(ctx.world.updates).toEqual([]);
    expect(ctx.world.audit[0]).toMatchObject({ action: 'assistant.change.failed', result: 'failed' });
    await expect(ctx.svc.apply(c.id)).rejects.toMatchObject({ status: 409 });
    expect((await ctx.svc.get(c.id)).status).toBe('stale');
  });

  it('сервер удалили до применения: понятное «состояние изменилось», без падения', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    ctx.world.servers = [];
    const r = await ctx.svc.apply(c.id);
    expect(r.status).toBe('stale');
    expect(r.note).toContain('больше нет');
  });

  it('ошибка при применении: статус «Не применено», текст ошибки без внутренностей', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    ctx.world.failUpdate = new HttpException({ detail: 'Название занято.' }, 409);
    const r = await ctx.svc.apply(c.id);
    expect(r).toMatchObject({ status: 'failed', note: 'Название занято.' });
    ctx.world.failUpdate = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const c2 = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Другая' });
    const r2 = await ctx.svc.apply(c2.id);
    expect(r2.status).toBe('failed');
    expect(r2.note).not.toContain('ECONNREFUSED');
    expect(r2.note).toContain('внутренняя ошибка');
  });

  it('проверка результата: если значение не поменялось, статус «Не применено», а не «Применено»', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    ctx.world.swallowUpdate = true;
    const r = await ctx.svc.apply(c.id);
    expect(r.status).toBe('failed');
    expect(r.note).toContain('не подтвердила');
  });

  it('просроченное предложение (больше суток) применить нельзя', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    const row = ctx.repo.rows.get(c.id) as AssistantChangeRow;
    row.expiresAt = new Date(Date.now() - 1000);
    const r = await ctx.svc.apply(c.id);
    expect(r.status).toBe('expired');
    expect(ctx.world.updates).toEqual([]);
    expect((await ctx.svc.get(c.id)).status).toBe('expired');
  });

  it('отклонённое и отменённое применить нельзя (409), несуществующее — 404', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    expect((await ctx.svc.reject(c.id)).status).toBe('rejected');
    await expect(ctx.svc.apply(c.id)).rejects.toMatchObject({ status: 409 });
    expect((await ctx.svc.reject(c.id)).status).toBe('rejected');
    await expect(ctx.svc.get('0192c000-0000-7000-8000-00000000ffff')).rejects.toMatchObject({ status: 404 });
    expect(ctx.world.audit.map((a) => a.action)).toEqual(['assistant.change.rejected']);
  });

  it('профиль: применяется только затронутое, откат возвращает прежние значения', async () => {
    const c = await propose(ctx.svc, 'server.profile', {
      server: 'ru-entry-1',
      roles: ['exit', 'entry'],
      expectedPorts: [443, 22],
    });
    await ctx.svc.apply(c.id);
    expect(ctx.world.servers[0]?.profile).toMatchObject({
      roles: ['entry', 'exit'],
      expectedPorts: [22, 443],
      importance: 'normal',
    });
    expect(ctx.world.updates[0]?.patch).toEqual({
      profile: { roles: ['entry', 'exit'], expectedPorts: [22, 443] },
    });
    const back = await ctx.svc.revert(c.id);
    expect(back.status).toBe('reverted');
    expect(ctx.world.servers[0]?.profile).toMatchObject({ roles: [], expectedPorts: [] });
  });

  it('закрытие инцидента применяется, но кнопкой не отменяется', async () => {
    const c = await propose(ctx.svc, 'incident.resolve', { incidentId: INC });
    expect((await ctx.svc.apply(c.id)).status).toBe('applied');
    expect(ctx.world.incident.status).toBe('resolved');
    await expect(ctx.svc.revert(c.id)).rejects.toMatchObject({ status: 409 });
  });

  it('пауза автопочинки: ставится и снимается откатом', async () => {
    const c = await propose(ctx.svc, 'autofix.pause', { minutes: 60 });
    await ctx.svc.apply(c.id);
    expect(ctx.world.policy.pausedUntil).not.toBeNull();
    expect((await ctx.svc.revert(c.id)).status).toBe('reverted');
    expect(ctx.world.policy.pausedUntil).toBeNull();
  });

  it('откат не затирает чужую правку, сделанную после применения', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Первая' });
    await ctx.svc.apply(c.id);
    (ctx.world.servers[0] as Server).notes = 'Кто-то поправил вручную';
    await expect(ctx.svc.revert(c.id)).rejects.toMatchObject({ status: 409 });
    expect(ctx.world.servers[0]?.notes).toBe('Кто-то поправил вручную');
    expect((await ctx.svc.get(c.id)).status).toBe('applied');
  });

  it('отменить можно только применённое', async () => {
    const c = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'Заметка' });
    await expect(ctx.svc.revert(c.id)).rejects.toMatchObject({ status: 409 });
  });

  it('сводка считает по статусам', async () => {
    const a = await propose(ctx.svc, 'server.notes', { server: 'ru-entry-1', notes: 'A' });
    const b = await propose(ctx.svc, 'server.notes', { server: 'nl-exit-2', notes: 'B' });
    await propose(ctx.svc, 'server.tags', { server: 'ru-entry-1', add: ['vip'] });
    await ctx.svc.apply(a.id);
    await ctx.svc.reject(b.id);
    expect(await ctx.svc.summary(7)).toEqual({ days: 7, applied: 1, reverted: 0, rejected: 1, pending: 1 });
  });
});

import type { IncidentAnalysis } from '@nodeservice/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IncidentState, PendingTelegram } from './notifications.repository.js';
import { NotificationsService, type PushInput } from './notifications.service.js';
import type { TelegramDispatch } from './telegram/telegram.service.js';

/** «База» в памяти: отложенные сообщения и дела переживают «перезапуск» (новый экземпляр службы). */
function makeDb() {
  return {
    pending: new Map<string, PendingTelegram>(),
    incidents: new Map<string, IncidentState>(),
    /** По каким делам в Telegram уже что-то ушло. */
    announced: new Set<string>(),
    sent: [] as TelegramDispatch[],
    bell: [] as string[],
    failDefer: false,
  };
}
type FakeDb = ReturnType<typeof makeDb>;

const openedAgo = (ms: number): IncidentState => ({
  status: 'open',
  openedAt: new Date(Date.now() - ms),
  resolvedAt: null,
  analysis: null,
});

/** Минимальный сервис: колокольчик — в память, Telegram — в список, отложенное — в «базу». */
function make(db: FakeDb = makeDb()) {
  const svc = new NotificationsService(
    {
      insert: async (r: { title: string }) => {
        db.bell.push(r.title);
        return { ...r, id: 'n', createdAt: new Date(), readAt: null };
      },
      deferTelegram: async (id: string, alert: TelegramDispatch) => {
        if (db.failDefer) throw new Error('нет такого дела');
        db.pending.set(id, {
          incidentId: id,
          alert,
          queued: db.pending.get(id)?.queued ?? [],
          createdAt: new Date(),
        });
      },
      queueTelegram: async (id: string, m: TelegramDispatch) => {
        const p = db.pending.get(id);
        if (!p) return false;
        p.queued.push(m);
        return true;
      },
      peekTelegram: async (id: string) => db.pending.get(id) ?? null,
      takeTelegram: async (id: string) => {
        const p = db.pending.get(id) ?? null;
        db.pending.delete(id);
        return p;
      },
      pendingTelegram: async () => [...db.pending.values()],
      incidentState: async (id: string) => db.incidents.get(id) ?? null,
    } as never,
    { emit: () => undefined } as never,
    {
      dispatch: async (m: TelegramDispatch) => {
        db.sent.push(m);
        if (m.incidentId && m.event !== 'resolved') db.announced.add(m.incidentId);
      },
      lastMessageAt: async (id: string) => (db.announced.has(id) ? new Date() : null),
    } as never,
  );
  // Таймер ожидания в этих тестах не нужен (кроме теста про него): сообщение выпускают события.
  svc.analysisWaitMs = 60_000;
  return { svc, db, sent: db.sent, bell: db.bell };
}

const alert = (id: string, extra: Partial<PushInput> = {}): PushInput => ({
  severity: 'crit',
  title: 'Сервер недоступен · {server}',
  body: 'Сервер не отвечает: агент молчит.',
  server: { id: 's1', name: 'Финляндия #01', host: '95.216.10.4' },
  telegram: { event: 'incident_crit', incidentId: id, kind: 'server_down', awaitAnalysis: true },
  ...extra,
});
const resolved = (id: string, closed: NonNullable<PushInput['telegram']>['closed']): PushInput => ({
  severity: 'ok',
  title: 'Сервер недоступен · {server} — проблема исчезла',
  body: 'Инцидент закрыт автоматически.',
  server: { id: 's1', name: 'Финляндия #01' },
  telegram: { event: 'resolved', incidentId: id, kind: 'server_down', closed },
});
const done = (verdict: string): IncidentAnalysis =>
  ({ status: 'done', verdict, confidence: 'medium' }) as IncidentAnalysis;

afterEach(() => vi.useRealTimers());

describe('Telegram ждёт разбора Джарвиса', () => {
  it('колокольчик сразу, Telegram — после разбора и с выводом первым блоком', async () => {
    const { svc, sent, bell, db } = make();
    db.incidents.set('i1', openedAgo(90_000));
    await svc.push({
      severity: 'crit',
      title: 'Сервер недоступен · guardora',
      body: 'Онлайн: 476 → 0',
      telegram: { event: 'incident_crit', incidentId: 'i1', kind: 'server_down', awaitAnalysis: true },
    });
    expect(bell).toHaveLength(1);
    expect(sent).toHaveLength(0);
    await svc.releaseAfterAnalysis(
      'i1',
      'Оплата просрочена на 15 часов — вероятно, отключили за неоплату.',
      'high',
    );
    await svc.settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatch(/^🤖 Разбор Джарвиса \(уверенность высокая\): Оплата просрочена/);
    expect(sent[0]?.body).toContain('Онлайн: 476 → 0');
    await svc.releaseAfterAnalysis('i1', 'повтор');
    await svc.settle();
    expect(sent).toHaveLength(1);
  });

  it('разбор не пришёл — через время ожидания уходит как есть', async () => {
    vi.useFakeTimers();
    const { svc, sent, db } = make();
    svc.analysisWaitMs = 50;
    db.incidents.set('i2', openedAgo(0));
    await svc.push({
      severity: 'crit',
      title: 't',
      body: 'b',
      telegram: { event: 'incident_crit', incidentId: 'i2', awaitAnalysis: true },
    });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    await svc.settle();
    expect(sent).toEqual([expect.objectContaining({ body: 'b' })]);
  });

  it('отложить не получилось (дела нет в базе) — сообщение уходит сразу, а не теряется', async () => {
    const { svc, sent, db } = make();
    db.failDefer = true;
    await svc.push(alert('i3'));
    await svc.settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toBe('incident_crit');
  });
});

describe('дело закрылось, пока тревога ждала разбора', () => {
  it('тревога отменяется, вместо пары «тревога → починилось» — одно тихое сообщение о коротком сбое', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(90_000));
    await svc.push(alert('i1'));
    await svc.push(resolved('i1', { recovered: true, how: null }));
    await svc.settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'resolved',
      incidentId: 'i1',
      silent: true,
      title: 'Короткий сбой уже прошёл: Сервер недоступен',
      server: { name: 'Финляндия #01', host: '95.216.10.4' },
      // Пришло вместо тревоги — пройдёт и по её тумблеру, даже если «Починилось» выключено.
      replaces: 'incident_crit',
    });
    expect(sent[0]?.body).toBe(
      'Длился с момента обнаружения: 1 мин 30 с\nСейчас: в норме — проблема исчезла сама.',
    );
    // Разбор закончился позже, время ожидания вышло — тревога по закрытому делу уже не придёт.
    await svc.releaseAfterAnalysis('i1', 'Сервер перезагружался.', 'high');
    await svc.flushDeferred();
    await svc.settle();
    expect(sent).toHaveLength(1);
    expect(db.pending.size).toBe(0);
  });

  it('дело закрыто с причиной — панель не утверждает «в норме», а пересказывает, чем закончилось', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(40_000));
    await svc.push(alert('i1'));
    await svc.push(
      resolved('i1', {
        recovered: false,
        how: 'Сервер снова отвечает, но агент молчит — открыто отдельное дело «Агент не в сети».',
      }),
    );
    await svc.settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('Короткий сбой, дело уже закрыто: Сервер недоступен');
    expect(sent[0]?.body).toBe(
      'Длился с момента обнаружения: меньше минуты\nЧем закончилось: Сервер снова отвечает, но агент молчит — открыто отдельное дело «Агент не в сети».',
    );
    expect(sent[0]?.body).not.toContain('в норме');
  });

  it('дело влилось в другое — тревога снимается молча, о сбое расскажет главное дело', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(40_000));
    await svc.push(alert('i1'));
    await svc.push(resolved('i1', 'merged'));
    await svc.settle();
    expect(sent).toHaveLength(0);
    expect(db.pending.size).toBe(0);
  });

  it('закрыли вручную в панели — тревога не приходит вовсе', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(40_000));
    await svc.push(alert('i1'));
    await svc.dropDeferred('i1');
    await svc.releaseAfterAnalysis('i1', 'Вывод.', 'low');
    await svc.settle();
    expect(sent).toHaveLength(0);
  });

  it('разбор готов, а дело к этому времени уже закрыто — тревога не уходит', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(200_000));
    await svc.push(alert('i1'));
    db.incidents.set('i1', {
      ...openedAgo(200_000),
      status: 'resolved',
      resolvedAt: new Date(Date.now() - 120_000),
    });
    await svc.releaseAfterAnalysis('i1', 'Вывод.', 'high');
    await svc.settle();
    expect(sent).toHaveLength(0);
    expect(db.pending.size).toBe(0);
  });

  it('дело закрыто только что, а сообщение о закрытии ещё в пути — тревогу не шлём и не теряем повод сказать о коротком сбое', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(70_000));
    await svc.push(alert('i1'));
    // Шаг помог: дело уже помечено закрытым, уведомление об этом придёт мгновением позже. В этот зазор
    // успел закончиться разбор.
    db.incidents.set('i1', { ...openedAgo(70_000), status: 'resolved', resolvedAt: new Date() });
    await svc.releaseAfterAnalysis('i1', 'Контейнер упал при обновлении.', 'high');
    await svc.settle();
    expect(sent).toHaveLength(0);
    expect(db.pending.size).toBe(1);
    await svc.push(
      resolved('i1', { recovered: true, how: 'помог шаг «Поднять контейнер ноды» (по вашей команде)' }),
    );
    await svc.settle();
    expect(sent.map((m) => m.title)).toEqual(['Короткий сбой уже прошёл: Сервер недоступен']);
    expect(db.pending.size).toBe(0);
  });

  it('о деле уже писали (уточнение ждало разбора) — уходит обычное «Починилось», отложенное уточнение снято', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(90_000));
    db.announced.add('i1');
    await svc.push(alert('i1'));
    await svc.push(resolved('i1', { recovered: true, how: null }));
    await svc.settle();
    expect(sent.map((m) => m.title)).toEqual(['Сервер недоступен · Финляндия #01 — проблема исчезла']);
    expect(sent[0]?.silent).toBeUndefined();
    expect(db.pending.size).toBe(0);
  });
});

describe('события того же дела не обгоняют отложенную тревогу', () => {
  const followUp = (id: string, event: 'needs_confirm' | 'fix_failed', title: string): PushInput => ({
    severity: 'warn',
    title,
    server: { id: 's1', name: 'Финляндия #01' },
    telegram: { event, incidentId: id, kind: 'node_down' },
  });

  it('«не помогло» и «нужно подтверждение» ждут тревогу и уходят сразу за ней, по порядку', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(90_000));
    await svc.push(alert('i1'));
    await svc.push(followUp('i1', 'fix_failed', '«Поднять контейнер ноды» — не помогло'));
    await svc.push(followUp('i1', 'needs_confirm', 'Ждёт подтверждения'));
    await svc.settle();
    expect(sent).toHaveLength(0);
    await svc.releaseAfterAnalysis('i1', 'Контейнер падает при старте.', 'medium');
    await svc.settle();
    expect(sent.map((m) => m.event)).toEqual(['incident_crit', 'fix_failed', 'needs_confirm']);
    expect(sent[0]?.body).toMatch(/^🤖 Разбор Джарвиса \(уверенность средняя\): Контейнер падает/);
  });

  it('дело закрылось — вместо тревоги и накопленных событий одно сообщение о коротком сбое', async () => {
    const { svc, sent, db } = make();
    db.incidents.set('i1', openedAgo(130_000));
    await svc.push(alert('i1'));
    await svc.push(followUp('i1', 'fix_failed', '«Поднять контейнер ноды» — не помогло'));
    await svc.push(
      resolved('i1', { recovered: true, how: 'помог шаг «Поднять контейнер ноды» (автоматически)' }),
    );
    await svc.settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe(
      'Длился с момента обнаружения: 2 мин 10 с\nСейчас: в норме — помог шаг «Поднять контейнер ноды» (автоматически).',
    );
  });

  it('тревога не ждёт — событие уходит сразу, как раньше', async () => {
    const { svc, sent } = make();
    await svc.push(followUp('i9', 'needs_confirm', 'Ждёт подтверждения'));
    await svc.settle();
    expect(sent.map((m) => m.event)).toEqual(['needs_confirm']);
  });
});

describe('отложенное сообщение переживает перезапуск панели', () => {
  it('после старта уходит, когда разбор закончился, прерван или время ожидания истекло', async () => {
    const db = makeDb();
    const before = make(db);
    for (const id of ['done', 'failed', 'waiting', 'expired', 'running', 'gone']) {
      db.incidents.set(id, openedAgo(30_000));
      await before.svc.push(alert(id, { body: `дело ${id}` }));
    }
    expect(db.pending.size).toBe(6);
    expect(db.sent).toHaveLength(0);

    // Панель перезапустили: таймеры в памяти пропали, признак «ждёт отправки» остался в базе.
    const after = make(db);
    db.incidents.set('done', { ...openedAgo(30_000), analysis: done('Отключили за неоплату.') });
    db.incidents.set('failed', {
      ...openedAgo(30_000),
      analysis: { status: 'failed', verdict: null } as IncidentAnalysis,
    });
    db.incidents.set('running', {
      ...openedAgo(30_000),
      analysis: { status: 'running', verdict: null } as IncidentAnalysis,
    });
    db.incidents.delete('gone');
    const old = db.pending.get('expired');
    if (old) old.createdAt = new Date(Date.now() - 10 * 60_000);

    await after.svc.flushDeferred();
    await after.svc.settle();
    const byId = new Map(db.sent.map((m) => [m.incidentId, m]));
    expect([...byId.keys()].sort()).toEqual(['done', 'expired', 'failed']);
    expect(byId.get('done')?.body).toBe(
      '🤖 Разбор Джарвиса (уверенность средняя): Отключили за неоплату.\n\nдело done',
    );
    expect(byId.get('failed')?.body).toBe('дело failed');
    expect(byId.get('expired')?.body).toBe('дело expired');
    // Разбор ещё идёт или вот-вот начнётся — ждём; дела уже нет — признак просто снят.
    expect([...db.pending.keys()].sort()).toEqual(['running', 'waiting']);

    // Повторный проход ничего не дублирует.
    await after.svc.flushDeferred();
    await after.svc.settle();
    expect(db.sent).toHaveLength(3);
  });
});

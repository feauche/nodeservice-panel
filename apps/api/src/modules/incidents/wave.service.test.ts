import { MONITORING_DEFAULTS, type RemnawaveNode } from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentRow } from '../../infra/db/schema/index.js';
import { WaveService } from './wave.service.js';

const node = (uuid: string, name: string, providerUuid: string | null, countryCode = 'NL'): RemnawaveNode =>
  ({
    uuid,
    name,
    address: `10.0.0.${uuid.length}`,
    providerUuid,
    providerName: providerUuid ? 'Aeza' : null,
    countryCode,
    isConnected: false,
    isDisabled: false,
  }) as RemnawaveNode;

const NL1 = node('nl1', 'Нидерланды - 1', 'aeza');
const DE2 = node('de2', 'Германия - 2 (hy2)', 'aeza', 'DE');
const PL2 = node('pl2', 'Польша - 2 (hy2)', 'aeza', 'PL');
const TR1 = node('tr1', 'Турция - 1', 'aeza', 'TR');
const HZ = node('hz1', 'Финляндия - 1', 'hetzner', 'FI');
const RU1 = node('ru1', 'Россия - 1', null, 'RU');
const RU2 = node('ru2', 'Россия - 2', null, 'RU');

/** Таблица событий в памяти: открытие с защитой «одна открытая волна на группу», как индекс 0066. */
function setup(cfg: Partial<typeof MONITORING_DEFAULTS> = {}, nodes = [NL1, DE2, PL2, TR1, HZ, RU1, RU2]) {
  const rows: IncidentRow[] = [];
  let seq = 0;
  let clock = Date.parse('2026-10-15T08:02:00Z');
  const repo = {
    list: async (status: string) => rows.filter((r) => (status === 'open' ? r.status !== 'resolved' : true)),
    findById: async (id: string) => rows.find((r) => r.id === id),
    open: vi.fn(async (v: Record<string, unknown>) => {
      const key = (v.snapshot as { fleet?: { groupKey?: string } } | null)?.fleet?.groupKey;
      if (
        v.kind === 'wave' &&
        rows.some((r) => r.kind === 'wave' && r.status !== 'resolved' && r.snapshot?.fleet?.groupKey === key)
      )
        return undefined;
      const row = {
        id: `i${++seq}`,
        nodeUuid: null,
        status: 'open',
        openedAt: new Date(clock),
        resolvedAt: null,
        snapshot: null,
        timeline: [],
        ...v,
      } as unknown as IncidentRow;
      rows.push(row);
      return row;
    }),
    update: async (id: string, patch: Partial<IncidentRow>) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      return r;
    },
    appendTimeline: async (id: string, e: unknown) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.timeline = [...r.timeline, e as never];
      return r;
    },
  };
  const notifications = { push: vi.fn(async () => undefined), editIncident: vi.fn(async () => undefined) };
  const settings = { get: async () => ({ ...MONITORING_DEFAULTS, ...cfg }) };
  const remna = { status: async () => ({ nodes }) };
  const db = { query: { appMeta: { findFirst: async () => undefined } } };
  const wave = new WaveService(
    db as never,
    repo as never,
    notifications as never,
    remna as never,
    settings as never,
  );
  /** Нода упала: событие открылось (как в наблюдении), волна решает, слать ли его сообщение. */
  const fall = async (n: RemnawaveNode, kind = 'node_down', minutesLater = 1) => {
    clock += minutesLater * 60_000;
    vi.setSystemTime(clock);
    const row = await repo.open({
      nodeUuid: n.uuid,
      serverName: n.name,
      kind,
      severity: 'crit',
      title: 'Нода не на связи',
    });
    return { row: row as IncidentRow, verdict: await wave.onNodeOpened(n, row as IncidentRow) };
  };
  const rise = async (row: IncidentRow) => {
    Object.assign(row, { status: 'resolved', resolvedAt: new Date(clock) });
    return wave.onNodeResolved(row);
  };
  const waves = () => rows.filter((r) => r.kind === 'wave');
  return { wave, rows, repo, notifications, fall, rise, waves };
}

describe('Волна: когда начинается', () => {
  it('первая нода — своё сообщение; вторая нода того же провайдера — волна вместо её сообщения', async () => {
    vi.useFakeTimers();
    const t = setup();
    expect((await t.fall(NL1)).verdict).toBe('notify');
    expect((await t.fall(DE2)).verdict).toBe('absorbed');
    const [w] = t.waves();
    expect(w).toMatchObject({ title: 'Волна · Aeza', serverName: 'Aeza', severity: 'crit', nodeUuid: null });
    expect(w?.snapshot?.fleet).toMatchObject({
      cause: 'provider',
      groupKey: 'provider:aeza',
      total: 4,
      members: [
        { nodeUuid: 'nl1', name: 'Нидерланды - 1', incidentId: 'i1', upAt: null },
        { nodeUuid: 'de2', name: 'Германия - 2 (hy2)', incidentId: 'i2', upAt: null },
      ],
    });
    // Сообщение волны — одно, со своим значком, обычным текстом (его потом правят), с объяснением.
    expect(t.notifications.push).toHaveBeenCalledTimes(1);
    const msg = t.notifications.push.mock.calls[0]?.[0] as unknown as Record<string, Record<string, unknown>>;
    expect(msg.telegram).toMatchObject({ event: 'incident_crit', kind: 'wave', icon: '🌊', plain: true });
    expect(String(msg.body)).toContain('Не на связи 2 из 4 нод провайдера (за 10 мин):');
    expect(String(msg.body)).toContain(
      'Волна — когда за короткое время падают сразу несколько нод одного провайдера.',
    );
    // В событиях нод — строка «входит в волну».
    for (const id of ['i1', 'i2'])
      expect(t.rows.find((r) => r.id === id)?.timeline.at(-1)).toMatchObject({
        action: 'Входит в волну · Aeza',
      });
    vi.useRealTimers();
  });

  it('другой провайдер, позже окна, выключенная склейка, нагрузка — не волна', async () => {
    vi.useFakeTimers();
    let t = setup();
    await t.fall(NL1);
    expect((await t.fall(HZ)).verdict).toBe('notify');
    expect((await t.fall(DE2, 'node_down', 11)).verdict).toBe('notify');
    t = setup({ waveEnabled: false });
    await t.fall(NL1);
    expect((await t.fall(DE2)).verdict).toBe('notify');
    t = setup();
    await t.fall(NL1);
    expect((await t.fall(DE2, 'cpu_high')).verdict).toBe('notify');
    expect(t.waves()).toEqual([]);
    vi.useRealTimers();
  });

  it('ноды без провайдера собираются по стране; порог 3 — волна только с третьей ноды', async () => {
    vi.useFakeTimers();
    let t = setup();
    await t.fall(RU1);
    expect((await t.fall(RU2)).verdict).toBe('absorbed');
    expect(t.waves()[0]?.snapshot?.fleet).toMatchObject({ cause: 'country', groupKey: 'country:RU' });
    const first = t.notifications.push.mock.calls[0]?.[0] as unknown as { body: string } | undefined;
    expect(String(first?.body)).toContain('нод страны');
    t = setup({ waveMinNodes: 3 });
    await t.fall(NL1);
    expect((await t.fall(DE2)).verdict).toBe('notify');
    expect((await t.fall(PL2)).verdict).toBe('absorbed');
    expect(t.waves()[0]?.snapshot?.fleet?.members).toHaveLength(3);
    vi.useRealTimers();
  });
});

describe('Волна: кто присоединяется', () => {
  it('третья нода — в ту же волну: сообщение правится, а если не выйдет — тихий ответ', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.fall(NL1);
    await t.fall(DE2);
    expect((await t.fall(PL2, 'node_down', 20)).verdict).toBe('absorbed');
    expect(t.waves()).toHaveLength(1);
    expect(t.waves()[0]?.snapshot?.fleet?.members.map((m) => m.nodeUuid)).toEqual(['nl1', 'de2', 'pl2']);
    expect(t.notifications.push).toHaveBeenCalledTimes(1);
    const [edited, fallback] = t.notifications.editIncident.mock.calls[0] as unknown as Array<{
      body: string;
      title: string;
    }>;
    expect(edited?.body).toContain('Не на связи 3 из 4');
    expect(fallback?.title).toBe('Ещё нода в волне');
    vi.useRealTimers();
  });

  it('второе событие той же лежащей ноды — без новых сообщений', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.fall(NL1);
    await t.fall(DE2);
    expect((await t.fall(DE2, 'server_down')).verdict).toBe('absorbed');
    expect(t.notifications.editIncident).not.toHaveBeenCalled();
    expect(t.waves()[0]?.snapshot?.fleet?.members).toHaveLength(2);
    vi.useRealTimers();
  });

  it('две обработки разом: волну завела другая — нода входит в неё, второй волны нет', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.fall(NL1);
    await t.fall(DE2);
    // Как будто «список открытых» прочитали до появления волны: открытие волны упирается в защиту и входит в неё.
    const list = t.repo.list;
    let first = true;
    t.repo.list = async (s: string) => {
      const all = await list(s);
      if (!first) return all;
      first = false;
      return all.filter((r) => r.kind !== 'wave');
    };
    const verdict = (await t.fall(PL2)).verdict;
    t.repo.list = list;
    expect(verdict).toBe('absorbed');
    expect(t.waves()).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('Волна: окончание', () => {
  it('«Восстановления» нод волны не шлются; поднялись все — одно тихое «Волна закончилась»', async () => {
    vi.useFakeTimers();
    const t = setup();
    const a = await t.fall(NL1);
    const b = await t.fall(DE2);
    expect(await t.rise(a.row)).toBe('absorbed');
    expect(t.waves()[0]?.status).toBe('open');
    expect(t.waves()[0]?.snapshot?.fleet?.members[0]?.upAt).toBeTruthy();
    expect(await t.rise(b.row)).toBe('absorbed');
    expect(t.waves()[0]).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
    const end = t.notifications.push.mock.calls.at(-1)?.[0] as unknown as Record<
      string,
      Record<string, unknown>
    >;
    expect(end).toMatchObject({ title: 'Волна закончилась', telegram: { event: 'resolved', kind: 'wave' } });
    expect(String(end.body)).toContain('Все ноды волны «Aeza» снова на связи: 2 ноды.');
    expect(t.waves()[0]?.timeline.at(-1)).toMatchObject({
      action: 'Все ноды снова на связи — волна закончилась',
    });
    vi.useRealTimers();
  });

  it('событие ноды вне волны закрывается как обычно', async () => {
    const t = setup();
    expect(await t.wave.onNodeResolved({ id: 'x', nodeUuid: 'hz1', kind: 'node_down' } as IncidentRow)).toBe(
      'notify',
    );
  });

  it('ноды волны закрыли в обход наблюдения (вручную, обслуживание) — волна закрывается на следующем проходе', async () => {
    vi.useFakeTimers();
    const t = setup();
    const a = await t.fall(NL1);
    const b = await t.fall(DE2);
    for (const r of [a.row, b.row]) Object.assign(r, { status: 'resolved' });
    await t.wave.reconcileAll();
    expect(t.waves()[0]?.status).toBe('resolved');
    vi.useRealTimers();
  });

  it('пропущенные сценарии отмечаются в волне по одному разу', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.fall(NL1);
    await t.fall(DE2);
    const id = t.waves()[0]?.id ?? '';
    const entry = { ruleId: 'r1', ruleName: 'Скрыть Host', nodeUuid: 'nl1' };
    await t.wave.noteSkipped(id, entry);
    await t.wave.noteSkipped(id, entry);
    expect(t.waves()[0]?.snapshot?.fleet?.skipped).toEqual([entry]);
    expect([...(await t.wave.nodesInWave()).keys()]).toEqual(['nl1', 'de2']);
    vi.useRealTimers();
  });
});

import type { Incident } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  ago,
  connectionText,
  coverageText,
  fleetText,
  historyText,
  onlineText,
  reachText,
  summarizeOnline,
} from './incident-evidence.logic.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const inc = (over: Partial<Incident>): Incident =>
  ({
    id: 'x',
    serverId: 's1',
    serverName: 'Казахстан',
    kind: 'server_down',
    status: 'open',
    title: 'Сервер недоступен · Казахстан',
    openedAt: '2026-09-29T11:00:00Z',
    resolvedAt: null,
    resolvedBy: null,
    analysis: null,
    ...over,
  }) as Incident;

describe('онлайн ноды вокруг дела', () => {
  const opened = Date.parse('2026-09-29T11:00:00Z');
  const t = (min: number) => opened / 1000 + min * 60;
  it('среднее за час до, минимум после, сейчас и падение', () => {
    const s = summarizeOnline(
      [
        [t(-50), 400],
        [t(-10), 420],
        [t(5), 35],
        [t(30), 40],
      ],
      opened,
    );
    expect(s).toEqual({ before: 410, minAfter: 35, now: 40, dropPct: 91 });
    expect(onlineText('Казахстан', s)).toMatch(/Падение на 91% — люди массово не могут подключиться/);
  });
  it('без падения и без истории', () => {
    const flat = summarizeOnline(
      [
        [t(-10), 100],
        [t(10), 98],
      ],
      opened,
    );
    expect(onlineText('n', flat)).toMatch(/Заметного падения онлайна нет/);
    expect(onlineText('n', summarizeOnline([], opened))).toMatch(/истории нет/);
  });
  it('вернулся — так и сказано', () => {
    const back = summarizeOnline(
      [
        [t(-10), 400],
        [t(5), 30],
        [t(50), 390],
      ],
      opened,
    );
    expect(onlineText('n', back)).toMatch(/вернулся близко к прежнему/);
  });
});

describe('доступность из разных стран', () => {
  it('закрыто только из России — признак блокировки', () => {
    const text = reachText(
      22,
      [
        { from: 'Мост', country: 'RU', open: false },
        { from: 'Германия-1', country: 'DE', open: true },
      ],
      true,
    );
    expect(text).toMatch(/• Мост — порт не отвечает/);
    expect(text).toMatch(/блокировки IP в России \(ТСПУ\)/);
  });
  it('закрыто и из России, и с панели в Польше — часть сетей', () => {
    const text = reachText(
      22,
      [
        { from: 'Мост', country: 'RU', open: false },
        { from: 'Германия-1', country: 'DE', open: true },
      ],
      false,
    );
    expect(text).toMatch(/закрыт из Мост и с сервера панели: сервер жив/);
  });
  it('закрыто отовсюду и открыто отовсюду', () => {
    expect(reachText(22, [{ from: 'A', country: 'DE', open: false }], false)).toMatch(/ни из одной страны/);
    expect(reachText(22, [{ from: 'A', country: 'DE', open: true }], true)).toMatch(/искать внутри/);
    expect(reachText(22, [], null)).toMatch(/проверить не с чего/);
  });
});

describe('агент, парк, прошлые дела, покрытие', () => {
  it('агент и SSH словами', () => {
    const t = connectionText(
      {
        agentStatus: 'offline',
        agentLastSeenAt: '2026-09-29T11:48:00Z',
        sshOk: false,
        lastSshOkAt: '2026-09-29T09:00:00Z',
        lastSshCheckAt: null,
      },
      NOW,
    );
    expect(t).toBe(
      'Связь с панелью: агент молчит, последний раз был 12 мин назад; SSH с панели не работает, последний успешный вход 3 ч назад.',
    );
    expect(ago(null)).toBe('ни разу');
  });
  it('одновременные сбои у других серверов — общая причина', () => {
    const me = inc({});
    const other = inc({
      id: 'y',
      serverId: 's2',
      serverName: 'Германия-1',
      openedAt: '2026-09-29T11:10:00Z',
    });
    const far = inc({ id: 'z', serverId: 's3', serverName: 'Финляндия', openedAt: '2026-09-29T08:00:00Z' });
    expect(fleetText(me, [me, far])).toMatch(/похожих сбоев нет/);
    expect(fleetText(me, [me, other, far])).toMatch(/Германия-1 \(сервер недоступен\).*общая причина/);
  });
  it('прошлые дела: по видам и как закрывались', () => {
    const past = [
      inc({
        id: 'p1',
        kind: 'node_blocked',
        title: 'Похоже на блокировку · Казахстан',
        status: 'resolved',
        openedAt: '2026-09-12T10:00:00Z',
        resolvedAt: '2026-09-12T12:00:00Z',
        resolvedBy: 'manual',
      }),
    ];
    const t = historyText(inc({}), past);
    expect(t).toMatch(/похоже на блокировку — 1/);
    expect(t).toMatch(/закрыто вручную через 2 ч/);
    expect(historyText(inc({}), [])).toMatch(/не было/);
  });
  it('покрытие: что проверено и что нет', () => {
    expect(coverageText({ 'онлайн ноды': true, 'база знаний': false })).toBe(
      'Проверено панелью до разбора: онлайн ноды. Не удалось или не к чему: база знаний.',
    );
  });
});

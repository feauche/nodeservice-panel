import type { Incident } from '@nodeservice/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ago,
  changesText,
  connectionText,
  coverageText,
  fleetText,
  historyText,
  kbText,
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
    // Оценка подана как оценка, а не как факт о пользователях.
    expect(onlineText('Казахстан', s)).toMatch(/Падение на 91% — так выглядит массовая потеря подключений/);
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
    // Агент на связи и SSH работает — «искать внутри» нечего: подсказка толкала бы искать поломку на сервере.
    const healthy = reachText(22, [{ from: 'A', country: 'DE', open: true }], true, true);
    // «Сеть в порядке» — только про точки, с которых проверяли: про сети пользователей проверка не говорит.
    expect(healthy).toMatch(/Открыт отовсюду: сервер включён, с этих точек сеть до него в порядке\.$/);
    expect(healthy).not.toMatch(/искать внутри/);
    expect(reachText(22, [], null)).toMatch(/проверить не с чего/);
  });
  it('с серверов парка порт закрыт, а сервер заведомо работает — «выключен» не пишем', () => {
    const park = [
      { from: 'Мост', country: 'RU', open: false },
      { from: 'Германия-1', country: 'DE', open: false },
    ];
    // SSH разрешён только адресу панели: с панели порт открыт.
    const fromPanel = reachText(22, park, true);
    expect(fromPanel).toMatch(/• Сервер панели — порт открыт/);
    expect(fromPanel).toMatch(/С серверов парка порт не отвечает, но сервер работает/);
    expect(fromPanel).not.toMatch(/выключен/);
    // Агент на связи — то же, даже если порт с панели не проверяли.
    expect(reachText(22, park, null, true)).not.toMatch(/выключен/);
    // Закрыт отовсюду, включая панель, — «выключен, завис или отрезан».
    expect(reachText(22, park, false)).toMatch(/Не отвечает ни из одной страны: сервер выключен/);
  });
  it('все проверяющие из одной страны и панель не проверяла — «выключен» от «закрыт путь из этой страны» не отличить', () => {
    const onlyRu = [
      { from: 'Мост', country: 'RU', open: false },
      { from: 'Россия - 1', country: 'RU', open: false },
    ];
    const t = reachText(22, onlyRu, null);
    expect(t).toMatch(/все они из одной страны/);
    expect(t).not.toMatch(/Не отвечает ни из одной страны/);
    expect(t).not.toMatch(/выключен, завис/);
  });
  it('российские проверяющие расходятся — это не «закрыт только из России»', () => {
    const t = reachText(
      22,
      [
        { from: 'Мост-Москва', country: 'RU', open: true },
        { from: 'Мост-Питер', country: 'RU', open: false },
        { from: 'Германия-1', country: 'DE', open: true },
      ],
      true,
    );
    expect(t).toMatch(/Из России — частично: открыт с Мост-Москва, закрыт с Мост-Питер; из-за рубежа открыт/);
    expect(t).toMatch(/Это не блокировка IP по всей России/);
    expect(t).not.toMatch(/Закрыт только из России/);
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
    // Сокращение в названии вида не превращается в «ssh».
    expect(fleetText(me, [me, { ...other, kind: 'ssh_down' }])).toContain('Германия-1 (SSH недоступен)');
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
  afterEach(() => {
    vi.useRealTimers();
  });
  it('время прошлых дел и записей Журнала — в поясе панели, а не всегда по Москве', () => {
    // Год в дате печатается, только если он не текущий, — фиксируем «сейчас», чтобы тест не зависел от года.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const past = [
      inc({
        id: 'p1',
        title: 'Сервер недоступен — просрочена оплата · Казахстан',
        status: 'resolved',
        openedAt: '2026-09-29T09:37:00Z',
        resolvedAt: '2026-09-29T09:53:00Z',
        resolvedBy: 'auto',
      }),
    ];
    expect(historyText(inc({}), past, 'Asia/Omsk')).toContain('• 29 сентября, 15:37 — Сервер недоступен');
    expect(historyText(inc({}), past, 'Europe/Moscow')).toContain('• 29 сентября, 12:37 — Сервер недоступен');
    const log = [{ at: '2026-09-29T09:40:00Z', action: 'Проверка связи', result: 'success' }];
    expect(changesText(log, 'Asia/Omsk')).toContain('• 29 сентября, 15:40 — Проверка связи');
  });
  it('дата статьи базы знаний — в поясе панели и с годом, а не датой по UTC', () => {
    const doc = {
      title: 'Смена IP',
      content: 'Помогла смена IP.',
      updatedAt: new Date('2026-09-30T21:00:00Z'),
      source: 'Вручную',
    };
    // 1 октября, 03:00 в Омске — по UTC это ещё 30 сентября.
    expect(kbText([doc], 'Asia/Omsk')).toContain('• «Смена IP» (1 октября 2026, Вручную): Помогла смена IP.');
    expect(kbText([doc], 'UTC')).toContain('(30 сентября 2026, Вручную)');
  });
  it('покрытие: что проверено и что нет', () => {
    expect(coverageText({ 'онлайн ноды': true, 'база знаний': false })).toBe(
      'Проверено панелью до разбора: онлайн ноды. Не удалось или не к чему: база знаний.',
    );
  });
});

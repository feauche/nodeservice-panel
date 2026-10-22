import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckHostService,
  classifyTcp,
  combineTcpReports,
  publicIp,
  type TcpObservation,
  type TcpReport,
} from './check-host.service.js';

const rows = (ru: TcpObservation['state'], foreign: TcpObservation['state']): TcpObservation[] =>
  ['ru', 'ru', 'de', 'nl'].map((country, i) => ({
    node: String(i),
    country,
    city: '',
    state: country === 'ru' ? ru : foreign,
    error: null,
  }));
const report = (verdict: TcpReport['verdict'], target = '8.8.8.8:5492'): TcpReport => ({
  verdict,
  target,
  checkedAt: new Date().toISOString(),
  link: null,
  observations: [],
  error: null,
});
afterEach(() => vi.restoreAllMocks());
describe('Доступность Check-Host', () => {
  it('различает РФ, общую недоступность и доступность', () => {
    expect(classifyTcp(rows('failed', 'ok'))).toBe('russia_unreachable');
    expect(classifyTcp(rows('failed', 'failed'))).toBe('port_unreachable');
    expect(classifyTcp(rows('ok', 'ok'))).toBe('reachable');
  });
  it('не считает pending и недостаточные ответы падением', () => {
    expect(classifyTcp(rows('pending', 'ok'))).toBe('unknown');
    expect(classifyTcp(rows('failed', 'ok').slice(1))).toBe('unknown');
  });
  it('РФ ответила не со всех точек, другие страны со всех — «частично недоступен из РФ»', () => {
    const [first, ...rest] = rows('failed', 'ok');
    if (!first) throw new Error('нет строк');
    expect(classifyTcp([{ ...first, state: 'ok' }, ...rest])).toBe('russia_partial');
    // Другие страны ответили не все — это уже не похоже на блокировку из РФ.
    const mixed = rows('failed', 'ok').map((r, i) =>
      i === 0 || i === 3 ? { ...r, state: 'ok' as const } : r,
    );
    mixed[3] = { ...(mixed[3] as TcpObservation), state: 'failed' };
    expect(classifyTcp(mixed)).toBe('unknown');
  });
  it('точка без ответа не портит итог: решают ответившие, если их хватает', () => {
    const point = (node: string, country: string, state: TcpObservation['state']): TcpObservation => ({
      node,
      country,
      city: '',
      state,
      error: null,
    });
    const ru = (state: TcpObservation['state'], last: TcpObservation['state'] = state) => [
      point('ru1', 'ru', state),
      point('ru2', 'ru', state),
      point('ru3', 'ru', last),
    ];
    const foreign = [point('at1', 'at', 'ok'), point('au1', 'au', 'pending'), point('bg1', 'bg', 'ok')];
    expect(classifyTcp([...ru('ok'), ...foreign])).toBe('reachable');
    expect(classifyTcp([...ru('failed', 'pending'), ...foreign])).toBe('russia_unreachable');
    // Ответила одна точка РФ — мало для вывода.
    expect(classifyTcp([point('ru1', 'ru', 'ok'), ...ru('pending').slice(1), ...foreign])).toBe('unknown');
  });
  it('Check-Host: «[null, {message}]» — точка не ответила; ждать её до конца не нужно', async () => {
    vi.useFakeTimers();
    const hosts = Object.fromEntries(
      [
        ['ru1', 'ru'],
        ['ru2', 'ru'],
        ['ru3', 'ru'],
        ['at1', 'at'],
        ['au1', 'au'],
        ['bg1', 'bg'],
      ].map(([n, cc]) => [`${n}.node.check-host.net`, { location: [cc, cc, cc] }]),
    );
    const ok = [{ address: '8.8.8.8', time: 0.05 }];
    const body: Record<string, unknown> = {
      '/nodes/hosts': { nodes: hosts },
      '/check-tcp': {
        ok: 1,
        request_id: 'abc1',
        nodes: Object.fromEntries(Object.entries(hosts).map(([k, v]) => [k, v.location])),
      },
      '/check-result/abc1': {
        ...Object.fromEntries(Object.keys(hosts).map((k) => [k, ok])),
        'au1.node.check-host.net': [null, { message: 'Connect timeout' }],
      },
    };
    const fetch = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(body[path]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const out = new CheckHostService().check('8.8.8.8', 5492);
      await vi.advanceTimersByTimeAsync(2500);
      const result = await out;
      expect(result.verdict).toBe('reachable');
      expect(result.observations.find((r) => r.node === 'au1.node.check-host.net')?.state).toBe('pending');
      // Каталог, запуск и один опрос: австралийскую точку не ждали все 30 секунд.
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it('отклоняет локальные цели', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', '169.254.1.2', 'host.local'])
      expect(publicIp(ip)).toBe(false);
    expect(publicIp('8.8.8.8')).toBe(true);
  });
  it('при недоступном 5492 проверяет 22 и порт ноды', async () => {
    const s = new CheckHostService();
    const check = vi
      .spyOn(s, 'check')
      .mockResolvedValueOnce(report('port_unreachable'))
      .mockResolvedValueOnce(report('reachable', '8.8.8.8:22'))
      .mockResolvedValueOnce(report('port_unreachable', '8.8.8.8:443'));
    const out = await s.checkNode('8.8.8.8', 5492, 443);
    expect(check.mock.calls).toEqual([
      ['8.8.8.8', 5492],
      ['8.8.8.8', 22],
      ['8.8.8.8', 443],
    ]);
    expect(out.verdict).toBe('reachable');
    expect(out.ports).toHaveLength(3);
  });
  it('не проверяет одинаковые порты дважды и не делает fallback при рабочем 5492', async () => {
    const s = new CheckHostService();
    const check = vi.spyOn(s, 'check').mockResolvedValue(report('reachable'));
    await s.checkNode('8.8.8.8', 5492, 5492);
    expect(check).toHaveBeenCalledTimes(1);
  });
  it('если резервный результат неизвестен, не объявляет весь IP недоступным', () => {
    expect(combineTcpReports([report('port_unreachable'), report('unknown')])).toBe('unknown');
    expect(combineTcpReports([report('port_unreachable'), report('russia_unreachable')])).toBe(
      'russia_unreachable',
    );
    // Хоть на одном порту РФ отвечает частично — блокировка не полная.
    expect(combineTcpReports([report('russia_unreachable'), report('russia_partial')])).toBe(
      'russia_partial',
    );
    expect(combineTcpReports([report('russia_partial'), report('reachable')])).toBe('reachable');
  });
  describe('повтор через минуту, когда РФ ответила не со всех точек', () => {
    afterEach(() => {
      vi.useRealTimers();
      CheckHostService.confirmDelayMs = 60_000;
    });
    it('повторилось — «частично недоступен» подтверждён; проверка идёт через минуту', async () => {
      vi.useFakeTimers();
      const s = new CheckHostService();
      const check = vi.spyOn(s, 'check').mockResolvedValue(report('russia_partial', '8.8.8.8:2226'));
      const out = s.checkNode('8.8.8.8', 2226);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await out;
      expect(result).toMatchObject({ verdict: 'russia_partial', confirmed: true });
      // Первая проверка сохраняется: в сообщении — строки «РФ, 16:09» и «РФ, 16:10».
      expect(result.first).toMatchObject({ verdict: 'russia_partial', target: '8.8.8.8:2226' });
      expect(result.first).not.toHaveProperty('first');
      expect(check).toHaveBeenCalledTimes(2);
    });
    it('при повторе РФ отвечает вся — действует свежий итог, без подтверждения', async () => {
      CheckHostService.confirmDelayMs = 0;
      const s = new CheckHostService();
      vi.spyOn(s, 'check')
        .mockResolvedValueOnce(report('russia_partial', '8.8.8.8:2226'))
        .mockResolvedValueOnce(report('reachable', '8.8.8.8:2226'));
      const out = await s.checkNode('8.8.8.8', 2226);
      expect(out.verdict).toBe('reachable');
      expect(out.confirmed).toBeUndefined();
    });
    it('ручная проверка — без повтора; при 5492 частичный ответ тоже добавляет порт 22', async () => {
      const s = new CheckHostService();
      const check = vi
        .spyOn(s, 'check')
        .mockResolvedValueOnce(report('russia_partial'))
        .mockResolvedValueOnce(report('russia_partial', '8.8.8.8:22'));
      const out = await s.checkNode('8.8.8.8', 5492, null, { confirm: false });
      expect(check.mock.calls).toEqual([
        ['8.8.8.8', 5492],
        ['8.8.8.8', 22],
      ]);
      expect(out).toMatchObject({ verdict: 'russia_partial' });
      expect(out.confirmed).toBeUndefined();
    });
  });
  it('ошибка внешнего API возвращает неизвестность', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream unavailable')));
    const out = await new CheckHostService().check('8.8.8.8', 5492);
    expect(out.verdict).toBe('unknown');
    expect(out.error).toContain('upstream');
    vi.unstubAllGlobals();
  });
});

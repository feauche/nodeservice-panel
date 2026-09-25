import type { ReachabilityResult } from '@nodeservice/shared';

/** Пример проверки доступности для моков и тестов: порт SSH открыт со всех, порт 443 закрыт со всех. */
export function sampleReach(
  target = 'de-fra-01',
  mode: 'closed443' | 'partial' | 'open' = 'closed443',
): ReachabilityResult {
  const probe = (from: string, open443: boolean) => ({
    from,
    ok: true,
    error: null,
    ports: [
      { port: 22, open: true, ms: 12 },
      { port: 443, open: open443, ms: open443 ? 14 : null },
    ],
    dns: '203.0.113.7',
  });
  const open443 =
    mode === 'open' ? [true, true, true] : mode === 'partial' ? [true, false, true] : [false, false, false];
  const opened = open443.filter(Boolean).length;
  return {
    target: { name: target, address: '203.0.113.7' },
    probes: [
      probe('nl-ams-02', open443[0] as boolean),
      probe('fi-hel-01', open443[1] as boolean),
      probe('pl-waw-03', open443[2] as boolean),
    ],
    ports: [
      {
        port: 22,
        open: 3,
        closed: 0,
        verdict: 'reachable',
        text: 'Порт 22: открыт со всех (3 проверяющих сервера).',
      },
      {
        port: 443,
        open: opened,
        closed: 3 - opened,
        verdict: opened === 3 ? 'reachable' : opened === 0 ? 'closed_everywhere' : 'partial',
        text: 'Порт 443.',
      },
    ],
    dns: { answers: ['203.0.113.7'], consistent: true },
    notes: [
      'Проверка идёт с других серверов парка, а не из сети пользователей. Если у части пользователей не работает, а отсюда всё открыто, причина может быть в блокировке для их провайдера или региона: отсюда это не видно.',
    ],
  };
}

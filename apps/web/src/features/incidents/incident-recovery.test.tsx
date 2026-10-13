import type { Incident, IncidentEvent, RemnawaveNode } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import { recoverySteps } from './incident-recovery';

const ev = (action: string, extra: Partial<IncidentEvent> = {}): IncidentEvent => ({
  at: '2026-10-12T10:58:00.000Z',
  by: 'auto',
  action,
  result: 'notify',
  ...extra,
});
const dnsLink = {
  label: 'Открыть запись в DNS-интеграциях',
  to: '/integrations/dns',
  search: { record: 'cloudflare|zone|nl1' },
};
const base = (timeline: IncidentEvent[], over: Partial<Incident> = {}): Incident => ({
  id: '0199a000-0000-7000-8000-000000000095',
  nodeUuid: 'e4d05727-94f2-4a1a-a5d3-fb640efd4865',
  diagnostics: null,
  serverId: null,
  serverName: 'Нидерланды - 1',
  kind: 'node_blocked',
  severity: 'crit',
  status: 'open',
  title: 'Падение онлайна · недоступность из РФ',
  detail: '',
  openedAt: '2026-10-12T10:12:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  timeline,
  attempts: [],
  proposal: null,
  snapshot: null,
  analysis: null,
  recovery: { target: 158, usual: 225, before: 512 },
  ...over,
});
const node = { isConnected: true, usersOnline: 120 } as RemnawaveNode;
const moved = [
  ev('Обнаружено мониторингом Remnawave', { result: 'detect' }),
  ev('Адрес ноды изменён в Remnawave', {
    step: 'address',
    tone: 'change',
    detail: '94.183.152.24 → 45.12.8.77',
  }),
  ev('Порт 5492 на новом адресе доступен', {
    step: 'port',
    tone: 'ok',
    detail: 'Из РФ 3 из 3, из других стран 3 из 3.',
  }),
];

describe('Шаги восстановления события (вариант B)', () => {
  it('автозамена не включена: DNS-шаг жёлтый с кнопкой к записи, онлайн ждёт порога', () => {
    const steps = recoverySteps(
      base([
        ...moved,
        ev('DNS-запись nl1.example.ru ведёт на старый адрес', { step: 'dns', tone: 'warn', link: dnsLink }),
      ]),
      node,
    );
    expect(steps.map((s) => [s.key, s.label, s.tone])).toEqual([
      ['address', 'Новый адрес', 'ok'],
      ['port', 'Порт 5492 на новом адресе', 'ok'],
      ['dns', 'DNS-запись nl1.example.ru', 'warn'],
      ['node', 'Связь с Remnawave', 'ok'],
      ['online', 'Онлайн', 'wait'],
    ]);
    expect(steps[2]?.link).toEqual(dnsLink);
  });
  it('онлайн дошёл до порога — шаг зелёный; нет связи — красный', () => {
    const ok = recoverySteps(base(moved), { isConnected: true, usersOnline: 200 } as RemnawaveNode);
    expect(ok.find((s) => s.key === 'online')?.tone).toBe('ok');
    const down = recoverySteps(base(moved), { isConnected: false, usersOnline: 0 } as RemnawaveNode);
    expect(down.find((s) => s.key === 'node')?.tone).toBe('crit');
  });
  it('без смены адреса: шаг порта из проверки в момент обнаружения, адреса и DNS нет', () => {
    const steps = recoverySteps(
      base([ev('Обнаружено мониторингом Remnawave', { result: 'detect' })], {
        diagnostics: {
          source: 'checkhost',
          report: {
            verdict: 'russia_unreachable',
            checkedAt: '2026-10-12T10:12:00.000Z',
            target: '94.183.152.24:5492',
            link: null,
            observations: [],
            error: null,
          },
          online: { before: 512, after: 73 },
        },
      }),
      node,
    );
    expect(steps.map((s) => [s.key, s.label, s.tone])).toEqual([
      ['port', 'Порт 5492', 'crit'],
      ['node', 'Связь с Remnawave', 'ok'],
      ['online', 'Онлайн', 'wait'],
    ]);
  });
  it('закрыто: всё зелёное, онлайн — из итога закрытия, живые данные не важны', () => {
    const steps = recoverySteps(
      base(
        [
          ...moved,
          ev('DNS-запись nl1.example.ru обновлена автоматически', { step: 'dns', tone: 'ok' }),
          ev('Нода снова работает: адрес сменили, порт доступен, онлайн 210 (обычно около 225).', {
            step: 'close',
            tone: 'ok',
            result: 'resolved',
          }),
        ],
        { status: 'resolved', resolvedAt: '2026-10-12T11:03:00.000Z', resolvedBy: 'auto', recovery: null },
      ),
      { isConnected: false, usersOnline: 0 } as RemnawaveNode,
    );
    expect(steps.every((s) => s.tone === 'ok')).toBe(true);
    expect(steps).toHaveLength(5);
  });
});

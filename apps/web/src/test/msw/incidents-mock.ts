import {
  AUTH_PROBLEM,
  type AutofixPresetKey,
  INCIDENTS_SETTINGS_DEFAULTS,
  type Incident,
  type IncidentEvent,
  type IncidentsSettings,
  incidentsSettingsUpdateSchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';
import { mockSecurity } from './security-mock';
import { mockServers } from './servers-mock';

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const ev = (
  min: number,
  by: 'auto' | 'manual',
  action: string,
  result: IncidentEvent['result'],
): IncidentEvent => ({
  at: iso(min),
  by,
  action,
  result,
});

interface IncidentsMock {
  items: Incident[];
  settings: IncidentsSettings;
}
export const mockIncidents: IncidentsMock = { items: [], settings: { ...INCIDENTS_SETTINGS_DEFAULTS } };

let seq = 0;
const uid = () => {
  seq += 1;
  return `0192d000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

export function seedIncidents(): void {
  seq = 0;
  const s0 = mockServers.items[0]?.id ?? null;
  const s1 = mockServers.items[1]?.id ?? null;
  mockIncidents.settings = { ...INCIDENTS_SETTINGS_DEFAULTS };
  mockIncidents.items = [
    {
      id: uid(),
      serverId: s1,
      serverName: 'nl-ams-02',
      kind: 'ssh_down',
      severity: 'crit',
      status: 'open',
      title: 'SSH недоступен · nl-ams-02',
      detail: 'Панель не может подключиться к серверу по SSH — возможно, упала сеть провайдера.',
      openedAt: iso(12),
      resolvedAt: null,
      resolvedBy: null,
      timeline: [
        ev(12, 'auto', 'Обнаружено: sSH недоступен', 'detect'),
        ev(11, 'auto', 'Уведомление администратору', 'notify'),
      ],
    },
    {
      id: uid(),
      serverId: s0,
      serverName: 'de-fra-01',
      kind: 'cpu_high',
      severity: 'warn',
      status: 'open',
      title: 'Высокая нагрузка на CPU · de-fra-01',
      detail: 'CPU держится на 94% дольше 5 минут.',
      openedAt: iso(7),
      resolvedAt: null,
      resolvedBy: null,
      timeline: [ev(7, 'auto', 'Обнаружено: высокая нагрузка на cpu', 'detect')],
    },
    {
      id: uid(),
      serverId: s0,
      serverName: 'de-fra-01',
      kind: 'disk_high',
      severity: 'warn',
      status: 'resolved',
      title: 'Диск заполняется · de-fra-01',
      detail: 'Логи Xray заняли место, диск подошёл к 87%.',
      openedAt: iso(180),
      resolvedAt: iso(176),
      resolvedBy: 'auto',
      timeline: [
        ev(180, 'auto', 'Обнаружено: диск заполняется', 'detect'),
        ev(178, 'auto', 'Освободить диск', 'applied'),
        ev(176, 'auto', 'Проблема исчезла — инцидент закрыт', 'resolved'),
      ],
    },
    {
      id: uid(),
      serverId: s1,
      serverName: 'nl-ams-02',
      kind: 'agent_offline',
      severity: 'crit',
      status: 'resolved',
      title: 'Агент не в сети · nl-ams-02',
      detail: 'Агент не выходил на связь 4 минуты.',
      openedAt: iso(1440),
      resolvedAt: iso(1436),
      resolvedBy: 'manual',
      timeline: [
        ev(1440, 'auto', 'Обнаружено: агент не в сети', 'detect'),
        ev(1437, 'manual', 'Закрыт администратором', 'resolved'),
      ],
    },
  ];
}
seedIncidents();

function counts() {
  const open = mockIncidents.items.filter((i) => i.status !== 'resolved');
  return {
    open: open.length,
    crit: open.filter((i) => i.severity === 'crit').length,
    warn: open.filter((i) => i.severity === 'warn').length,
  };
}

function stepUp() {
  return mockSecurity.stepUpFresh
    ? null
    : HttpResponse.json(
        { type: AUTH_PROBLEM.stepUp, title: 'Подтверди пароль', status: 403, detail: 'Подтверди пароль' },
        { status: 403 },
      );
}

const PRESET_TITLE: Record<AutofixPresetKey, string> = {
  restart_xray: 'Перезапустить Xray',
  restart_node: 'Перезапустить контейнер ноды',
  free_disk: 'Освободить диск',
};

export const incidentsHandlers = [
  http.get('/api/incidents', ({ request }) => {
    const status = (new URL(request.url).searchParams.get('status') ?? 'all') as 'all' | 'open' | 'resolved';
    const items = mockIncidents.items.filter((i) =>
      status === 'open' ? i.status !== 'resolved' : status === 'resolved' ? i.status === 'resolved' : true,
    );
    return HttpResponse.json({ items, counts: counts() });
  }),
  http.get('/api/incidents/:id', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    return inc
      ? HttpResponse.json(inc)
      : HttpResponse.json(
          { type: 'about:blank', title: 'Не найдено', status: 404, detail: 'нет' },
          { status: 404 },
        );
  }),
  http.post('/api/incidents/:id/acknowledge', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return HttpResponse.json({ status: 404 }, { status: 404 });
    if (inc.status === 'open') {
      inc.status = 'acknowledged';
      inc.timeline = [...inc.timeline, ev(0, 'manual', 'Взято в работу администратором', 'notify')];
    }
    return HttpResponse.json(inc);
  }),
  http.post('/api/incidents/:id/resolve', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return HttpResponse.json({ status: 404 }, { status: 404 });
    inc.status = 'resolved';
    inc.resolvedAt = iso(0);
    inc.resolvedBy = 'manual';
    inc.timeline = [...inc.timeline, ev(0, 'manual', 'Закрыт администратором', 'resolved')];
    return HttpResponse.json(inc);
  }),
  http.post('/api/incidents/:id/autofix', async ({ params, request }) => {
    const su = stepUp();
    if (su) return su;
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return HttpResponse.json({ status: 404 }, { status: 404 });
    const body = (await request.json()) as { preset: AutofixPresetKey };
    inc.timeline = [
      ...inc.timeline,
      ev(0, 'manual', PRESET_TITLE[body.preset], 'applied'),
      ev(0, 'auto', 'Проблема исчезла — инцидент закрыт', 'helped'),
    ];
    inc.status = 'resolved';
    inc.resolvedAt = iso(0);
    inc.resolvedBy = 'auto';
    return HttpResponse.json(inc);
  }),
  http.get('/api/settings/incidents', () => HttpResponse.json(mockIncidents.settings)),
  http.put('/api/settings/incidents', async ({ request }) => {
    const parsed = incidentsSettingsUpdateSchema.safeParse(await request.json());
    if (!parsed.success)
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Данные не прошли проверку',
          status: 400,
          detail: 'Проверь поля',
          errors: parsed.error.issues.map((i) => ({ path: String(i.path[0]), message: i.message })),
        },
        { status: 400 },
      );
    const defined = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    mockIncidents.settings = { ...mockIncidents.settings, ...defined };
    return HttpResponse.json(mockIncidents.settings);
  }),
];

import {
  type ActionKey,
  actionMeta,
  INCIDENTS_SETTINGS_DEFAULTS,
  type Incident,
  type IncidentAttempt,
  type IncidentEvent,
  type IncidentsSettings,
  incidentsSettingsUpdateSchema,
  incidentWeekStats,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/** Старые серверы, к которым привязаны события из истории: самих серверов в панели больше нет. */
const OLD_SERVER_FRA = '0192f100-0000-7000-8000-000000000001';
const OLD_SERVER_AMS = '0192f100-0000-7000-8000-000000000002';

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const ev = (
  min: number,
  by: 'auto' | 'manual',
  action: string,
  result: IncidentEvent['result'],
  level?: IncidentEvent['level'],
): IncidentEvent => ({ at: iso(min), by, action, result, ...(level ? { level } : {}) });

interface IncidentsMock {
  items: Incident[];
  settings: IncidentsSettings;
}
export const mockIncidents: IncidentsMock = {
  items: [],
  settings: { ...INCIDENTS_SETTINGS_DEFAULTS },
};

let seq = 0;
const uid = () => {
  seq += 1;
  return `0192d000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

const finishedAttempt = (
  min: number,
  action: ActionKey,
  by: 'auto' | 'manual',
  status: IncidentAttempt['status'],
  notes: [string, string, string, string],
  log: string,
): IncidentAttempt => {
  const a = actionMeta(action);
  const ok = status === 'helped';
  return {
    id: uid(),
    action,
    level: a.level,
    by,
    status,
    startedAt: iso(min),
    finishedAt: iso(min - 1),
    steps: [
      {
        key: 'precheck',
        label: 'Пред-проверка',
        status: 'ok',
        startedAt: iso(min),
        finishedAt: iso(min),
        note: notes[0],
      },
      {
        key: 'action',
        label: a.title,
        status: 'ok',
        startedAt: iso(min),
        finishedAt: iso(min),
        note: notes[1],
      },
      {
        key: 'postcheck',
        label: 'Пост-проверка',
        status: ok ? 'ok' : 'failed',
        startedAt: iso(min),
        finishedAt: iso(min - 1),
        note: notes[2],
      },
      {
        key: 'rollback',
        label: 'Откат',
        status: 'skipped',
        startedAt: null,
        finishedAt: null,
        note: notes[3],
      },
    ],
    log,
  };
};

export function seedIncidents(): void {
  seq = 0;
  const s0 = OLD_SERVER_FRA;
  const s1 = OLD_SERVER_AMS;
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
        ev(12, 'auto', 'Обнаружено: SSH недоступен', 'detect', 'T0'),
        ev(11, 'auto', 'Уведомление администратору', 'notify'),
      ],
      attempts: [],
      proposal: null,
      snapshot: { cpu: 12, mem: 41, disk: 20, node: 'running', agentStatus: 'online', agentVersion: '0.6.1' },
      analysis: null,
    },
    {
      id: uid(),
      serverId: s0,
      serverName: 'de-fra-01',
      kind: 'cpu_high',
      severity: 'warn',
      status: 'open',
      title: 'Высокая нагрузка на CPU · de-fra-01',
      detail: 'CPU держится на 96% дольше 5 мин (порог 90%).',
      openedAt: iso(7),
      resolvedAt: null,
      resolvedBy: null,
      timeline: [
        ev(7, 'auto', 'Обнаружено: CPU 96 % дольше 5 мин', 'detect', 'T0'),
        ev(7, 'auto', 'Предложено: Перезапустить контейнер ноды — ждёт подтверждения', 'escalate', 'T2'),
      ],
      attempts: [],
      proposal: {
        action: 'restart_node',
        level: 'T2',
        reason: 'первый шаг цепочки',
        proposedAt: iso(5),
      },
      snapshot: { cpu: 96, mem: 71, disk: 63, node: 'running', agentStatus: 'online', agentVersion: '0.6.1' },
      analysis: null,
    },
    {
      id: uid(),
      serverId: s0,
      serverName: 'de-fra-01',
      kind: 'disk_high',
      severity: 'warn',
      status: 'resolved',
      title: 'Диск заполняется · de-fra-01',
      detail: 'Диск держался на 94% дольше 5 мин (порог 85%).',
      openedAt: iso(180),
      resolvedAt: iso(176),
      resolvedBy: 'auto',
      timeline: [
        ev(180, 'auto', 'Обнаружено: диск 94 % дольше 5 мин', 'detect', 'T0'),
        ev(179, 'auto', 'Выполнено: Освободить диск', 'applied', 'T1'),
        ev(177, 'auto', 'Пост-проверка: диск 71 % < 80 % — помогло', 'helped', 'T1'),
        ev(176, 'auto', 'Проблема устранена — событие закрыт', 'resolved'),
      ],
      attempts: [
        finishedAttempt(
          179,
          'free_disk',
          'auto',
          'helped',
          [
            'агент в сети, диск 94 %, нода свободна',
            'выполнено за 34.1 с',
            'диск 71 % < 80 %',
            'не нужен: удаляется только мусор',
          ],
          "$ sh -c 'journalctl --vacuum-size=200M 2>&1; docker system prune -f 2>&1; true'\nVacuuming done, freed 1.3G of archived journals\nTotal reclaimed space: 3.9GB\n",
        ),
      ],
      proposal: null,
      snapshot: { cpu: 22, mem: 55, disk: 94, node: 'running', agentStatus: 'online', agentVersion: '0.6.1' },
      analysis: null,
    },
    {
      id: uid(),
      serverId: s1,
      serverName: 'nl-ams-02',
      kind: 'disk_high',
      severity: 'warn',
      status: 'resolved',
      title: 'Диск заполняется · nl-ams-02',
      detail: 'Диск держался на 87% дольше 5 мин (порог 85%).',
      openedAt: iso(400),
      resolvedAt: iso(15),
      resolvedBy: 'manual',
      timeline: [
        ev(400, 'auto', 'Обнаружено: диск 87 % дольше 5 мин', 'detect', 'T0'),
        ev(380, 'manual', 'Выполнено: Освободить диск', 'applied', 'T1'),
        ev(379, 'manual', 'Пост-проверка: диск 86 % — не ниже 80 % — не помогло', 'failed', 'T1'),
        ev(370, 'manual', 'Выполнено: Очистить кэш apt', 'applied', 'T1'),
        ev(369, 'manual', 'Пост-проверка: диск 86 % — не ниже 80 % — не помогло', 'failed', 'T1'),
        ev(368, 'auto', 'Найти, что занимает диск: список получен', 'notify', 'T0'),
        ev(16, 'manual', 'Выполнено: Очистить временные файлы', 'applied', 'T2'),
        ev(15, 'manual', 'Пост-проверка: диск 41 % < 80 % — помогло', 'helped', 'T2'),
        ev(15, 'manual', 'Проблема устранена — событие закрыт', 'resolved'),
      ],
      attempts: [
        finishedAttempt(
          380,
          'free_disk',
          'manual',
          'not_helped',
          ['агент в сети, диск 87 %', 'выполнено за 1.7 с', 'диск 86 % — не ниже 80 %', 'не нужен'],
          'Vacuuming done, freed 0B of archived journals\n',
        ),
        finishedAttempt(
          370,
          'apt_clean',
          'manual',
          'not_helped',
          ['агент в сети, диск 86 %', 'выполнено за 3.3 с', 'диск 86 % — не ниже 80 %', 'не нужен'],
          'Reading package lists...\n',
        ),
        {
          ...finishedAttempt(
            368,
            'disk_inspect',
            'auto',
            'done',
            ['SSH отвечает', 'получен список', '', ''],
            '== Файлы больше 200 МБ ==\n20G\t/tmp/fill\n20G\t/tmp/fill2\n',
          ),
          steps: [
            {
              key: 'precheck',
              label: 'Пред-проверка',
              status: 'ok',
              startedAt: iso(368),
              finishedAt: iso(368),
              note: 'SSH отвечает',
            },
            {
              key: 'action',
              label: 'Найти, что занимает диск',
              status: 'ok',
              startedAt: iso(368),
              finishedAt: iso(368),
              note: 'выполнено за 8.0 с',
            },
            {
              key: 'postcheck',
              label: 'Пост-проверка',
              status: 'skipped',
              startedAt: null,
              finishedAt: null,
              note: null,
            },
            {
              key: 'rollback',
              label: 'Откат',
              status: 'skipped',
              startedAt: null,
              finishedAt: null,
              note: null,
            },
          ],
        },
        finishedAttempt(
          16,
          'tmp_clean',
          'manual',
          'helped',
          ['SSH отвечает', 'Освобождено: 40960 МБ', 'диск 41 % < 80 %', 'нет: удалённое не восстановить'],
          'Освобождено: 40960 МБ\n',
        ),
      ],
      proposal: null,
      snapshot: { cpu: 9, mem: 30, disk: 87, node: 'running', agentStatus: 'online', agentVersion: '0.6.1' },
      analysis: null,
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
        ev(1440, 'auto', 'Обнаружено: агент не в сети', 'detect', 'T0'),
        ev(1437, 'manual', 'Закрыт администратором', 'resolved'),
      ],
      attempts: [],
      proposal: null,
      snapshot: { cpu: 12, mem: 41, disk: 20, node: 'running', agentStatus: 'online', agentVersion: '0.6.1' },
      analysis: null,
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

const problem = (status: number, detail: string) =>
  HttpResponse.json({ type: 'about:blank', title: detail, status, detail }, { status });

export const incidentsHandlers = [
  http.get('/api/incidents', ({ request }) => {
    const url = new URL(request.url);
    const status = (url.searchParams.get('status') ?? 'all') as 'all' | 'open' | 'resolved';
    const openedFrom = url.searchParams.get('openedFrom');
    // Как в настоящем API (0.106.0): `waves=grouped` — события нод, вошедших в волну, не повторяются.
    const grouped = url.searchParams.get('waves') === 'grouped';
    const inWave = new Set(
      mockIncidents.items.flatMap((i) =>
        i.kind === 'wave' ? (i.snapshot?.fleet?.members ?? []).map((m) => m.incidentId ?? '') : [],
      ),
    );
    const filtered = mockIncidents.items
      .filter((i) =>
        status === 'open' ? i.status !== 'resolved' : status === 'resolved' ? i.status === 'resolved' : true,
      )
      .filter((i) => !grouped || !inWave.has(i.id))
      .filter((i) => !openedFrom || new Date(i.openedAt).getTime() >= new Date(openedFrom).getTime())
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
    // «Открытые» всегда целиком, как в настоящем API — резать их постранично не нужно, их и так мало.
    if (status === 'open')
      return HttpResponse.json({
        items: filtered,
        counts: counts(),
        page: 1,
        pageSize: Math.max(filtered.length, 1),
        total: filtered.length,
        totalPages: filtered.length > 0 ? 1 : 0,
      });
    const pageSize = Number(url.searchParams.get('pageSize') ?? 30);
    const total = filtered.length;
    const totalPages = Math.max(0, Math.ceil(total / pageSize));
    // Как в настоящем API: со смещением строка задана точно, за концом списка — пусто.
    const offset = url.searchParams.get('offset');
    if (offset !== null) {
      const from = Number(offset);
      return HttpResponse.json({
        items: filtered.slice(from, from + pageSize),
        counts: counts(),
        page: Math.floor(from / pageSize) + 1,
        pageSize,
        total,
        totalPages,
      });
    }
    const page = totalPages === 0 ? 1 : Math.min(Number(url.searchParams.get('page') ?? 1), totalPages);
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);
    return HttpResponse.json({ items, counts: counts(), page, pageSize, total, totalPages });
  }),
  http.get('/api/incidents/week-stats', () =>
    HttpResponse.json(incidentWeekStats(mockIncidents.items, Date.now())),
  ),
  http.delete('/api/incidents/resolved', () => {
    const before = mockIncidents.items.length;
    mockIncidents.items = mockIncidents.items.filter((i) => i.status !== 'resolved');
    return HttpResponse.json({ deleted: before - mockIncidents.items.length });
  }),
  http.delete('/api/incidents/:id', ({ params }) => {
    const idx = mockIncidents.items.findIndex((i) => i.id === params.id);
    if (idx < 0) return problem(404, 'Событие не найден.');
    mockIncidents.items.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/incidents/:id', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    return inc ? HttpResponse.json(inc) : problem(404, 'Событие не найден.');
  }),
  http.post('/api/incidents/:id/acknowledge', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return problem(404, 'Событие не найден.');
    if (inc.status === 'open') {
      inc.status = 'acknowledged';
      inc.timeline = [...inc.timeline, ev(0, 'manual', 'Взято в работу администратором', 'notify')];
    }
    return HttpResponse.json(inc);
  }),
  http.post('/api/incidents/:id/resolve', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return problem(404, 'Событие не найден.');
    inc.status = 'resolved';
    inc.resolvedAt = iso(0);
    inc.resolvedBy = 'manual';
    inc.proposal = null;
    inc.timeline = [...inc.timeline, ev(0, 'manual', 'Закрыт администратором', 'resolved')];
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
          detail: 'Проверьте поля',
          errors: parsed.error.issues.map((i) => ({ path: String(i.path[0]), message: i.message })),
        },
        { status: 400 },
      );
    const defined = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    mockIncidents.settings = { ...mockIncidents.settings, ...defined };
    return HttpResponse.json(mockIncidents.settings);
  }),
];

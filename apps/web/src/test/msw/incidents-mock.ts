import {
  type ActionKey,
  type AutofixPolicy,
  actionByKey,
  actionMeta,
  DEFAULT_AUTOFIX_POLICY,
  INCIDENT_ACTIONS,
  INCIDENT_CHAINS,
  INCIDENT_KIND_META,
  INCIDENT_KINDS,
  INCIDENTS_SETTINGS_DEFAULTS,
  type Incident,
  type IncidentAttempt,
  type IncidentEvent,
  type IncidentKind,
  type IncidentPolicyResponse,
  type IncidentsSettings,
  incidentPolicyUpdateSchema,
  incidentsSettingsUpdateSchema,
  resolveIncidentRequestSchema,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';
import { mockServers } from './servers-mock';

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
  /** Сколько длится каждый шаг попытки в моке: в тестах быстро, в браузере — как на живой ноде. */
  stepMs: number;
  /** Какие действия «помогают» в моке (остальные — не помогают → предложение следующего шага). */
  helps: Set<ActionKey>;
}
export const mockIncidents: IncidentsMock = {
  items: [],
  settings: { ...INCIDENTS_SETTINGS_DEFAULTS },
  stepMs: 30,
  helps: new Set<ActionKey>([
    'free_disk',
    'restart_node',
    'node_up',
    'agent_reinstall',
    'apt_clean',
    'tmp_clean',
  ]),
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
        ev(12, 'auto', 'Обнаружено: SSH недоступен', 'detect', 'T0'),
        ev(11, 'auto', 'Уведомление администратору', 'notify'),
      ],
      attempts: [],
      proposal: null,
      snapshot: { cpu: 12, mem: 41, disk: 20, node: 'running', agentStatus: 'online', agentVersion: '0.6.1' },
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
        ev(176, 'auto', 'Проблема устранена — инцидент закрыт', 'resolved'),
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
        ev(15, 'manual', 'Проблема устранена — инцидент закрыт', 'resolved'),
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

/** Имитация исполнителя: шаги идут по таймеру, исход — по mockIncidents.helps. */
function runAttempt(inc: Incident, action: ActionKey, by: 'auto' | 'manual'): void {
  const a = actionMeta(action);
  const attempt: IncidentAttempt = {
    id: uid(),
    action,
    level: a.level,
    by,
    status: 'running',
    startedAt: iso(0),
    finishedAt: null,
    steps: [
      {
        key: 'precheck',
        label: 'Пред-проверка',
        status: 'running',
        startedAt: iso(0),
        finishedAt: null,
        note: null,
      },
      { key: 'action', label: a.title, status: 'pending', startedAt: null, finishedAt: null, note: null },
      {
        key: 'postcheck',
        label: 'Пост-проверка',
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        note: null,
      },
      { key: 'rollback', label: 'Откат', status: 'pending', startedAt: null, finishedAt: null, note: null },
    ],
    log: '',
  };
  inc.attempts = [...inc.attempts, attempt];
  inc.proposal = null;
  if (inc.status === 'open' && by === 'manual') inc.status = 'acknowledged';
  const step = (i: number, patch: Partial<IncidentAttempt['steps'][number]>) => {
    const s = attempt.steps[i];
    if (s) attempt.steps[i] = { ...s, ...patch };
  };
  const t = mockIncidents.stepMs;
  setTimeout(() => {
    step(0, { status: 'ok', finishedAt: iso(0), note: 'агент в сети, нода свободна' });
    step(1, { status: 'running', startedAt: iso(0) });
    attempt.log += `$ ${a.summary}\n`;
  }, t);
  setTimeout(() => {
    step(1, { status: 'ok', finishedAt: iso(0), note: 'выполнено за 1.2 с' });
    attempt.log += 'ok\n';
    step(2, { status: 'running', startedAt: iso(0) });
    inc.timeline = [...inc.timeline, ev(0, by, `Выполнено: ${a.title}`, 'applied', a.level)];
  }, t * 2);
  setTimeout(() => {
    const helped = mockIncidents.helps.has(action);
    step(2, {
      status: helped ? 'ok' : 'failed',
      finishedAt: iso(0),
      note: helped ? 'метрика ниже порога' : 'метрика не ниже порога',
    });
    step(3, { status: 'skipped', note: a.rollbackNote ?? 'не потребовался' });
    attempt.status = helped ? 'helped' : 'not_helped';
    attempt.finishedAt = iso(0);
    if (helped) {
      inc.timeline = [
        ...inc.timeline,
        ev(0, by, 'Пост-проверка: метрика ниже порога — помогло', 'helped', a.level),
        ev(0, by, 'Проблема устранена — инцидент закрыт', 'resolved'),
      ];
      inc.status = 'resolved';
      inc.resolvedAt = iso(0);
      inc.resolvedBy = by;
    } else {
      inc.timeline = [
        ...inc.timeline,
        ev(0, by, 'Пост-проверка: метрика не ниже порога — не помогло', 'failed', a.level),
      ];
      const chain = INCIDENT_CHAINS[inc.kind as IncidentKind];
      const next = chain[chain.indexOf(action) + 1];
      if (next) {
        const n = actionMeta(next);
        inc.proposal = {
          action: next,
          level: n.level,
          reason: `«${a.title}» не помогло`,
          proposedAt: iso(0),
        };
        inc.timeline = [
          ...inc.timeline,
          ev(
            0,
            'auto',
            n.level === 'T3'
              ? `Следующий шаг только вручную: ${n.title}`
              : `Предложено: ${n.title} — ждёт подтверждения`,
            'escalate',
            n.level,
          ),
        ];
      } else {
        inc.timeline = [
          ...inc.timeline,
          ev(0, 'auto', 'Шаги цепочки исчерпаны — нужно разбираться вручную', 'escalate'),
        ];
      }
    }
  }, t * 3);
}

function policyResponse(): IncidentPolicyResponse {
  const since = Date.now() - 30 * 86_400_000;
  const paused =
    mockIncidents.settings.pausedUntil && new Date(mockIncidents.settings.pausedUntil).getTime() > Date.now()
      ? mockIncidents.settings.pausedUntil
      : null;
  return {
    autofixEnabled: mockIncidents.settings.autofixEnabled,
    pausedUntil: paused,
    cooldownMinutes: mockIncidents.settings.autofixCooldownMinutes,
    items: INCIDENT_KINDS.map((kind) => {
      const attempts = mockIncidents.items
        .filter((i) => i.kind === kind)
        .flatMap((i) => i.attempts)
        .filter((at) => new Date(at.startedAt).getTime() > since);
      const chain = INCIDENT_CHAINS[kind].map((key) => {
        const a = actionByKey(key);
        return { key, title: a.title, level: a.level };
      });
      return {
        kind,
        label: INCIDENT_KIND_META[kind].label,
        component: INCIDENT_KIND_META[kind].component,
        policy: (mockIncidents.settings.policy[kind] as AutofixPolicy | undefined) ?? DEFAULT_AUTOFIX_POLICY,
        autoAvailable: chain.some((c) => c.level === 'T1'),
        chain,
        stats: {
          runs: attempts.length,
          helped: attempts.filter((r) => r.status === 'helped').length,
          lastAt: attempts.length
            ? (attempts
                .map((r) => r.startedAt)
                .sort()
                .at(-1) ?? null)
            : null,
        },
      };
    }),
  };
}

export const incidentsHandlers = [
  http.get('/api/incidents', ({ request }) => {
    const status = (new URL(request.url).searchParams.get('status') ?? 'all') as 'all' | 'open' | 'resolved';
    const items = mockIncidents.items.filter((i) =>
      status === 'open' ? i.status !== 'resolved' : status === 'resolved' ? i.status === 'resolved' : true,
    );
    return HttpResponse.json({ items, counts: counts() });
  }),
  http.get('/api/incidents/policy', () => HttpResponse.json(policyResponse())),
  http.patch('/api/incidents/policy', async ({ request }) => {
    const parsed = incidentPolicyUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return problem(400, 'Данные не прошли проверку');
    if (parsed.data.autofixEnabled !== undefined)
      mockIncidents.settings.autofixEnabled = parsed.data.autofixEnabled;
    for (const [k, v] of Object.entries(parsed.data.policy ?? {}))
      mockIncidents.settings.policy[k] = v as AutofixPolicy;
    if (parsed.data.pauseMinutes !== undefined)
      mockIncidents.settings.pausedUntil =
        parsed.data.pauseMinutes > 0
          ? new Date(Date.now() + parsed.data.pauseMinutes * 60_000).toISOString()
          : null;
    return HttpResponse.json(policyResponse());
  }),
  http.delete('/api/incidents/resolved', () => {
    const before = mockIncidents.items.length;
    mockIncidents.items = mockIncidents.items.filter((i) => i.status !== 'resolved');
    return HttpResponse.json({ deleted: before - mockIncidents.items.length });
  }),
  http.delete('/api/incidents/:id', ({ params }) => {
    const idx = mockIncidents.items.findIndex((i) => i.id === params.id);
    if (idx < 0) return problem(404, 'Инцидент не найден.');
    mockIncidents.items.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/incidents/:id', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    return inc ? HttpResponse.json(inc) : problem(404, 'Инцидент не найден.');
  }),
  http.post('/api/incidents/:id/acknowledge', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return problem(404, 'Инцидент не найден.');
    if (inc.status === 'open') {
      inc.status = 'acknowledged';
      inc.timeline = [...inc.timeline, ev(0, 'manual', 'Взято в работу администратором', 'notify')];
    }
    return HttpResponse.json(inc);
  }),
  http.post('/api/incidents/:id/resolve', async ({ params, request }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return problem(404, 'Инцидент не найден.');
    const body = resolveIncidentRequestSchema.safeParse(await request.json().catch(() => ({})));
    const stopWatch = body.success && body.data.stopNodeWatch === true && inc.kind === 'node_down';
    if (stopWatch) {
      const srv = mockServers.items.find((s) => s.id === inc.serverId);
      if (srv) {
        srv.nodeWatch = 'off';
        srv.node = null;
      }
      inc.timeline = [
        ...inc.timeline,
        ev(0, 'manual', 'Слежение за нодой на этом сервере выключено', 'notify'),
      ];
    }
    inc.status = 'resolved';
    inc.resolvedAt = iso(0);
    inc.resolvedBy = 'manual';
    inc.proposal = null;
    inc.timeline = [...inc.timeline, ev(0, 'manual', 'Закрыт администратором', 'resolved')];
    return HttpResponse.json(inc);
  }),
  http.post('/api/incidents/:id/actions/:action/run', ({ params }) => {
    const inc = mockIncidents.items.find((i) => i.id === params.id);
    if (!inc) return problem(404, 'Инцидент не найден.');
    if (inc.status === 'resolved') return problem(409, 'Инцидент уже закрыт.');
    const key = String(params.action) as ActionKey;
    const a = INCIDENT_ACTIONS.find((x) => x.key === key);
    if (!a || !a.kinds.includes(inc.kind)) return problem(400, 'Это действие не подходит к инциденту.');
    if (a.terminal)
      return problem(400, 'Действие уровня T3 панель не выполняет — только вручную в терминале.');
    if (inc.attempts.some((x) => x.status === 'running'))
      return problem(409, 'По инциденту уже идёт действие — дождись его конца.');
    runAttempt(inc, key, 'manual');
    return HttpResponse.json(inc, { status: 202 });
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

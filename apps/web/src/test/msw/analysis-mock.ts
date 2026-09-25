import {
  analysisAskRequestSchema,
  INCIDENT_CHART_METRIC,
  type Incident,
  type IncidentAnalysis,
  type IncidentKind,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockAssistant } from './assistant-mock';
import { mockIncidents } from './incidents-mock';
import { sampleReach } from './reach-sample';

/** Управление моком разбора: в тестах шаги быстрые, в браузере (см. mocks/browser.ts) — медленнее. */
export const mockAnalysis = { stepMs: 30, fail: false };

const problem = (status: number, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

type Body = Pick<IncidentAnalysis, 'verdict' | 'confidence' | 'evidence' | 'unknown' | 'nextAction'>;

const BODIES: Record<IncidentKind, Body> = {
  disk_high: {
    verdict:
      'Диск занят временными файлами: 27 ГБ в /tmp старше часа. Очистка журнала и кэша не помогла, потому что дело не в них.',
    confidence: 'high',
    evidence: [
      { source: 'metric', text: 'Диск вырос с 62 % до 91 % за 2 часа, рост ровный, около 14 ГБ в час.' },
      { source: 'inspect', text: 'Временных файлов старше часа: 27 ГБ, больше всего в /tmp/export.' },
      { source: 'attempt', text: 'Очистка журнала, образов и кэша освободила 0,4 ГБ: они не причина.' },
      { source: 'agent', text: 'Нода работает, CPU 5 %: сбой не в нагрузке.' },
    ],
    unknown:
      'Не видно, кто пишет в /tmp/export: логи ноды и процессов ассистент пока не читает. Если файлы появляются снова, причину стоит искать в самом сервисе.',
    nextAction: 'tmp_clean',
  },
  cpu_high: {
    verdict: 'Процессор загружен без пауз: CPU держится выше порога и не снижается после выхода из пика.',
    confidence: 'medium',
    evidence: [
      { source: 'metric', text: 'CPU выше 90 % весь период наблюдения, спадов нет.' },
      { source: 'agent', text: 'Агент в сети, память 41 %: нехватки памяти нет.' },
    ],
    unknown: 'Не видно, какой именно процесс грузит процессор: список процессов ассистент пока не читает.',
    nextAction: 'restart_node',
  },
  mem_high: {
    verdict: 'Память занята почти целиком, рост ровный: похоже на утечку в контейнере ноды.',
    confidence: 'low',
    evidence: [{ source: 'metric', text: 'Память растёт без спадов весь период наблюдения.' }],
    unknown: 'Данных о процессах и логах нет, поэтому это предположение.',
    nextAction: 'restart_node',
  },
  node_down: {
    verdict: 'Контейнер ноды остановлен, а сервер и агент при этом работают: причина внутри контейнера.',
    confidence: 'medium',
    evidence: [
      { source: 'agent', text: 'Агент в сети, SSH отвечает.' },
      { source: 'other', text: 'Зонд видит контейнер остановленным.' },
    ],
    unknown: 'Логи ноды ассистент пока не читает, поэтому причину остановки назвать нельзя.',
    nextAction: 'node_up',
  },
  agent_offline: {
    verdict: 'Агент перестал выходить на связь. Похоже, остановился сервис агента, а не весь сервер.',
    confidence: 'medium',
    evidence: [{ source: 'agent', text: 'Агент не выходил на связь дольше двух минут.' }],
    unknown: null,
    nextAction: 'agent_reinstall',
  },
  ssh_down: {
    verdict: 'Сервер не отвечает по SSH. Панель сама ничего сделать не может.',
    confidence: 'low',
    evidence: [{ source: 'other', text: 'Проверка связи по SSH не проходит.' }],
    unknown: 'Причину без доступа к серверу установить нельзя.',
    nextAction: null,
  },
};

const iso = () => new Date().toISOString();
const find = (id: unknown): Incident | undefined => mockIncidents.items.find((i) => i.id === id);

function steps(inc: Incident): string[] {
  const metric = INCIDENT_CHART_METRIC[inc.kind];
  return [
    'Читаю снимок сигналов и хронологию',
    ...(metric
      ? [`Смотрю историю: ${metric === 'cpuPct' ? 'CPU' : metric === 'memPct' ? 'память' : 'диск'}`]
      : []),
    'Формулирую вывод',
  ];
}

export const analysisHandlers = [
  http.post('/api/incidents/:id/analysis', ({ params }) => {
    const inc = find(params.id);
    if (!inc) return problem(404, 'Инцидент не найден.');
    if (!mockAssistant.enabled)
      return problem(409, 'Ассистент выключен: задайте провайдера, ключ и модель в «Настройки → Ассистент».');
    if (inc.analysis?.status === 'running') return problem(409, 'Разбор уже идёт.');
    const list = steps(inc);
    const base: IncidentAnalysis = {
      status: 'running',
      startedAt: iso(),
      finishedAt: null,
      steps: [list[0] as string],
      verdict: null,
      confidence: null,
      evidence: [],
      unknown: null,
      nextAction: null,
      basedOn: { attempts: inc.attempts.length, resolved: inc.status === 'resolved' },
      model: mockAssistant.model,
      error: null,
      thread: [],
    };
    inc.analysis = base;
    list.slice(1).forEach((_, i) => {
      setTimeout(
        () => {
          if (inc.analysis?.startedAt !== base.startedAt) return;
          inc.analysis = { ...inc.analysis, steps: list.slice(0, i + 2) };
        },
        mockAnalysis.stepMs * (i + 1),
      );
    });
    setTimeout(() => {
      if (inc.analysis?.startedAt !== base.startedAt) return;
      inc.analysis = mockAnalysis.fail
        ? {
            ...inc.analysis,
            status: 'failed',
            finishedAt: iso(),
            error: 'Провайдер не ответил за 60 секунд. Повторите разбор.',
          }
        : {
            ...inc.analysis,
            ...BODIES[inc.kind],
            ...(inc.kind === 'node_down' || inc.kind === 'ssh_down'
              ? { reachability: sampleReach(inc.serverName, 'partial') }
              : {}),
            status: 'done',
            finishedAt: iso(),
            steps: list,
          };
    }, mockAnalysis.stepMs * list.length);
    return HttpResponse.json(inc, { status: 202 });
  }),
  http.post('/api/incidents/:id/analysis/ask', async ({ params, request }) => {
    const inc = find(params.id);
    if (!inc) return problem(404, 'Инцидент не найден.');
    const parsed = analysisAskRequestSchema.safeParse(await request.json());
    if (!parsed.success) return problem(400, 'Введите вопрос');
    if (inc.analysis?.status !== 'done') return problem(409, 'Сначала запустите разбор инцидента.');
    const q = parsed.data.question;
    inc.analysis = {
      ...inc.analysis,
      thread: [
        ...inc.analysis.thread,
        {
          question: q,
          answer: `По этому инциденту: ${inc.analysis.verdict?.split('.')[0]}. Подробнее в доказательствах выше.`,
          at: iso(),
        },
      ].slice(-8),
    };
    return HttpResponse.json(inc);
  }),
];

export function seedAnalysis(): void {
  mockAnalysis.fail = false;
}

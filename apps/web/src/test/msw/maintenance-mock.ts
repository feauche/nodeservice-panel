import {
  MAINTENANCE_CHECK_INTERVAL_HOURS,
  MAINTENANCE_KIND_LABELS,
  type MaintenanceCheck,
  type MaintenanceKind,
  type MaintenanceRun,
  type MaintenanceState,
  type MaintenanceStep,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

/**
 * Мок обслуживания: состояние в памяти, запуск «идёт» по таймеру — шаги и лог двигаются, как на
 * живом сервере, только быстрее (speedMs). После действия чек-лист меняется соответственно.
 */
interface MaintenanceMock {
  states: Map<string, MaintenanceState>;
  runs: MaintenanceRun[];
  /** Пауза между шагами. В тестах — маленькая, в браузере (VITE_MOCK) — как на живом. */
  speedMs: number;
  /** Шаг с этим ключом упадёт (для теста ошибки). */
  failStep: string;
  timers: ReturnType<typeof setTimeout>[];
}

export const mockMaintenance: MaintenanceMock = {
  states: new Map(),
  runs: [],
  speedMs: 40,
  failStep: '',
  timers: [],
};

let seq = 0;
const uuid = () => `0192c000-aaaa-7000-8000-${String(++seq).padStart(12, '0')}`;

export function makeCheck(patch: Partial<MaintenanceCheck> = {}): MaintenanceCheck {
  return {
    checkedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    supported: true,
    updates: { total: 65, security: 1 },
    rebootRequired: false,
    kernel: { running: '6.8.0-84-generic', installed: '6.8.0-84-generic' },
    unattended: false,
    agent: { installed: 'v0.5.4', latest: 'v0.6.0', service: 'active' },
    // Диск заполнен настолько, что очистку стоит предложить (порог — DISK_CLEANUP_OFFER_PCT).
    disk: { usedPct: 86, freeMb: 11_000 },
    warnings: [],
    ...patch,
  };
}

export function seedMaintenance(serverId: string, check: MaintenanceCheck | null = makeCheck()): void {
  for (const t of mockMaintenance.timers) clearTimeout(t);
  mockMaintenance.timers = [];
  mockMaintenance.runs = [];
  mockMaintenance.failStep = '';
  mockMaintenance.states.clear();
  mockMaintenance.states.set(serverId, {
    serverId,
    check,
    checkError: null,
    nextCheckAt: check
      ? new Date(
          new Date(check.checkedAt).getTime() + MAINTENANCE_CHECK_INTERVAL_HOURS * 3_600_000,
        ).toISOString()
      : null,
    running: null,
    lastRun: null,
  });
}

function stateFor(serverId: string): MaintenanceState {
  let st = mockMaintenance.states.get(serverId);
  if (!st) {
    st = { serverId, check: null, checkError: null, nextCheckAt: null, running: null, lastRun: null };
    mockMaintenance.states.set(serverId, st);
  }
  return st;
}

const STEPS: Record<MaintenanceKind, Array<[string, string]>> = {
  check: [
    ['connect', 'Подключение по SSH'],
    ['collect', 'Сбор данных о системе'],
    ['release', 'Версия агента на GitHub'],
  ],
  apt_upgrade: [
    ['connect', 'Подключение по SSH'],
    ['update', 'Список пакетов'],
    ['upgrade', 'Установка обновлений'],
    ['after', 'Проверка после'],
  ],
  agent_update: [
    ['connect', 'Подключение по SSH'],
    ['download', 'Скачивание релиза и проверка суммы'],
    ['install', 'Замена бинаря и перезапуск'],
    ['verify', 'Агент вышел на связь'],
    ['after', 'Проверка после'],
  ],
  cleanup: [
    ['connect', 'Подключение по SSH'],
    ['autoremove', 'Ненужные пакеты и старые ядра'],
    ['clean', 'Кеш пакетов'],
    ['journal', 'Системный журнал до 200 МБ'],
    ['after', 'Проверка после'],
  ],
  unattended_enable: [
    ['connect', 'Подключение по SSH'],
    ['install', 'Пакет unattended-upgrades'],
    ['configure', 'Ежедневные обновления безопасности'],
    ['after', 'Проверка после'],
  ],
};

const LOG_LINES: Record<string, string> = {
  connect: 'root@203.0.113.7:22 · ключ сервера SHA256:mockfingerprintAAAA1111',
  update: 'Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nReading package lists... Done',
  upgrade:
    'Reading package lists... Done\nThe following packages will be upgraded:\n  openssl libssl3 curl (65)\nSetting up openssl (3.0.13-0ubuntu3.5) ...\nProcessing triggers for man-db ...',
  download: 'nodeservice-agent_linux_amd64: OK',
  install: 'агент: v0.6.0 · active',
  verify: 'агент в сети: v0.6.0',
  autoremove: 'Removing linux-image-6.8.0-79-generic (6.8.0-79.79) ...\nFreed 1.2 GB',
  clean: '',
  journal: 'Vacuuming done, freed 312.0M of archived journals',
  configure: 'включено: только обновления безопасности, без автоперезагрузки',
  collect: '@@updates=65\n@@reboot=0\n@@disk_pct=16',
  release: 'последняя v0.6.0',
  after: '@@updates=0\n@@reboot=1',
};

function applyOutcome(st: MaintenanceState, kind: MaintenanceKind): void {
  const base = st.check ?? makeCheck();
  const check: MaintenanceCheck = { ...base, checkedAt: new Date().toISOString() };
  if (kind === 'apt_upgrade') {
    check.updates = { total: 0, security: 0 };
    check.rebootRequired = true;
    check.kernel = { running: '6.8.0-84-generic', installed: '6.8.0-85-generic' };
  } else if (kind === 'agent_update') {
    check.agent = { ...check.agent, installed: check.agent.latest ?? check.agent.installed };
  } else if (kind === 'cleanup') {
    check.disk = { usedPct: 14, freeMb: 68_000 };
  } else if (kind === 'unattended_enable') {
    check.unattended = true;
  }
  st.check = check;
  st.checkError = null;
  st.nextCheckAt = new Date(Date.now() + MAINTENANCE_CHECK_INTERVAL_HOURS * 3_600_000).toISOString();
}

function advance(st: MaintenanceState, run: MaintenanceRun, i: number): void {
  const step = run.steps[i];
  if (!step) {
    run.status = 'ok';
    run.finishedAt = new Date().toISOString();
    run.log += `\n✓ Готово за ${Math.max(1, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000))} с\n`;
    applyOutcome(st, run.kind);
    st.running = null;
    st.lastRun = run;
    return;
  }
  step.status = 'running';
  step.startedAt = new Date().toISOString();
  run.log += `\n▶ ${step.label}\n`;
  const t = setTimeout(() => {
    step.finishedAt = new Date().toISOString();
    if (mockMaintenance.failStep === step.key) {
      step.status = 'failed';
      step.detail = 'команда завершилась с кодом 100';
      run.log += `E: шаг ${step.key} сломан для теста\n\n✗ команда завершилась с кодом 100\n`;
      for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
      run.status = 'failed';
      run.error = 'команда завершилась с кодом 100';
      run.finishedAt = new Date().toISOString();
      st.running = null;
      st.lastRun = run;
      return;
    }
    step.status = 'ok';
    const line = LOG_LINES[step.key];
    if (line) run.log += `${line}\n`;
    if (step.key === 'after') step.detail = 'обновлений нет · нужна перезагрузка · диск 16%';
    if (step.key === 'collect') step.detail = 'обновлений: 65 · диск 16%';
    advance(st, run, i + 1);
  }, mockMaintenance.speedMs);
  mockMaintenance.timers.push(t);
}

const problem = (status: number, type: string, detail: string) =>
  HttpResponse.json(
    { type, title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export const maintenanceHandlers = [
  http.get('/api/servers/:id/maintenance', ({ params }) => HttpResponse.json(stateFor(String(params.id)))),
  http.get('/api/servers/:id/maintenance/runs', ({ params }) =>
    HttpResponse.json({
      items: mockMaintenance.runs.filter((r) => r.serverId === params.id).map((r) => ({ ...r, log: '' })),
    }),
  ),
  http.post('/api/servers/:id/maintenance/runs', async ({ params, request }) => {
    const st = stateFor(String(params.id));
    const body = (await request.json()) as { kind?: MaintenanceKind };
    const kind = body.kind;
    if (!kind || !(kind in STEPS)) return problem(400, 'about:blank', 'Неизвестный вид обслуживания');
    if (st.running)
      return problem(
        409,
        'urn:nodeservice:problem:maintenance-busy',
        'На этом сервере уже идёт обслуживание. Дождитесь завершения.',
      );
    const steps: MaintenanceStep[] = STEPS[kind].map(([key, label]) => ({
      key,
      label,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      detail: null,
    }));
    const run: MaintenanceRun = {
      id: uuid(),
      serverId: st.serverId,
      kind,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      actorDisplay: 'admin',
      steps,
      log: `${MAINTENANCE_KIND_LABELS[kind]}\n`,
      error: null,
    };
    st.running = run;
    mockMaintenance.runs.unshift(run);
    advance(st, run, 0);
    return HttpResponse.json(run, { status: 202 });
  }),
];

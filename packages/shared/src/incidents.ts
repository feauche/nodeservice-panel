import { z } from 'zod';

import { reachabilityResultSchema } from './reachability.js';

import { nodeStateSchema } from './servers.js';

/**
 * Инциденты (этап 8): панель сама замечает проблемы серверов (агент офлайн, SSH недоступен,
 * CPU/память/диск выше порога дольше «времени реакции»), заводит инцидент с таймлайном,
 * чинит по реестру действий с уровнями T0–T3 (по SSH): каждая попытка = пред-проверка → действие →
 * пост-проверка → откат; не помогло — предлагает следующий шаг цепочки (T2 ждёт подтверждения, T3 —
 * команда для терминала).
 */

export const INCIDENT_SEVERITIES = ['crit', 'warn', 'info'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Виды инцидентов, которые панель умеет замечать. */
export const INCIDENT_KINDS = [
  'agent_offline',
  'ssh_down',
  'node_down',
  'cpu_high',
  'mem_high',
  'disk_high',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** Заголовок инцидента с токеном имени сервера — для уведомлений: имя подставится при показе. */
export const incidentTitleToken = (label: string): string => `${label} · {server}`;

export const INCIDENT_KIND_META: Record<
  IncidentKind,
  { label: string; component: string; severity: IncidentSeverity }
> = {
  agent_offline: { label: 'Агент не в сети', component: 'Связь', severity: 'crit' },
  ssh_down: { label: 'SSH недоступен', component: 'Связь', severity: 'crit' },
  node_down: { label: 'Контейнер ноды не запущен', component: 'Нода', severity: 'crit' },
  cpu_high: { label: 'Высокая нагрузка на CPU', component: 'CPU', severity: 'warn' },
  mem_high: { label: 'Память на пределе', component: 'Память', severity: 'warn' },
  disk_high: { label: 'Диск заполняется', component: 'Диск', severity: 'warn' },
};

/* ---------- уровни действий и реестр (§2 мастер-плана) ---------- */

/**
 * T0 — только чтение; T1 — безопасное авто (обратимо, есть пост-проверка и откат);
 * T2 — с подтверждением (кнопка подтверждения в панели, без пароля — решение владельца); T3 — только вручную,
 * панель показывает команду для терминала и никогда не выполняет её сама.
 */
export const ACTION_LEVELS = ['T0', 'T1', 'T2', 'T3'] as const;
export type ActionLevel = (typeof ACTION_LEVELS)[number];
export const ACTION_LEVEL_LABELS: Record<ActionLevel, string> = {
  T0: 'Наблюдение',
  T1: 'Безопасное авто',
  T2: 'С подтверждением',
  T3: 'Только вручную',
};

/**
 * Реестр действий. Команды живут только на API (никаких shell-строк из БД); здесь — что видит
 * администратор: уровень, к каким инцидентам подходит, что проверяется до и после, есть ли откат.
 */
export const INCIDENT_ACTIONS = [
  {
    key: 'free_disk',
    title: 'Освободить диск',
    level: 'T1',
    kinds: ['disk_high'] as IncidentKind[],
    summary: 'journalctl --vacuum-size=200M, docker image prune -f, docker builder prune -f',
    consequence: null,
    preconditions: ['агент в сети', 'диск не переполнен (< 100 %)', 'на ноде не идёт другое действие'],
    postcheck: 'диск ниже порога − 5 % (до 16 с)',
    rollbackNote: 'не нужен: удаляется только мусор',
    terminal: false,
  },
  {
    key: 'apt_clean',
    title: 'Очистить кэш apt',
    level: 'T1',
    kinds: ['disk_high'] as IncidentKind[],
    summary: 'apt-get clean, apt-get autoremove --purge',
    consequence: null,
    preconditions: ['агент в сети', 'диск не переполнен (< 100 %)', 'на ноде не идёт другое действие'],
    postcheck: 'диск ниже порога − 5 % (до 16 с)',
    rollbackNote: 'не нужен: пакеты скачаются заново при установке',
    terminal: false,
  },
  {
    key: 'node_up',
    title: 'Поднять контейнер ноды',
    level: 'T1',
    kinds: ['node_down'] as IncidentKind[],
    summary: 'docker start remnanode',
    consequence: null,
    preconditions: ['SSH ключом панели отвечает', 'на ноде не идёт другое действие'],
    postcheck: 'контейнер запущен по docker inspect (до 60 с)',
    rollbackNote: 'не нужен: нода и так не работала',
    terminal: false,
  },
  {
    key: 'restart_node',
    title: 'Перезапустить контейнер ноды',
    level: 'T2',
    kinds: ['cpu_high', 'mem_high'] as IncidentKind[],
    summary: 'docker restart remnanode',
    consequence: 'соединения пользователей оборвутся на ~5 с и восстановятся сами',
    preconditions: ['агент в сети', 'на ноде не идёт другое действие'],
    postcheck: 'контейнер Up, CPU/память ниже порога − 10 % три замера подряд (60 с)',
    rollbackNote: 'не нужен: перезапуск обратим сам по себе',
    terminal: false,
  },
  {
    key: 'agent_reinstall',
    title: 'Переустановить агента',
    level: 'T2',
    kinds: ['agent_offline'] as IncidentKind[],
    summary: 'установка агента по SSH заново, как из окна сервера',
    consequence: 'метрики прервутся на время установки (~1 мин)',
    preconditions: ['SSH ключом панели отвечает', 'на ноде не идёт другое действие'],
    postcheck: 'агент вышел на связь (до 2 мин)',
    rollbackNote: 'не нужен: прежний агент и так не работал',
    terminal: false,
  },
  {
    key: 'tmp_clean',
    title: 'Очистить временные файлы',
    level: 'T2',
    kinds: ['disk_high'] as IncidentKind[],
    summary: 'удаление файлов крупнее 10 МБ старше часа в /tmp и /var/tmp',
    consequence: 'крупные (> 10 МБ) файлы из /tmp и /var/tmp старше часа будут удалены',
    preconditions: ['SSH ключом панели отвечает', 'на ноде не идёт другое действие'],
    postcheck: 'диск ниже порога − 5 % (до 16 с)',
    rollbackNote: 'нет: удалённые временные файлы не восстановить',
    terminal: false,
  },
  {
    key: 'disk_inspect',
    title: 'Найти, что занимает диск',
    /** Только чтение: панель выполняет сама и показывает список — решение, что удалять, за вами. */
    level: 'T0',
    kinds: ['disk_high'] as IncidentKind[],
    summary: 'du -xh / --max-depth=2 | sort -h | tail -20, du -sh /tmp/* /var/log/*',
    consequence: null,
    preconditions: ['SSH ключом панели отвечает'],
    postcheck: '—',
    rollbackNote: null,
    terminal: false,
  },
  {
    key: 'reboot',
    title: 'Перезагрузить сервер',
    level: 'T3',
    kinds: ['node_down', 'cpu_high', 'mem_high'] as IncidentKind[],
    summary: 'reboot',
    consequence: 'нода недоступна 1–3 минуты',
    preconditions: [],
    postcheck: '—',
    rollbackNote: null,
    terminal: true,
  },
  {
    key: 'agent_logs',
    title: 'Посмотреть, почему агент молчит',
    level: 'T3',
    kinds: ['agent_offline'] as IncidentKind[],
    summary: 'systemctl status nodeservice-agent; journalctl -u nodeservice-agent -n 50',
    consequence: null,
    preconditions: [],
    postcheck: '—',
    rollbackNote: null,
    terminal: true,
  },
] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];
export type ActionKey = IncidentAction['key'];
export const actionKeySchema = z.enum(INCIDENT_ACTIONS.map((a) => a.key) as [ActionKey, ...ActionKey[]]);
export const actionByKey = (key: ActionKey): IncidentAction =>
  INCIDENT_ACTIONS.find((a) => a.key === key) as IncidentAction;

/**
 * Описание действия для показа, в том числе по ключу, которого в реестре уже нет (старые
 * инциденты в БД): такие показываем как есть, с уровнем T2, чтобы страница не ломалась.
 */
/** Действия, убранные из реестра: старые попытки и хронология должны остаться читаемыми. */
const RETIRED_ACTION_TITLES: Record<string, string> = {
  node_logs: 'Логи ноды',
  restart_xray: 'Перезапустить Xray',
};

export function actionMeta(key: string): IncidentAction {
  const known = INCIDENT_ACTIONS.find((a) => a.key === key);
  if (known) return known;
  return {
    key: key as ActionKey,
    title: RETIRED_ACTION_TITLES[key] ?? key,
    level: 'T2',
    kinds: [] as IncidentKind[],
    summary: '',
    consequence: null,
    preconditions: [],
    postcheck: '—',
    rollbackNote: null,
    terminal: false,
  } as unknown as IncidentAction;
}

/** Цепочка шагов по виду инцидента: следующий шаг предлагается, когда предыдущий не помог. */
export const INCIDENT_CHAINS: Record<IncidentKind, ActionKey[]> = {
  node_down: ['node_up', 'reboot'],
  disk_high: ['free_disk', 'apt_clean', 'disk_inspect', 'tmp_clean'],
  cpu_high: ['restart_node', 'reboot'],
  mem_high: ['restart_node', 'reboot'],
  agent_offline: ['agent_reinstall', 'agent_logs'],
  ssh_down: [],
};

/* ---------- попытки починки ---------- */

export const ATTEMPT_STEP_KEYS = ['precheck', 'action', 'postcheck', 'rollback'] as const;
export type AttemptStepKey = (typeof ATTEMPT_STEP_KEYS)[number];
export const attemptStepSchema = z.object({
  key: z.enum(ATTEMPT_STEP_KEYS),
  label: z.string(),
  status: z.enum(['pending', 'running', 'ok', 'failed', 'skipped']),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
});
export type AttemptStep = z.infer<typeof attemptStepSchema>;

export const ATTEMPT_STATUSES = [
  'running',
  'helped',
  'not_helped',
  'precheck_failed',
  'failed',
  'done',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  running: 'выполняется',
  helped: 'помогло',
  not_helped: 'не помогло',
  precheck_failed: 'пред-проверка не пройдена',
  failed: 'ошибка выполнения',
  /** T0: посмотрели (логи), инцидент не трогали. */
  done: 'выполнено',
};

/** Лог попытки в БД ограничен, чтобы инцидент не раздувался. */
export const ATTEMPT_LOG_MAX = 20_000;

/**
 * Инцидент открывается в момент сбоя, а автопочинка (само или предложение) ждёт столько секунд:
 * вдруг нода поднимется сама после перезапуска или обновления. Поднялась — инцидент закрывается сам.
 */
export const AUTOFIX_GRACE_SECONDS = 60;

export const incidentAttemptSchema = z.object({
  id: z.string(),
  /** Ключ действия; строка, а не enum — в БД могут лежать попытки действий, убранных из реестра. */
  action: z.string(),
  level: z.enum(ACTION_LEVELS),
  by: z.enum(['auto', 'manual']),
  status: z.enum(ATTEMPT_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  steps: z.array(attemptStepSchema),
  log: z.string(),
});
export type IncidentAttempt = z.infer<typeof incidentAttemptSchema>;

/** Предложенный следующий шаг: T2 ждёт подтверждения, T3 — команда для терминала, T1 при выключенном авто — тоже подтверждение. */
export const incidentProposalSchema = z.object({
  action: z.string(),
  level: z.enum(ACTION_LEVELS),
  reason: z.string(),
  proposedAt: z.iso.datetime(),
});
export type IncidentProposal = z.infer<typeof incidentProposalSchema>;

/** Событие таймлайна инцидента. */
export const incidentEventResultSchema = z.enum([
  'detect',
  'notify',
  'applied',
  'helped',
  'failed',
  'escalate',
  'resolved',
]);
export type IncidentEventResult = z.infer<typeof incidentEventResultSchema>;

export const incidentEventSchema = z.object({
  at: z.iso.datetime(),
  by: z.enum(['auto', 'manual']),
  action: z.string(),
  result: incidentEventResultSchema,
  /** Уровень действия, к которому относится событие (пред-проверка, шаг, пост-проверка). */
  level: z.enum(ACTION_LEVELS).optional(),
});
export type IncidentEvent = z.infer<typeof incidentEventSchema>;

/** Сигналы в момент сбоя: метрики агента и состояние контейнера. Ничего нет — null. */
export const incidentSnapshotSchema = z.object({
  cpu: z.number().nullable(),
  mem: z.number().nullable(),
  disk: z.number().nullable(),
  node: nodeStateSchema.nullable(),
  agentStatus: z.string().nullable(),
  agentVersion: z.string().nullable(),
});
export type IncidentSnapshot = z.infer<typeof incidentSnapshotSchema>;

/* ---------- разбор Джарвисом (R4.2) ---------- */

export const ANALYSIS_STATUSES = ['running', 'done', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type AnalysisConfidence = (typeof ANALYSIS_CONFIDENCE)[number];
export const ANALYSIS_CONFIDENCE_LABELS: Record<AnalysisConfidence, string> = {
  high: 'Уверенность высокая',
  medium: 'Уверенность средняя',
  low: 'Уверенность низкая',
};

/** Откуда взято утверждение: источник рядом с каждым доказательством, чтобы его можно было проверить. */
export const ANALYSIS_EVIDENCE_SOURCES = [
  'metric',
  'inspect',
  'attempt',
  'agent',
  'history',
  'other',
] as const;
export type AnalysisEvidenceSource = (typeof ANALYSIS_EVIDENCE_SOURCES)[number];
export const ANALYSIS_EVIDENCE_LABELS: Record<AnalysisEvidenceSource, string> = {
  metric: 'Метрика',
  inspect: 'Осмотр',
  attempt: 'Попытки',
  agent: 'Агент',
  history: 'История',
  other: 'Данные',
};

/** Сколько вопросов по разбору хранится в самом инциденте; старые вытесняются. */
export const ANALYSIS_THREAD_MAX = 8;
export const ANALYSIS_QUESTION_MAX = 500;

export const incidentAnalysisSchema = z.object({
  status: z.enum(ANALYSIS_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Что Джарвис делает или сделал («Смотрю историю диска»): идёт разбор — видно ход работы. */
  steps: z.array(z.string()),
  verdict: z.string().nullable(),
  confidence: z.enum(ANALYSIS_CONFIDENCE).nullable(),
  evidence: z.array(z.object({ source: z.enum(ANALYSIS_EVIDENCE_SOURCES), text: z.string() })),
  /** Чего в данных не хватило для уверенного вывода. */
  unknown: z.string().nullable(),
  /** Ключ шага из цепочки правил инцидента; запускает только администратор. */
  nextAction: z.string().nullable(),
  /** Состояние инцидента на момент разбора: по расхождению видно, что разбор устарел. */
  basedOn: z.object({ attempts: z.number().int().min(0), resolved: z.boolean() }),
  model: z.string().nullable(),
  error: z.string().nullable(),
  thread: z.array(z.object({ question: z.string(), answer: z.string(), at: z.iso.datetime() })),
  /** Проверка доступности снаружи, если Джарвис её делал (у старых разборов поля нет). */
  reachability: reachabilityResultSchema.nullable().optional(),
});
export type IncidentAnalysis = z.infer<typeof incidentAnalysisSchema>;

export const analysisAskRequestSchema = z.object({
  question: z.string().trim().min(2, 'Введите вопрос').max(ANALYSIS_QUESTION_MAX, 'Слишком длинный вопрос'),
});
export type AnalysisAskRequest = z.infer<typeof analysisAskRequestSchema>;

/** Метрика для графика-доказательства: только у инцидентов, которые про нагрузку или место. */
export const INCIDENT_CHART_METRIC: Partial<Record<IncidentKind, 'cpuPct' | 'memPct' | 'diskPct'>> = {
  cpu_high: 'cpuPct',
  mem_high: 'memPct',
  disk_high: 'diskPct',
};
export const INCIDENT_CHART_LABELS = { cpuPct: 'CPU', memPct: 'Память', diskPct: 'Диск' } as const;

/** Разбор устарел, если после него появились попытки или инцидент закрыли. */
export function isAnalysisStale(
  a: IncidentAnalysis,
  current: { attempts: number; resolved: boolean },
): boolean {
  return (
    a.status === 'done' &&
    (a.basedOn.attempts !== current.attempts || a.basedOn.resolved !== current.resolved)
  );
}

export const incidentSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid().nullable(),
  serverName: z.string(),
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  title: z.string(),
  detail: z.string(),
  openedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: z.enum(['auto', 'manual']).nullable(),
  timeline: z.array(incidentEventSchema),
  attempts: z.array(incidentAttemptSchema),
  proposal: incidentProposalSchema.nullable(),
  /** Что видел агент в момент открытия — для правой колонки кейса и будущего анализа ИИ. */
  snapshot: incidentSnapshotSchema.nullable(),
  /** Разбор Джарвисом: вывод, доказательства, шаг, вопросы; null — ещё не разбирали. */
  analysis: incidentAnalysisSchema.nullable(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentsListQuerySchema = z.object({
  status: z.enum(['all', 'open', 'resolved']).default('all'),
});
export type IncidentsListQuery = z.infer<typeof incidentsListQuerySchema>;

export const incidentsListResponseSchema = z.object({
  items: z.array(incidentSchema),
  counts: z.object({ open: z.number().int(), crit: z.number().int(), warn: z.number().int() }),
});
export type IncidentsListResponse = z.infer<typeof incidentsListResponseSchema>;

/* ---------- «Автопочинка»: политика по сигналам (витрина v3, C1) ---------- */

/**
 * Что панель делает при сигнале: `auto` — безопасные шаги (T1) выполняет сама, остальное предлагает;
 * `ask` — всё предлагает и ждёт подтверждения; `watch` — только заводит инцидент и уведомляет.
 */
export const AUTOFIX_POLICIES = ['auto', 'ask', 'watch'] as const;
export const autofixPolicySchema = z.enum(AUTOFIX_POLICIES);
export type AutofixPolicy = z.infer<typeof autofixPolicySchema>;
export const AUTOFIX_POLICY_LABELS: Record<AutofixPolicy, string> = {
  auto: 'Само',
  ask: 'Спросить',
  watch: 'Наблюдать',
};
export const DEFAULT_AUTOFIX_POLICY: AutofixPolicy = 'ask';

export const actionStatsSchema = z.object({
  runs: z.number().int().min(0),
  helped: z.number().int().min(0),
  lastAt: z.iso.datetime().nullable(),
});
export const incidentPolicyItemSchema = z.object({
  kind: z.enum(INCIDENT_KINDS),
  label: z.string(),
  component: z.string(),
  policy: autofixPolicySchema,
  /** Есть ли в цепочке безопасный шаг, который панель может делать сама. */
  autoAvailable: z.boolean(),
  chain: z.array(z.object({ key: actionKeySchema, title: z.string(), level: z.enum(ACTION_LEVELS) })),
  stats: actionStatsSchema,
});
export type IncidentPolicyItem = z.infer<typeof incidentPolicyItemSchema>;
export const incidentPolicyResponseSchema = z.object({
  autofixEnabled: z.boolean(),
  /** Пауза автопочинки (например, на время работ); null — не на паузе. */
  pausedUntil: z.iso.datetime().nullable(),
  cooldownMinutes: z.number().int(),
  items: z.array(incidentPolicyItemSchema),
});
export type IncidentPolicyResponse = z.infer<typeof incidentPolicyResponseSchema>;
export const incidentPolicyUpdateSchema = z.object({
  autofixEnabled: z.boolean().optional(),
  policy: z.partialRecord(z.enum(INCIDENT_KINDS), autofixPolicySchema).optional(),
  /** Поставить на паузу на N минут; 0 — снять паузу. */
  pauseMinutes: z.number().int().min(0).max(1440).optional(),
});
export type IncidentPolicyUpdate = z.infer<typeof incidentPolicyUpdateSchema>;

/* ---------- настройки инцидентов (Настройки → Инциденты) ---------- */

const pct = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const incidentsSettingsSchema = z.object({
  /** Порог «времени реакции»: проблема должна держаться дольше, чтобы стать инцидентом. */
  forDurationMinutes: z.coerce.number().int().min(1).max(60),
  cpuPct: pct(50, 100),
  memPct: pct(50, 100),
  diskPct: pct(50, 100),
  /** Автопочинка сама применяет безопасный пресет (иначе — только заводит инцидент). */
  autofixEnabled: z.boolean(),
  /** Не повторять автопочинку одного инцидента чаще, чем раз в N минут. */
  autofixCooldownMinutes: z.coerce.number().int().min(1).max(240),
  /** Политика по сигналам: само / спросить / наблюдать. Нет записи — «спросить». */
  policy: z.record(z.string(), autofixPolicySchema).default({}),
  /** Автопочинка на паузе до этого момента (UTC ISO); null — нет паузы. */
  pausedUntil: z.iso.datetime().nullable().default(null),
});
export type IncidentsSettings = z.infer<typeof incidentsSettingsSchema>;

export const INCIDENTS_SETTINGS_DEFAULTS: IncidentsSettings = {
  forDurationMinutes: 5,
  cpuPct: 90,
  memPct: 90,
  diskPct: 85,
  autofixEnabled: false,
  autofixCooldownMinutes: 30,
  policy: {},
  pausedUntil: null,
};

export const incidentsSettingsUpdateSchema = incidentsSettingsSchema.partial();
export type IncidentsSettingsUpdate = z.infer<typeof incidentsSettingsUpdateSchema>;

/** Ручное закрытие: для «Контейнер ноды не запущен» можно заодно выключить слежение за нодой на сервере. */
export const resolveIncidentRequestSchema = z.object({ stopNodeWatch: z.boolean().optional() });
export type ResolveIncidentRequest = z.infer<typeof resolveIncidentRequestSchema>;

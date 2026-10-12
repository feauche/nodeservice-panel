import {
  type AssistantActivity,
  type AssistantCitation,
  type AssistantProposal,
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditResult,
  actionMeta,
  CHANGE_OPERATIONS,
  INCIDENT_CHAINS,
  type Incident,
  KB_SOURCE_LABELS,
  type KbSource,
  type ReachabilityResult,
  SHARED_VERSION,
} from '@nodeservice/shared';

import type { AuditRepository } from '../audit/audit.repository.js';
import type { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { auditBrief } from './assistant.audit-brief.js';
import { searchPastMessages, searchWords } from './assistant.conversation-search.js';
import { READ_TOOL_DEFS, type ReadDeps, runReadTool } from './assistant.read-tools.js';
import type { AssistantRepository } from './assistant.repository.js';
import type { ProposeOutcome } from './changes/changes.service.js';
import { isGlossaryArticle } from './glossary-import.js';
import type { LlmToolDef } from './llm.provider.js';

/** Сколько последних сообщений просматриваем при поиске по прошлым беседам. */
const PAST_SCAN = 3000;

/** Определения инструментов для модели (read-only + propose_action). */
export const ASSISTANT_TOOLS: LlmToolDef[] = [
  ...READ_TOOL_DEFS,
  {
    name: 'get_settings',
    description:
      'Сохранённые настройки текущего мониторинга Remnawave: интервалы, пороги ресурсов и онлайна, TCP-проверки Check-Host; подробность и разрешения Ассистента. Только чтение, никакой автопочинки и запуска проверок.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_panel_status',
    description:
      'Состояние самой панели: версия, время с запуска, сохранённый снимок текущих нод и его время, открытые инциденты, ошибки Журнала за последний час и последняя резервная копия. Только чтение.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_node_metrics',
    description:
      'Сохранённые локальные ряды CPU, RAM, нагрузки, сети и онлайна текущих нод Remnawave. Импорт нового снимка и внешние проверки не запускаются; UUID ограничены текущим снимком. Пропуски означают отсутствие замера. minutes: 60, 1440, 10080 или 43200; nodeUuid необязателен.',
    input_schema: {
      type: 'object',
      properties: { minutes: { type: 'number' }, nodeUuid: { type: 'string' } },
    },
  },
  {
    name: 'get_remnawave_status',
    description:
      'Подключение к панели Remnawave (только чтение, если владелец её подключил): домен, сводка (пользователи по статусам, сколько онлайн сейчас/за сутки/за неделю, сколько нод на связи, суммарный трафик, версия и аптайм самой панели Remnawave), список её нод (адрес, подключена ли, страна, сколько пользователей сейчас на ней онлайн, лимит и использованный трафик, UUID ноды), срок TLS-сертификата домена панели. Без параметров. Если не подключена — скажи прямо и не выдумывай цифры; подключается в разделе «Ноды».',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_node_detail',
    description:
      'Сохранённое состояние одной ноды Remnawave по UUID, точному имени или адресу. Онлайн, CPU, RAM, нагрузка, сеть, версия, состояние и время снимка. Не запускает проверки и SSH; отсутствующие метрики остаются неизвестными.',
    input_schema: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] },
  },
  {
    name: 'search_audit',
    description:
      'Журнал событий панели (входы, изменения, инциденты, запросы к Ассистенту). Для вопросов про период («за час», «за сутки», «сегодня») передай sinceMinutes (час = 60, сутки = 1440) — вернутся события за этот срок. query — необязательный полнотекстовый поиск (слова, «фразы», -минус). category сужает по разделу, failuresOnly оставляет только неудачные и отклонённые события, limit задаёт число записей (5–25, по умолчанию 15). В каждой записи: время, что произошло, кто (администратор или панель), результат, важность, цель и короткая выдержка из деталей (у «Запрос к Ассистенту» это вопрос и ответ, у изменений — поле до и после). total — сколько всего событий подошло: если больше показанных, скажи об этом. Прошлые беседы с Ассистентом ищи через search_conversations.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        sinceMinutes: { type: 'number', description: 'события за последние N минут (час = 60)' },
        category: { type: 'string', description: `один из: ${AUDIT_CATEGORIES.join(', ')}` },
        failuresOnly: { type: 'boolean', description: 'только неудачные и отклонённые события' },
        limit: { type: 'number', description: 'сколько записей вернуть, 5–25' },
      },
    },
  },
  {
    name: 'search_conversations',
    description:
      'Поиск по прошлым беседам с Ассистентом (вопросы администратора и твои ответы), кроме текущей беседы. Нужен, когда спрашивают «мы уже это обсуждали», «что я спрашивал про…», «что ты советовал в прошлый раз». query — слова через пробел, все должны встретиться в одном сообщении (регистр и «ё» не важны). limit — сколько записей вернуть (1–15, по умолчанию 8). В ответе: название беседы, время, кто писал и кусок текста. Это память о разговорах, а не факты о парке: текущие данные всё равно бери инструментами чтения.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: '1–15' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_kb',
    description:
      'Поиск по существующим статьям базы знаний. Возвращает выдержки и ссылки для объяснения; ничего не создаёт и не редактирует.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
  },
  {
    name: 'save_kb_article',
    description:
      'Создать статью в базе знаний (метка AI ставится сама). Используй в режиме «Анализ» и когда пользователь просит сохранить инструкцию. Требует разрешения kbWrite (проверь get_settings, если не уверен). Тело — в Markdown: заголовки, списки, блоки кода с языком, таблицы.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Короткий заголовок статьи' },
        content: { type: 'string', description: 'Тело статьи в Markdown' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Теги, напр. ["xray","инструкция"]' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'add_glossary_terms',
    description:
      'Добавить термины и аббревиатуры в общий глоссарий «Пояснения» (таблица «термин → простое объяснение»). Вызывай ВСЕГДА, когда объясняешь пользователю непонятный термин/аббревиатуру — даже базовые (SSH, CPU, conntrack). Повторы инструмент отсекает сам (термин с тем же названием или переводом в скобках не добавляется второй раз) и называет их в ответе; существующие пояснения не переписывай без причины, поправить неверное можно, передав термин с update: true. Инструмент дополняет существующий список, отдельной статьи не создаёт. До 40 терминов за вызов; если терминов больше, вызывай несколько раз подряд. Пояснения — короткие, простыми словами.',
    input_schema: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              term: { type: 'string' },
              explain: { type: 'string' },
              update: {
                type: 'boolean',
                description:
                  'true только если термин уже есть, а его пояснение неверно или явно хуже: заменит пояснение. Без этого повтор пропускается.',
              },
            },
            required: ['term', 'explain'],
          },
        },
      },
      required: ['terms'],
    },
  },
  {
    name: 'propose_action',
    description:
      'Предложить администратору шаг для инцидента: появится карточка с кнопкой, нажимает её администратор, вы ничего не запускаете. preset — ключ шага из цепочки правил ЭТОГО инцидента (поле chain в get_incident). T0 и T1 безопасны; T2 меняет состояние сервера, в reason объясните почему именно он; T3 (перезагрузка и подобное) карточкой не предлагается: напишите команду и последствия текстом. Название и последствия карточка берёт из реестра сама.',
    input_schema: {
      type: 'object',
      properties: {
        incidentId: { type: 'string' },
        preset: { type: 'string', description: 'ключ шага из chain инцидента' },
        reason: { type: 'string', description: 'Коротко, почему именно этот шаг (до 300 знаков)' },
      },
      required: ['incidentId', 'preset', 'reason'],
    },
  },
  {
    name: 'propose_change',
    description:
      'Предложить ИЗМЕНЕНИЕ в панели: появится карточка «было → станет» с кнопкой «Применить», нажимает её администратор, ты ничего не меняешь сам. Вызывай, когда просят что-то изменить, или когда обоснованно видишь правку (например, заполнить профиль сервера по данным снимка состояния). Операции и их args: server.provider {server, provider|null} (сменить провайдера; провайдера берите из списка провайдеров, нового так не создать); server.tags {server, add?: [..], remove?: [..]}; server.notes {server, notes|null}; server.rename {server, name}; server.nodeWatch {server, mode: auto|on|off}; server.country {server, country: код страны ISO из двух букв (PL, NL) или «auto» для автоопределения по IP} (страна сервера; отвечай кодом, а не названием); server.profile {server, roles?, importance?, maintenanceWindow?, expectedContainers?, expectedPorts?} (списки заменяются целиком: передавай полный итоговый список; roles: массив из entry (принимает клиентов), exit (выпускает трафик в интернет), bridge (мост), panel (панель Remnawave), other; importance: critical|normal|low); incident.resolve {incidentId} (закрыть инцидент вручную, необратимо); autofix.pause {minutes: 0–1440} (поставить автопочинку на паузу, 0 снимает паузу); autofix.policy {kind: agent_offline|ssh_down|node_down|cpu_high|mem_high|disk_high, policy: auto|ask|watch} (режим автопочинки для вида инцидента; auto значит «панель сама делает безопасные шаги», это T2, и доступно не для каждого вида); server.check {server, check: iperf3_ru|yabs} (тяжёлая проверка сервера — скорость до России или полный замер; только карточкой, запускает администратор; лёгкие запускай сам через run_server_check); maintenance.run {server, kind: check|agent_update|cleanup|unattended_enable} (запуск обслуживания в фоне: проверка сервера, обновление агента, очистка диска от 70 %, автообновления безопасности; перед agent_update, cleanup и unattended_enable нужны данные проверки, иначе сначала предложи check; обновление системы apt так не запускается); kb.runbook {incidentId, title, content} (записать в базу знаний решённый инцидент: что было и что реально помогло, только по УЖЕ закрытому инциденту; если ничего конкретного не помогло и он закрылся сам — так и напиши в content, не выдумывай действие; content — обычный текст статьи, без выдуманных подробностей сверх того, что видно по делу инцидента). server — имя или id сервера. reason — коротко, почему именно это (до 300 знаков). Не предлагай то, что уже стоит нужным образом: инструмент откажет. После вызова скажи, что изменение вступит в силу после нажатия «Применить» на карточке; пиши «предложил», а не «изменил». Не больше трёх карточек за ответ. Всё остальное (перезагрузка, обновление системы apt, удаление, SSH-ключи, разрешения, правка уже существующих статей) карточкой не предлагается.',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...CHANGE_OPERATIONS] },
        args: { type: 'object', description: 'Аргументы операции, см. описание инструмента' },
        reason: { type: 'string', description: 'Коротко, почему именно это (до 300 знаков)' },
      },
      required: ['operation', 'args', 'reason'],
    },
  },
];

/** Только пассивное чтение уже имеющихся данных. Эти инструменты не запускают SSH, проверки и изменения. */
const PASSIVE_TOOL_NAMES = new Set([
  'get_remnawave_profiles',
  'get_remnawave_topology',
  'list_incidents',
  'get_incident',
  'get_playbook',
  'get_reference',
  'get_billing',
  'get_settings',
  'get_panel_status',
  'get_node_metrics',
  'get_remnawave_status',
  'get_node_detail',
  'search_audit',
  'search_conversations',
  'search_kb',
]);
export const PASSIVE_ASSISTANT_TOOLS: LlmToolDef[] = ASSISTANT_TOOLS.filter((tool) =>
  PASSIVE_TOOL_NAMES.has(tool.name),
).map((tool) =>
  tool.name === 'list_incidents'
    ? {
        ...tool,
        description:
          'Сохранённые инциденты Remnawave. status: open|resolved|all; nodeUuid — необязательный фильтр ноды; limit до25. Возвращает факты и сохранённые результаты TCP, ничего не проверяет и не исправляет.',
        input_schema: {
          type: 'object',
          properties: { status: { type: 'string' }, nodeUuid: { type: 'string' }, limit: { type: 'number' } },
        },
      }
    : tool.name === 'get_billing'
      ? {
          ...tool,
          description:
            'Сохранённые оплаты, сроки и связи с нодами; без изменений. Исторические серверные записи сохраняются, но не описывают текущую доступность нод.',
          input_schema: { type: 'object', properties: { archived: { type: 'boolean' } } },
        }
      : tool,
);

export interface ToolDeps extends ReadDeps {
  nodeMetrics?: (minutes: number, nodeUuid?: string) => Promise<unknown>;
  kb: KnowledgeRepository;
  audit: AuditRepository;
  /** Поиск по прошлым беседам; conversationId — текущая беседа, её из результатов исключаем. */
  conversations: Pick<AssistantRepository, 'recentMessages'>;
  conversationId?: string;
  autochecks?: { get: () => Promise<unknown> };
  monitoring?: { get: () => Promise<unknown> };
  incidentSettings: { get: () => Promise<unknown> };
  /** Снимок настроек самого агента — уровень и разрешения (только чтение). */
  assistant: { level: string };
  /** Что делал автоматический разбор инцидентов с момента запуска панели. */
  autoAnalysis?: () => { lastRunAt: string | null; startedLastHour: number; limitPerHour: number };
  /** Последняя резервная копия панели («Настройки → Резервные копии»). */
  lastBackup?: () => Promise<{ at: string; kind: string; size: string; verified: boolean | null } | null>;
  /** Создание статьи в БЗ (метка AI). Гейтится разрешением kbWrite в самом инструменте. */
  saveArticle: (a: {
    title: string;
    content: string;
    tags: string[];
  }) => Promise<{ id: string; title: string }>;
  /** Статус Remnawave (J4), если владелец её подключил; нет — инструмент честно говорит «не подключена». */
  remnawave?: { status: () => Promise<import('@nodeservice/shared').RemnawaveStatus> };
  /** Предложение изменения (J5): создаёт карточку, ничего не меняет. Гейтится разрешением changes в самом инструменте. */
  changes?: { propose: (operation: string, args: unknown, reason: string | null) => Promise<ProposeOutcome> };
  /** Пополнение глоссария «Пояснения». Работает всегда, отдельного разрешения нет. */
  addGlossary: (
    terms: Array<{ term: string; explain: string; update?: boolean }>,
  ) => Promise<{ id: string; added: number; skipped: string[]; updated: string[] }>;
}

/** Результат выполнения инструмента: текст для модели + накопленные цитаты/предложения. */
export interface ToolOutcome {
  content: string;
  citations: AssistantCitation[];
  proposals: AssistantProposal[];
  /** Проверки доступности, которые нужно показать матрицей под ответом. */
  reachability?: ReachabilityResult[];
  /** Долгие действия (проверка сервера) — строками над ответом. */
  activity?: AssistantActivity[];
}

/** Выполнить инструмент из аллоулиста. Неизвестный инструмент — явная ошибка (не молчим). */
export async function runTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  const arg = (input ?? {}) as Record<string, unknown>;
  const empty: ToolOutcome = { content: '', citations: [], proposals: [] };
  if (arg.__truncated)
    return {
      ...empty,
      content:
        'Вызов не выполнен: ответ оборвался на пределе длины, аргументы дошли не целиком. Сделай вызов короче: длинную статью сохрани двумя-тремя статьями поменьше (например, «… — часть 1», «… — часть 2») или сократи текст. Не говори, что «не задан заголовок» — дело было в длине.',
    };

  const read = await runReadTool(name, arg, deps);
  if (read) return read;

  if (name === 'get_settings') {
    const monitoring = (await deps.monitoring?.get()) ?? { error: 'Настройки мониторинга недоступны.' };
    return {
      content: JSON.stringify({
        monitoring,
        assistant: {
          level: deps.assistant.level,
          permissions: deps.permissions,
          ...(deps.autoAnalysis
            ? {
                autoAnalysisStatus: {
                  ...deps.autoAnalysis(),
                  note: 'Счётчики с момента запуска панели. Разбор берёт открытые инциденты без разбора старше 60 секунд и младше 6 часов, только при включённых «Разборе по кнопке» и «Автоматическом разборе».',
                },
              }
            : {}),
        },
      }),
      citations: [],
      proposals: [],
    };
  }

  if (name === 'get_node_metrics') {
    const minutes = [60, 1440, 10080, 43200].includes(Number(arg.minutes)) ? Number(arg.minutes) : 60;
    return {
      ...empty,
      content: JSON.stringify(
        deps.nodeMetrics
          ? await deps.nodeMetrics(minutes, typeof arg.nodeUuid === 'string' ? arg.nodeUuid : undefined)
          : { error: 'История недоступна.' },
      ),
    };
  }

  if (name === 'get_remnawave_status' || name === 'get_node_detail') {
    if (!deps.remnawave)
      return {
        ...empty,
        content: 'Remnawave не подключена. Настройки подключения находятся в разделе «Ноды».',
      };
    const st = await deps.remnawave.status();
    if (!st.connected)
      return {
        ...empty,
        content: 'Remnawave не подключена. Настройки подключения находятся в разделе «Ноды».',
      };
    const nodes = st.nodes.map(({ serverIds: _ids, linkedBy: _linked, ...node }) => node);
    const fresh = !st.error && !!st.checkedAt && Date.now() - Date.parse(st.checkedAt) < 90000;
    const snapshot = {
      source: 'Remnawave',
      panel: st.domain,
      checkedAt: st.checkedAt,
      fresh,
      error: st.error,
      note: 'Сохранённый снимок Remnawave. Недоступная метрика — null/отсутствует, не ноль. isConnected — связь с Remnawave, не доказательство доступности VPN из РФ. SSH и агенты не используются.',
    };
    if (name === 'get_node_detail') {
      const key = String(arg.node ?? '')
        .trim()
        .toLowerCase();
      const matches = nodes.filter((n) => [n.uuid, n.name, n.address].some((v) => v.toLowerCase() === key));
      if (!key || matches.length !== 1)
        return {
          ...empty,
          content: 'Нода не найдена или имя неоднозначно. Используйте UUID из get_remnawave_status.',
        };
      const node = matches[0];
      if (!node) return { ...empty, content: 'Нода не найдена.' };
      return {
        ...empty,
        content: JSON.stringify({ ...snapshot, node }),
        citations: [{ type: 'node', id: node.uuid, label: node.name }],
      };
    }
    return {
      ...empty,
      content: JSON.stringify({
        ...snapshot,
        connected: st.connected,
        stats: st.stats,
        nodes,
        cert: st.cert,
      }),
    };
  }

  if (name === 'get_panel_status') {
    const [status, open, failed] = await Promise.all([
      deps.remnawave?.status(),
      deps.incidents.list('open'),
      deps.audit.list({
        from: new Date(Date.now() - 3_600_000).toISOString(),
        result: ['failed', 'denied'] as AuditResult[],
        page: 1,
        pageSize: 25,
      }),
    ]);
    const fresh = !!status?.checkedAt && !status.error && Date.now() - Date.parse(status.checkedAt) < 90000;
    return {
      ...empty,
      content: JSON.stringify({
        version: SHARED_VERSION,
        uptimeMinutes: Math.round(process.uptime() / 60),
        uptimeNote: 'Время с последнего перезапуска панели; после обновления панели счёт идёт заново.',
        nodes: {
          total: status?.nodes.length ?? null,
          connected: fresh
            ? (status?.nodes.filter((n) => n.isConnected && !n.isDisabled).length ?? null)
            : null,
          checkedAt: status?.checkedAt ?? null,
          fresh,
          error: status?.error ?? null,
        },
        incidents: { open: open.counts.open, critical: open.counts.crit, warning: open.counts.warn },
        auditLastHour: { failedOrDenied: failed.total, latest: failed.items.slice(0, 5).map(auditBrief) },
        ...(deps.autoAnalysis ? { autoAnalysis: deps.autoAnalysis() } : {}),
        ...(deps.lastBackup
          ? {
              lastBackup: (await deps.lastBackup().catch(() => null)) ?? {
                note: 'Резервных копий на сервере панели нет — предложите включить их в «Настройки → Резервные копии».',
              },
            }
          : {}),
      }),
    };
  }

  if (name === 'search_conversations') {
    const query = String(arg.query ?? '').trim();
    if (searchWords(query).length === 0)
      return { ...empty, content: 'Пустой запрос: назовите хотя бы одно слово длиннее одного знака.' };
    const limit = Math.min(15, Math.max(1, Math.round(Number(arg.limit) || 8)));
    const rows = await deps.conversations.recentMessages(PAST_SCAN, deps.conversationId);
    const hits = searchPastMessages(rows, query, limit);
    return {
      ...empty,
      content:
        hits.length > 0
          ? JSON.stringify({ found: hits.length, items: hits })
          : `В прошлых беседах (последние ${PAST_SCAN} сообщений) по запросу «${query}» ничего не найдено. Не утверждайте, что этого не обсуждали: искали только в этих сообщениях.`,
    };
  }

  if (name === 'search_audit') {
    // Без query — последние события; sinceMinutes — за период (для «за час/сутки»).
    const q = String(arg.query ?? '').trim();
    const minutes = Number(arg.sinceMinutes);
    const from =
      Number.isFinite(minutes) && minutes > 0
        ? new Date(Date.now() - minutes * 60_000).toISOString()
        : undefined;
    const category = String(arg.category ?? '').trim();
    const limit = Math.min(25, Math.max(5, Math.round(Number(arg.limit) || 15)));
    const res = await deps.audit.list({
      ...(q ? { q } : {}),
      ...(from ? { from } : {}),
      ...((AUDIT_CATEGORIES as readonly string[]).includes(category)
        ? { category: [category as AuditCategory] }
        : {}),
      ...(arg.failuresOnly === true ? { result: ['failed', 'denied'] as AuditResult[] } : {}),
      page: 1,
      pageSize: limit,
    });
    return {
      content: JSON.stringify({
        total: res.total,
        shown: res.items.length,
        items: res.items.map(auditBrief),
      }),
      citations: res.items.slice(0, 3).map((e) => ({ type: 'audit', id: e.id, label: e.action })),
      proposals: [],
    };
  }

  if (name === 'search_kb') {
    const q = String(arg.query ?? '').trim();
    // С запросом — полнотекстовый поиск; без запроса — просто список статей.
    const docs = q ? await deps.kb.searchForContext(q, 4) : await deps.kb.list(undefined, false);
    const limited = docs.slice(0, q ? 4 : 30);
    const snippet = q ? 1500 : 160;
    return {
      content: JSON.stringify(
        limited.map((d) => ({
          id: d.id,
          title: d.title,
          // Дата и происхождение нужны, чтобы отличать проверенное вручную и свежее от старого и написанного Ассистентом.
          // Полная отметка, а не обрезанная до дня по UTC: в разборе её переводят в пояс панели вместе с остальными.
          updated: d.updatedAt.toISOString(),
          ageDays: Math.max(0, Math.floor((Date.now() - d.updatedAt.getTime()) / 86_400_000)),
          origin: KB_SOURCE_LABELS[d.source as KbSource] ?? d.source,
          tags: d.tags,
          content: d.content.slice(0, snippet),
        })),
      ),
      citations: limited.slice(0, 6).map((d) => ({ type: 'kb', id: d.id, label: d.title })),
      proposals: [],
    };
  }

  if (name === 'save_kb_article') {
    if (!deps.permissions.kbWrite)
      return {
        ...empty,
        content:
          'Нет разрешения на создание статей (kbWrite отключён). Сообщи пользователю, что включается это в «Настройки → Ассистент → Разрешения», и предложи готовый текст статьи прямо в ответе.',
      };
    const title = String(arg.title ?? '').trim();
    if (!title) return { ...empty, content: 'Не задан заголовок статьи — сохранить не могу.' };
    const content = String(arg.content ?? '');
    if (['пояснения', 'правила парка'].includes(title.toLowerCase()))
      return {
        ...empty,
        content:
          'Это служебная статья: «Пояснения» пополняются через add_glossary_terms, «Правила парка» пишет только владелец. Новая статья с таким названием не создана.',
      };
    if (isGlossaryArticle(title, content))
      return {
        ...empty,
        content:
          'Статья-глоссарий не создана: термины хранятся только в общей статье «Пояснения». Добавь все термины из этого текста вызовами add_glossary_terms (до 40 за вызов, при необходимости несколько вызовов подряд). Если в тексте есть и содержательная инструкция, сохрани отдельной статьёй только её, без словаря.',
      };
    const tags = Array.isArray(arg.tags)
      ? arg.tags
          .map((t) => String(t))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const saved = await deps.saveArticle({ title, content, tags });
    return {
      content: `Статья сохранена в базе знаний: «${saved.title}» (метка AI).`,
      citations: [{ type: 'kb', id: saved.id, label: saved.title }],
      proposals: [],
    };
  }

  if (name === 'add_glossary_terms') {
    const rawTerms = Array.isArray(arg.terms) ? arg.terms : [];
    const terms = rawTerms
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          term: String(o.term ?? '').trim(),
          explain: String(o.explain ?? '').trim(),
          ...(o.update === true ? { update: true } : {}),
        };
      })
      .filter((t) => t.term && t.explain)
      .slice(0, 300);
    if (terms.length === 0) return { ...empty, content: 'Нет терминов для добавления.' };
    const res = await deps.addGlossary(terms);
    const names = (list: string[]) => list.slice(0, 20).join(', ') + (list.length > 20 ? '…' : '');
    return {
      content: [
        `Глоссарий «Пояснения»: получено ${terms.length}, добавлено новых ${res.added}, уже были ${res.skipped.length}, пояснений исправлено ${res.updated.length}.`,
        res.skipped.length > 0
          ? `Уже были, не добавлены: ${names(res.skipped)}. Их пояснения не менялись.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      citations: [{ type: 'kb', id: res.id, label: 'Пояснения' }],
      proposals: [],
    };
  }

  if (name === 'propose_action') {
    if (!deps.permissions.proposals)
      return {
        ...empty,
        content:
          'Карточки предложений выключены в разрешениях (proposals). Карточки не будет: назовите шаг текстом и скажите, что включить карточки можно в «Настройки → Ассистент → Разрешения».',
      };
    const preset = String(arg.preset ?? '');
    let inc: Incident;
    try {
      inc = await deps.incidents.get(String(arg.incidentId ?? ''));
    } catch {
      return {
        ...empty,
        content: 'Инцидент с таким id не найден. Возьмите id из list_incidents. Карточка не создана.',
      };
    }
    if (inc.status === 'resolved')
      return { ...empty, content: 'Инцидент уже закрыт: предлагать нечего. Карточка не создана.' };
    if (!inc.serverId)
      return {
        ...empty,
        content: 'Сервера этого инцидента больше нет: действие выполнять не на чем. Карточка не создана.',
      };
    const chain = INCIDENT_CHAINS[inc.kind] as readonly string[];
    if (!chain.includes(preset))
      return {
        ...empty,
        content: `Шага «${preset}» нет в цепочке правил этого инцидента. Доступные: ${chain.join(', ') || 'нет'}. Карточка не создана.`,
      };
    if (inc.attempts.some((a) => a.status === 'running'))
      return {
        ...empty,
        content: 'Сейчас уже идёт попытка починки: дождитесь результата. Карточка не создана.',
      };
    const meta = actionMeta(preset);
    if (meta.level === 'T3' || meta.terminal)
      return {
        ...empty,
        content: `«${meta.title}» (T3) выполняется только вручную, карточки не будет. Напишите администратору команду текстом и последствия. Команда: ${meta.summary}.${meta.consequence ? ` Последствия: ${meta.consequence}.` : ''}`,
      };
    const reason = String(arg.reason ?? '')
      .trim()
      .slice(0, 300);
    const proposal: AssistantProposal = {
      kind: 'autofix',
      incidentId: inc.id,
      preset,
      level: meta.level,
      reason: reason || undefined,
      title: meta.title,
      description:
        [reason, meta.consequence ? `Последствия: ${meta.consequence}.` : null].filter(Boolean).join(' ') ||
        meta.summary,
    };
    return {
      content: `Карточка «${meta.title}» (${meta.level}) показана администратору. Запустит её он сам.`,
      citations: [],
      proposals: [proposal],
    };
  }

  if (name === 'propose_change') {
    if (!deps.permissions.changes)
      return {
        ...empty,
        content:
          'Изменения по подтверждению выключены в разрешениях (changes). Карточки не будет: скажите, что именно изменить и где (путь по интерфейсу), и что включить карточки можно в «Настройки → Ассистент → Разрешения».',
      };
    if (!deps.changes) return { ...empty, content: 'Предложение изменений сейчас недоступно.' };
    if (arg.operation === 'server.check' && !deps.permissions.checksHeavy)
      return {
        ...empty,
        content:
          'Предложение тяжёлых проверок выключено в разрешениях (checksHeavy). Скажите администратору, что запустить её можно самому во вкладке «Проверки» сервера, а включить карточки — в «Настройки → Ассистент → Разрешения».',
      };
    const out = await deps.changes.propose(
      String(arg.operation ?? ''),
      arg.args ?? {},
      typeof arg.reason === 'string' ? arg.reason : null,
    );
    if ('problem' in out) return { ...empty, content: out.problem };
    const c = out.change;
    return {
      content: out.reused
        ? `Такая карточка «${c.title}» уже ждёт решения в этой беседе, новая не создана.`
        : `Карточка «${c.title}» (${c.level}) для «${c.target.label}» показана администратору: ${c.rows.map((r) => `${r.label}: ${r.before} → ${r.after}`).join('; ')}. До нажатия «Применить» ничего не изменено. Не пиши, что изменение сделано: напиши, что предложил и что нужно нажать кнопку.`,
      citations: [],
      proposals: out.reused
        ? []
        : [{ kind: 'change', changeId: c.id, operation: c.operation, title: c.title, level: c.level }],
    };
  }

  // Инструмент вне аллоулиста — модель не должна вызвать, но на всякий случай явно отклоняем.
  return { ...empty, content: `Инструмент «${name}» не разрешён.` };
}

/** Enforce the actual chat boundary, even when a provider returns an unadvertised tool name. */
export async function runPassiveTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  if (!PASSIVE_TOOL_NAMES.has(name))
    return {
      content: 'Этот инструмент недоступен: Ассистент работает только с сохранёнными данными.',
      citations: [],
      proposals: [],
    };
  return runTool(name, input, deps);
}

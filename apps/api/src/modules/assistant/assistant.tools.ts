import {
  type AssistantCitation,
  type AssistantProposal,
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditResult,
  actionMeta,
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
      'Текущие настройки панели: автопроверки (интервалы/тумблеры), инциденты (пороги CPU/памяти/диска, время реакции, автопочинка) и твои собственные настройки (assistant.level — уровень пользователя, assistant.permissions — что тебе разрешено). Без секретов. Загляни сюда, если просят действие и надо проверить разрешение.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_panel_status',
    description:
      'Состояние самой панели NodeService: версия, сколько она работает без перезапуска (после обновления счёт идёт заново), серверы и агенты (сколько в сети, не в сети, какие версии агентов), число открытых инцидентов, неудачные и отклонённые события Журнала за последний час, состояние автоматического разбора. Без параметров. Зови, когда спрашивают, нормально ли работает панель, что изменилось после обновления, устарели ли агенты. Данные конкретных серверов бери из get_server_detail.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_audit',
    description:
      'Журнал событий панели (входы, изменения, инциденты, запросы к Джарвису). Для вопросов про период («за час», «за сутки», «сегодня») передай sinceMinutes (час = 60, сутки = 1440) — вернутся события за этот срок. query — необязательный полнотекстовый поиск (слова, «фразы», -минус). category сужает по разделу, failuresOnly оставляет только неудачные и отклонённые события, limit задаёт число записей (5–25, по умолчанию 15). В каждой записи: время, что произошло, кто (администратор или панель), результат, важность, цель и короткая выдержка из деталей (у «Запрос к Джарвису» это вопрос и ответ, у изменений — поле до и после). total — сколько всего событий подошло: если больше показанных, скажи об этом. Прошлые беседы с Джарвисом ищи через search_conversations.',
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
      'Поиск по прошлым беседам с Джарвисом (вопросы администратора и твои ответы), кроме текущей беседы. Нужен, когда спрашивают «мы уже это обсуждали», «что я спрашивал про…», «что ты советовал в прошлый раз». query — слова через пробел, все должны встретиться в одном сообщении (регистр и «ё» не важны). limit — сколько записей вернуть (1–15, по умолчанию 8). В ответе: название беседы, время, кто писал и кусок текста. Это память о разговорах, а не факты о парке: текущие данные всё равно бери инструментами чтения.',
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
      'База знаний (статьи-runbooks и глоссарий «Пояснения»). С query — полнотекстовый поиск по теме. У каждой статьи есть дата обновления, возраст в днях и происхождение (Вручную, Джарвис, Веб, Telegram): ссылаясь на статью, называй дату; сведения старше полугода или написанные Джарвисом подавай как «возможно, устарело» или «не проверено человеком». БЕЗ query — список всех статей (для «какие статьи у нас есть»). Всегда проверяй тут перед созданием новой статьи.',
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
];

export interface ToolDeps extends ReadDeps {
  kb: KnowledgeRepository;
  audit: AuditRepository;
  /** Поиск по прошлым беседам; conversationId — текущая беседа, её из результатов исключаем. */
  conversations: Pick<AssistantRepository, 'recentMessages'>;
  conversationId?: string;
  autochecks: { get: () => Promise<unknown> };
  incidentSettings: { get: () => Promise<unknown> };
  /** Снимок настроек самого агента — уровень и разрешения (только чтение). */
  assistant: { level: string };
  /** Что делал автоматический разбор инцидентов с момента запуска панели. */
  autoAnalysis?: () => { lastRunAt: string | null; startedLastHour: number; limitPerHour: number };
  /** Создание статьи в БЗ (метка AI). Гейтится разрешением kbWrite в самом инструменте. */
  saveArticle: (a: {
    title: string;
    content: string;
    tags: string[];
  }) => Promise<{ id: string; title: string }>;
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
}

/** Выполнить инструмент из аллоулиста. Неизвестный инструмент — явная ошибка (не молчим). */
export async function runTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  const arg = (input ?? {}) as Record<string, unknown>;
  const empty: ToolOutcome = { content: '', citations: [], proposals: [] };

  const read = await runReadTool(name, arg, deps);
  if (read) return read;

  if (name === 'get_settings') {
    const [autochecks, incidents] = await Promise.all([deps.autochecks.get(), deps.incidentSettings.get()]);
    return {
      content: JSON.stringify({
        autochecks,
        incidents,
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

  if (name === 'get_panel_status') {
    const [servers, open, failed] = await Promise.all([
      deps.servers.list(),
      deps.incidents.list('open'),
      deps.audit.list({
        from: new Date(Date.now() - 3_600_000).toISOString(),
        result: ['failed', 'denied'] as AuditResult[],
        page: 1,
        pageSize: 25,
      }),
    ]);
    const agents: Record<string, number> = {};
    const versions: Record<string, number> = {};
    for (const srv of servers) {
      agents[srv.agentStatus] = (agents[srv.agentStatus] ?? 0) + 1;
      if (srv.agentVersion) versions[srv.agentVersion] = (versions[srv.agentVersion] ?? 0) + 1;
    }
    return {
      ...empty,
      content: JSON.stringify({
        version: SHARED_VERSION,
        uptimeMinutes: Math.round(process.uptime() / 60),
        uptimeNote: 'Время с последнего перезапуска панели; после обновления панели счёт идёт заново.',
        servers: { total: servers.length, agents, agentVersions: versions },
        incidents: { open: open.counts.open, critical: open.counts.crit, warning: open.counts.warn },
        auditLastHour: { failedOrDenied: failed.total, latest: failed.items.slice(0, 5).map(auditBrief) },
        ...(deps.autoAnalysis ? { autoAnalysis: deps.autoAnalysis() } : {}),
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
          // Дата и происхождение нужны, чтобы отличать проверенное вручную и свежее от старого и написанного Джарвисом.
          updated: d.updatedAt.toISOString().slice(0, 10),
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
          'Нет разрешения на создание статей (kbWrite отключён). Сообщи пользователю, что включается это в «Настройки → Джарвис → Разрешения», и предложи готовый текст статьи прямо в ответе.',
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
          'Карточки предложений выключены в разрешениях (proposals). Карточки не будет: назовите шаг текстом и скажите, что включить карточки можно в «Настройки → Джарвис → Разрешения».',
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

  // Инструмент вне аллоулиста — модель не должна вызвать, но на всякий случай явно отклоняем.
  return { ...empty, content: `Инструмент «${name}» не разрешён.` };
}

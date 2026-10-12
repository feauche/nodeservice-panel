import {
  ASSISTANT_CHECKS,
  type AssistantAdvice,
  type AssistantCheck,
  type AssistantCitation,
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditResult,
  KB_SOURCE_LABELS,
  type KbSource,
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

/** Инструменты модели: чтение панели и запись в базу знаний. Ничего другого Ассистент не меняет. */
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
    name: 'recommend_check',
    description:
      'Посоветовать владельцу проверку ноды. Под твоим ответом появится карточка: какая проверка, для какой ноды, зачем, что покажет, сколько стоит, и кнопка «Открыть проверку». Сам ничего не запускает и не тратит деньги. check: tcp — порт через Check-Host (бесплатно, открыт ли порт из России и Европы); dpi — DPI Checker (платно, открывается ли нода у домашних провайдеров России); bs — BS Checker (кредиты, проходит ли белые списки мобильных операторов; только для нод с whitelist: true). node — UUID, точное имя или адрес ноды. reason — одна короткая фраза владельцу, зачем эта проверка сейчас. Порядок обычно: сначала tcp, потом dpi; для нод белого списка — bs вместо dpi. Не больше двух советов за ответ. Если советуешь проверку, вызывай этот инструмент, а не описывай кнопки текстом.',
    input_schema: {
      type: 'object',
      properties: {
        check: { type: 'string', enum: [...ASSISTANT_CHECKS] },
        node: { type: 'string' },
        reason: { type: 'string', description: 'одна фраза, до 200 знаков' },
      },
      required: ['check', 'node', 'reason'],
    },
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
      'Создать статью в базе знаний (метка AI ставится сама). Используй, когда пользователь просит сохранить инструкцию, разбор или решение. Тело — в Markdown: заголовки, списки, блоки кода с языком, таблицы.',
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
];

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
  /** Последняя резервная копия панели («Настройки → Резервные копии»). */
  lastBackup?: () => Promise<{ at: string; kind: string; size: string; verified: boolean | null } | null>;
  /** Создание статьи в БЗ (метка AI): единственное, кроме «Пояснений», что Ассистент записывает сам. */
  saveArticle: (a: {
    title: string;
    content: string;
    tags: string[];
  }) => Promise<{ id: string; title: string }>;
  /** Статус Remnawave (J4), если владелец её подключил; нет — инструмент честно говорит «не подключена». */
  remnawave?: { status: () => Promise<import('@nodeservice/shared').RemnawaveStatus> };
  /** UUID нод с отметкой «Сервер белого списка» (настройки ноды). Для них советуется BS Checker. */
  whitelisted?: (domain: string | null) => Promise<Set<string>>;
  /** Пополнение глоссария «Пояснения». Работает всегда, отдельного разрешения нет. */
  addGlossary: (
    terms: Array<{ term: string; explain: string; update?: boolean }>,
  ) => Promise<{ id: string; added: number; skipped: string[]; updated: string[] }>;
}

/** Результат выполнения инструмента: текст для модели + накопленные цитаты/предложения. */
export interface ToolOutcome {
  content: string;
  citations: AssistantCitation[];
  /** Запись в базу знаний действительно прошла: только тогда Ассистент вправе сказать «сохранил». */
  kbWritten?: boolean;
  /** Совет проверки — карточка под ответом. */
  advice?: AssistantAdvice[];
}

/** Выполнить инструмент из аллоулиста. Неизвестный инструмент — явная ошибка (не молчим). */
export async function runTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  const arg = (input ?? {}) as Record<string, unknown>;
  const empty: ToolOutcome = { content: '', citations: [] };
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
        },
      }),
      citations: [],
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

  if (name === 'recommend_check') {
    const check = String(arg.check ?? '') as AssistantCheck;
    if (!(ASSISTANT_CHECKS as readonly string[]).includes(check))
      return { ...empty, content: `Неизвестная проверка «${check}». Допустимо: tcp, dpi, bs.` };
    const reason = String(arg.reason ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!reason) return { ...empty, content: 'Не указано, зачем проверка: передай reason одной фразой.' };
    if (!deps.remnawave)
      return { ...empty, content: 'Remnawave не подключена: советовать проверку ноды не для чего.' };
    const st = await deps.remnawave.status();
    const key = String(arg.node ?? '')
      .trim()
      .toLowerCase();
    const matches = st.nodes.filter((n) => [n.uuid, n.name, n.address].some((v) => v.toLowerCase() === key));
    const target = matches.length === 1 ? matches[0] : undefined;
    if (!target)
      return {
        ...empty,
        content: 'Нода не найдена или имя неоднозначно. Возьми UUID из get_remnawave_status и повтори.',
      };
    const marked = (await deps.whitelisted?.(st.domain).catch(() => null)) ?? new Set<string>();
    const whitelist = marked.has(target.uuid);
    // Белый список мобильных DPI Checker не видит: для такой ноды советуем BS Checker.
    const final: AssistantCheck = check === 'dpi' && whitelist ? 'bs' : check;
    return {
      ...empty,
      content: `Карточка совета добавлена под ответ: ${final === 'tcp' ? 'порт через Check-Host' : final === 'dpi' ? 'DPI Checker' : 'BS Checker'} для «${target.name}»${final !== check ? ' (нода отмечена как сервер белого списка, поэтому BS Checker вместо DPI Checker)' : ''}. В тексте ответа хватит одной фразы о совете, кнопки описывать не нужно.`,
      citations: [{ type: 'node', id: target.uuid, label: target.name }],
      advice: [
        {
          check: final,
          nodeUuid: target.uuid,
          nodeName: target.name,
          address: target.address ? `${target.address}${target.port ? `:${target.port}` : ''}` : null,
          reason,
        },
      ],
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
    const marked = (await deps.whitelisted?.(st.domain).catch(() => null)) ?? new Set<string>();
    // whitelist — отметка владельца «Сервер белого списка»: для таких нод проверка — BS Checker.
    const nodes = st.nodes.map((n) => ({ ...n, whitelist: marked.has(n.uuid) }));
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
    };
  }

  if (name === 'save_kb_article') {
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
      kbWritten: true,
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
      kbWritten: res.added + res.updated.length > 0,
    };
  }

  // Инструмент вне аллоулиста — модель не должна вызвать, но на всякий случай явно отклоняем.
  return { ...empty, content: `Инструмент «${name}» не разрешён.` };
}

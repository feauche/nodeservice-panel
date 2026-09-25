import {
  type AssistantCitation,
  type AssistantProposal,
  actionMeta,
  INCIDENT_CHAINS,
  type Incident,
  type ReachabilityResult,
} from '@nodeservice/shared';

import type { AuditRepository } from '../audit/audit.repository.js';
import type { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { READ_TOOL_DEFS, type ReadDeps, runReadTool } from './assistant.read-tools.js';
import type { LlmToolDef } from './llm.provider.js';

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
    name: 'search_audit',
    description:
      'Журнал событий панели (входы, изменения, инциденты, запросы к ассистенту). Для вопросов про период («за час», «за сутки», «сегодня») передай sinceMinutes (час = 60, сутки = 1440) — вернутся события за этот срок. query — необязательный полнотекстовый поиск. Без обоих — просто последние 15 событий. В ответе есть время каждого события.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        sinceMinutes: { type: 'number', description: 'события за последние N минут (час = 60)' },
      },
    },
  },
  {
    name: 'search_kb',
    description:
      'База знаний (статьи-runbooks и глоссарий «Пояснения»). С query — полнотекстовый поиск по теме. БЕЗ query — список всех статей (для «какие статьи у нас есть»). Всегда проверяй тут перед созданием новой статьи.',
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
      'Добавить термины и аббревиатуры в общий глоссарий «Пояснения» (таблица «термин → простое объяснение»). Вызывай ВСЕГДА, когда объясняешь пользователю непонятный термин/аббревиатуру — даже базовые (SSH, CPU, conntrack). Дубликаты инструмент отсекает сам. Требует разрешения glossary. Пояснения — короткие, простыми словами.',
    input_schema: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: {
            type: 'object',
            properties: { term: { type: 'string' }, explain: { type: 'string' } },
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
  autochecks: { get: () => Promise<unknown> };
  incidentSettings: { get: () => Promise<unknown> };
  /** Снимок настроек самого агента — уровень и разрешения (только чтение). */
  assistant: { level: string; permissions: Record<string, boolean> };
  /** Создание статьи в БЗ (метка AI). Гейтится разрешением kbWrite в самом инструменте. */
  saveArticle: (a: {
    title: string;
    content: string;
    tags: string[];
  }) => Promise<{ id: string; title: string }>;
  /** Пополнение глоссария «Пояснения». Гейтится разрешением glossary в самом инструменте. */
  addGlossary: (terms: Array<{ term: string; explain: string }>) => Promise<{ id: string; added: number }>;
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
      content: JSON.stringify({ autochecks, incidents, assistant: deps.assistant }),
      citations: [],
      proposals: [],
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
    const res = await deps.audit.list({
      ...(q ? { q } : {}),
      ...(from ? { from } : {}),
      page: 1,
      pageSize: 15,
    });
    return {
      content: JSON.stringify(
        res.items.map((e) => ({ at: e.occurredAt, action: e.action, target: e.targetDisplay })),
      ),
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
        limited.map((d) => ({ id: d.id, title: d.title, content: d.content.slice(0, snippet) })),
      ),
      citations: limited.slice(0, 6).map((d) => ({ type: 'kb', id: d.id, label: d.title })),
      proposals: [],
    };
  }

  if (name === 'save_kb_article') {
    if (!deps.assistant.permissions.kbWrite)
      return {
        ...empty,
        content:
          'Нет разрешения на создание статей (kbWrite отключён). Сообщи пользователю, что включается это в «Настройки → Ассистент → Разрешения», и предложи готовый текст статьи прямо в ответе.',
      };
    const title = String(arg.title ?? '').trim();
    if (!title) return { ...empty, content: 'Не задан заголовок статьи — сохранить не могу.' };
    const content = String(arg.content ?? '');
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
    if (!deps.assistant.permissions.glossary)
      return {
        ...empty,
        content:
          'Нет разрешения на автоглоссарий (glossary отключён). Скажи пользователю, что включается это в «Настройки → Ассистент → Разрешения».',
      };
    const rawTerms = Array.isArray(arg.terms) ? arg.terms : [];
    const terms = rawTerms
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return { term: String(o.term ?? '').trim(), explain: String(o.explain ?? '').trim() };
      })
      .filter((t) => t.term && t.explain)
      .slice(0, 30);
    if (terms.length === 0) return { ...empty, content: 'Нет терминов для добавления.' };
    const res = await deps.addGlossary(terms);
    return {
      content: `Глоссарий «Пояснения» пополнен (добавлено новых: ${res.added}).`,
      citations: [{ type: 'kb', id: res.id, label: 'Пояснения' }],
      proposals: [],
    };
  }

  if (name === 'propose_action') {
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

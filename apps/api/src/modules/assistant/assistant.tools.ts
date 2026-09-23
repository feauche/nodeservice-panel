import {
  type AssistantCitation,
  type AssistantProposal,
  INCIDENT_ACTIONS,
  VM_METRIC_NAMES,
} from '@nodeservice/shared';

import type { AuditRepository } from '../audit/audit.repository.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import type { VmReaderService } from '../metrics/vm-reader.service.js';
import type { ServersService } from '../servers/servers.service.js';
import type { LlmToolDef } from './llm.provider.js';

/** Определения инструментов для модели (read-only + propose_action). */
export const ASSISTANT_TOOLS: LlmToolDef[] = [
  {
    name: 'get_fleet_status',
    description:
      'Полный список серверов парка: имя, id, адрес (ip/домен:порт), пользователь SSH, теги, статус агента и его версия, состояние SSH, ОС/архитектура, ядра, память, когда последний раз проверяли. И число открытых инцидентов.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_server_detail',
    description:
      'Детали одного сервера по id: все поля + последние метрики (CPU %, память, диск, сеть, conntrack, аптайм).',
    input_schema: { type: 'object', properties: { serverId: { type: 'string' } }, required: ['serverId'] },
  },
  {
    name: 'get_settings',
    description:
      'Текущие настройки панели: автопроверки (интервалы/тумблеры), инциденты (пороги CPU/памяти/диска, время реакции, автопочинка) и твои собственные настройки (assistant.level — уровень пользователя, assistant.permissions — что тебе разрешено). Без секретов. Загляни сюда, если просят действие и надо проверить разрешение.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'query_metrics',
    description:
      'Последнее значение метрики сервера. metric: cpuPct|memUsedMb|diskUsedMb|netRxBps|conntrackCount.',
    input_schema: {
      type: 'object',
      properties: { serverId: { type: 'string' }, metric: { type: 'string' } },
      required: ['serverId', 'metric'],
    },
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
      'Предложить администратору безопасное действие для инцидента. НЕ выполняет — только предлагает. preset: node_up|restart_node|free_disk|apt_clean|agent_reinstall.',
    input_schema: {
      type: 'object',
      properties: {
        incidentId: { type: 'string' },
        preset: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['incidentId', 'preset', 'title', 'description'],
    },
  },
];

export interface ToolDeps {
  servers: ServersService;
  incidents: IncidentsService;
  metrics: VmReaderService;
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
}

const METRIC_ALLOW = new Set(Object.keys(VM_METRIC_NAMES));

/** Выполнить инструмент из аллоулиста. Неизвестный инструмент — явная ошибка (не молчим). */
export async function runTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  const arg = (input ?? {}) as Record<string, unknown>;
  const empty: ToolOutcome = { content: '', citations: [], proposals: [] };

  if (name === 'get_fleet_status') {
    const servers = await deps.servers.list();
    const incidents = await deps.incidents.list('open');
    const summary = servers.map((s) => ({
      id: s.id,
      name: s.name,
      address: `${s.sshUser}@${s.host}:${s.port}`,
      tags: s.tags,
      agent: s.agentStatus,
      agentVersion: s.agentVersion,
      ssh: s.sshOk,
      os: [s.facts.os, s.facts.osVersion].filter(Boolean).join(' ') || null,
      arch: s.facts.arch,
      cpuCores: s.facts.cpuCores,
      memoryMb: s.facts.memoryMb,
      lastCheck: s.lastSshCheckAt,
    }));
    return {
      content: JSON.stringify({ servers: summary, openIncidents: incidents.items.length }),
      citations: incidents.items.slice(0, 3).map((i) => ({ type: 'incident', id: i.id, label: i.title })),
      proposals: [],
    };
  }

  if (name === 'get_server_detail') {
    const id = String(arg.serverId ?? '');
    const server = (await deps.servers.list()).find((s) => s.id === id);
    if (!server) return { ...empty, content: 'Сервер с таким id не найден.' };
    const metric = async (key: keyof typeof VM_METRIC_NAMES) => {
      const res = await deps.metrics.query(`${VM_METRIC_NAMES[key]}{server_id="${id}"}`);
      const v = res?.[0]?.points.at(-1)?.[1];
      return v !== undefined && Number.isFinite(v) ? v : null;
    };
    const [cpu, memUsed, memTotal, diskUsed, diskTotal, rx, tx, conntrack, uptime] = await Promise.all([
      metric('cpuPct'),
      metric('memUsedMb'),
      metric('memTotalMb'),
      metric('diskUsedMb'),
      metric('diskTotalMb'),
      metric('netRxBps'),
      metric('netTxBps'),
      metric('conntrackCount'),
      metric('cpuPct'),
    ]);
    return {
      content: JSON.stringify({
        id: server.id,
        name: server.name,
        address: `${server.sshUser}@${server.host}:${server.port}`,
        tags: server.tags,
        notes: server.notes,
        agent: server.agentStatus,
        agentVersion: server.agentVersion,
        ssh: server.sshOk,
        facts: server.facts,
        metrics: {
          cpuPct: cpu,
          memUsedMb: memUsed,
          memTotalMb: memTotal,
          diskUsedMb: diskUsed,
          diskTotalMb: diskTotal,
          netRxBps: rx,
          netTxBps: tx,
          conntrack,
          uptimeSec: uptime,
        },
      }),
      citations: [{ type: 'server', id: server.id, label: server.name }],
      proposals: [],
    };
  }

  if (name === 'get_settings') {
    const [autochecks, incidents] = await Promise.all([deps.autochecks.get(), deps.incidentSettings.get()]);
    return {
      content: JSON.stringify({ autochecks, incidents, assistant: deps.assistant }),
      citations: [],
      proposals: [],
    };
  }

  if (name === 'query_metrics') {
    const serverId = String(arg.serverId ?? '');
    const metric = String(arg.metric ?? '');
    if (!METRIC_ALLOW.has(metric)) return { ...empty, content: 'Неизвестная метрика.' };
    const vm = VM_METRIC_NAMES[metric as keyof typeof VM_METRIC_NAMES];
    const res = await deps.metrics.query(`${vm}{server_id="${serverId}"}`);
    const v = res?.[0]?.points.at(-1)?.[1];
    return {
      content: JSON.stringify({ metric, serverId, value: v ?? null }),
      citations: v !== undefined ? [{ type: 'metric', id: `${serverId}:${metric}`, label: metric }] : [],
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
    if (!INCIDENT_ACTIONS.some((a) => a.key === preset && !a.terminal))
      return { ...empty, content: 'Неизвестный пресет — предложение отклонено.' };
    const proposal: AssistantProposal = {
      kind: 'autofix',
      incidentId: String(arg.incidentId ?? ''),
      preset,
      title: String(arg.title ?? ''),
      description: String(arg.description ?? ''),
    };
    return {
      content: 'Предложение показано администратору для подтверждения.',
      citations: [],
      proposals: [proposal],
    };
  }

  // Инструмент вне аллоулиста — модель не должна вызвать, но на всякий случай явно отклоняем.
  return { ...empty, content: `Инструмент «${name}» не разрешён.` };
}

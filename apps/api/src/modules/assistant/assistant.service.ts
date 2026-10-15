import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ASSISTANT_ADVICE_MAX,
  type AssistantAdvice,
  type AssistantChatResponse,
  type AssistantCitation,
  type AssistantContext,
  type AssistantMessage,
  type AssistantStatus,
  brandNamePlain,
  INCIDENT_KIND_META,
} from '@nodeservice/shared';
import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import type { AssistantMessageRow } from '../../infra/db/schema/index.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { BackupsService } from '../backups/backups.service.js';
import { BillingService } from '../billing/billing.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { NodeMetricsService } from '../node-metrics/node-metrics.controller.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NodeMaintenanceStore } from '../remnawave/node-maintenance.store.js';
import { NodePreferencesStore } from '../remnawave/node-preferences.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { RemnawaveTopologyService } from '../remnawave/remnawave-topology.service.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { SettingsService } from '../settings/settings.service.js';
import { recentHistory } from './assistant.history.js';
import { AssistantPanelReader } from './assistant.panel-reader.js';
import { buildSystem } from './assistant.prompt.js';
import { AssistantRepository } from './assistant.repository.js';
import { ASSISTANT_TOOLS, runTool, type ToolDeps } from './assistant.tools.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import {
  describeLlmError,
  LLM_PROVIDER,
  type LlmBlock,
  type LlmMsg,
  type LlmProvider,
  type LlmResp,
  type LlmRunInput,
} from './llm.provider.js';

const MAX_TOOL_ROUNDS = 8;
/** Сколько раз за ход можно «подтолкнуть» модель, если она ответила пустотой или пообещала вызов без вызова. */
const MAX_NUDGES = 2;
const PROMISE_RE =
  /(?:сейчас|сразу|теперь|далее|щас|давайте)\s+(?:вызову|вызываю|проверю|посмотрю|запрошу|получу|запущу|выясню|уточню)|(?:вызову|вызываю)\s+(?:инструмент|функцию)|нужно\s+(?:было\s+)?вызвать/i;
const NUDGE_PROMISE =
  'Вы написали, что вызовете инструмент, но не вызвали. Вызовите нужный инструмент прямо сейчас, а затем дайте ответ по его результату.';
/** «Добавил», «сохранил статью», а инструмент записи в этом ходе не вызывался: на деле ничего не записано. */
const CLAIM_RE =
  /(?:^|[.!?\n]\s*)(?:я\s+)?(?:[А-Яа-яЁё]+\s+){0,4}(?:добавил|сохранил|создал|записал)(?![а-яё])[^."\n{}:]{0,80}(?:глоссар|стать|баз[а-я]{1,2} знаний|«?пояснени)/i;
const NUDGE_CLAIM =
  'Вы написали, что сохранили в базу знаний, но инструмент записи не вызывали: ничего не сохранено. Если запись нужна, вызовите save_kb_article или add_glossary_terms; иначе исправьте утверждение.';
const CLAIM_WARNING = 'Внимание: в базе знаний ничего не сохранено — Ассистент не вызывал запись.';
const NUDGE_EMPTY = 'Ответ пустой. Вызовите нужный инструмент или ответьте текстом по уже имеющимся данным.';
const NUDGE_FINAL =
  'Дайте итоговый ответ администратору по уже полученным данным. Инструменты больше недоступны, ничего не обещайте вызвать.';

/** Ассистент: цикл tool-use по данным панели, запись только в базу знаний, беседы в БД. */
@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);

  constructor(
    private readonly settings: AssistantSettingsStore,
    private readonly repo: AssistantRepository,
    private readonly incidents: IncidentsService,
    private readonly billing: BillingService,
    private readonly backups: BackupsService,
    private readonly kb: KnowledgeRepository,
    private readonly knowledge: KnowledgeService,
    private readonly auditRepo: AuditRepository,
    private readonly audit: AuditService,
    private readonly monitoring: MonitoringStore,
    private readonly incidentSettings: IncidentsSettingsStore,
    private readonly remnawave: RemnawaveService,
    private readonly nodeMetrics: NodeMetricsService,
    private readonly remnawaveTopology: RemnawaveTopologyService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly integrations: IntegrationsService,
    private readonly panelSettings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
    private readonly nodePrefs: NodePreferencesStore,
    private readonly panelReader: AssistantPanelReader,
    @Optional() private readonly nodeMaintenance?: NodeMaintenanceStore,
  ) {}

  status(): Promise<AssistantStatus> {
    return this.settings.status();
  }

  private toMessage(row: AssistantMessageRow): AssistantMessage {
    return {
      id: row.id,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      citations: (row.citations as AssistantCitation[]) ?? [],
      advice: (row.advice as AssistantAdvice[]) ?? [],
      context: (row.context as AssistantContext | null) ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Вопрос задан со страницы события или из окна ноды: метка для истории и данные для модели.
   * Если события или ноды уже нет, метку не ставим — вопрос уходит как обычный.
   */
  private async resolveContext(
    ref: { kind: 'incident' | 'node'; id: string } | undefined,
  ): Promise<{ context: AssistantContext; brief: string } | null> {
    if (!ref) return null;
    try {
      if (ref.kind === 'incident') {
        const inc = await this.incidents.get(ref.id);
        const brief = {
          title: inc.title,
          kind: INCIDENT_KIND_META[inc.kind]?.label ?? inc.kind,
          status: inc.status,
          severity: inc.severity,
          openedAt: inc.openedAt,
          resolvedAt: inc.resolvedAt,
          node: inc.nodeUuid ? { uuid: inc.nodeUuid, name: inc.serverName } : null,
          detail: inc.detail,
          timeline: inc.timeline.slice(-10),
          snapshot: inc.snapshot,
        };
        return {
          context: { kind: 'incident', id: ref.id, label: `Событие: ${inc.title}` },
          brief: `Вопрос задан со страницы события. Данные события из панели: ${JSON.stringify(brief)}. Опирайся на них; за свежим состоянием ноды обращайся к инструментам.`,
        };
      }
      const st = await this.remnawave.status();
      const node = st.nodes.find((n) => n.uuid === ref.id);
      if (!node) return null;
      return {
        context: { kind: 'node', id: ref.id, label: `Нода: ${node.name}` },
        brief: `Вопрос задан из окна ноды «${node.name}» (UUID ${node.uuid}, адрес ${node.address}${node.port ? `:${node.port}` : ''}). Её состояние и историю смотри инструментами get_node_detail и get_node_metrics.`,
      };
    } catch {
      return null;
    }
  }

  async conversations() {
    const rows = await this.repo.listConversations();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async history(conversationId: string) {
    const conv = await this.repo.findConversation(conversationId);
    if (!conv) throw problem(HttpStatus.NOT_FOUND, { detail: 'Беседа не найдена.' });
    return (await this.repo.messages(conversationId)).map((r) => this.toMessage(r));
  }

  /** Вызов модели: сбой провайдера не должен превращаться в «Что-то пошло не так на сервере». */
  private async runLlm(input: LlmRunInput): Promise<LlmResp> {
    try {
      return await this.llm.run(input);
    } catch (err) {
      this.log.warn(
        `Провайдер модели вернул ошибку: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      throw problem(HttpStatus.FAILED_DEPENDENCY, { detail: describeLlmError(err) });
    }
  }

  async chat(
    message: string,
    conversationId: string | undefined,
    contextRef?: { kind: 'incident' | 'node'; id: string },
  ): Promise<AssistantChatResponse> {
    const cfg = await this.settings.config();
    if (!cfg)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Ассистент выключен: задай провайдера, ключ и модель в Настройки → Ассистент.',
      });
    const { apiKey, model, level } = cfg;

    const existing = conversationId ? await this.repo.findConversation(conversationId) : undefined;
    const conv = existing ?? (await this.repo.createConversation(message.slice(0, 60)));
    // Что Ассистент знает о панели помимо инструментов. Ошибка любого чтения не должна ронять чат.
    const [fleetRules, appearance, zone, integrations, sites] = await Promise.all([
      this.knowledge.fleetRules().catch(() => null),
      this.panelSettings.getAppearance().catch(() => null),
      this.notifications.timeZone().catch(() => null),
      this.integrations
        .list()
        .then((r) => r.items)
        .catch(() => undefined),
      this.panelSettings
        .getCustomSites()
        .then((r) => r.items)
        .catch(() => undefined),
    ]);
    const system = buildSystem(level, {
      fleetRules,
      panelUrl: this.config.get('PUBLIC_URL'),
      brandName: appearance ? brandNamePlain(appearance.brandName) : null,
      timeZone: appearance?.timeZone ?? zone,
      ...(integrations
        ? {
            integrations: integrations.map((i) => ({
              provider: i.provider,
              connected: i.connected,
              balance: i.balance,
            })),
          }
        : {}),
      ...(sites ? { customSites: sites.map((site) => ({ name: site.name })) } : {}),
    });

    const ctx = await this.resolveContext(contextRef);
    const asked = await this.repo.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: message,
      context: ctx?.context ?? null,
    });

    // История беседы → сообщения модели (только текст; предыдущий tool-контекст не тащим).
    // К текущему вопросу со страницы события или из окна ноды впереди добавляем их данные.
    const prior = await this.repo.messages(conv.id);
    const kept = recentHistory(prior.filter((m) => m.content.trim().length > 0));
    const messages: LlmMsg[] = kept.items.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content:
        m.id === asked.id && ctx
          ? [
              { type: 'text', text: ctx.brief },
              { type: 'text', text: m.content },
            ]
          : [{ type: 'text', text: m.content }],
    }));
    if (kept.omitted > 0) {
      // Модель должна знать, что начало беседы не видит: иначе ответит так, будто его не было.
      const note = `(Начало беседы — ${kept.omitted} сообщ. — сюда не вошло, чтобы запрос не разрастался. Если вопрос опирается на него, попроси владельца напомнить.)`;
      if (messages[0]?.role === 'user')
        messages[0].content = [{ type: 'text', text: note }, ...messages[0].content];
      else messages.unshift({ role: 'user', content: [{ type: 'text', text: note }] });
    }

    const deps: ToolDeps = {
      incidents: this.incidents,
      billing: this.billing,
      remnawaveProfiles: this.remnawave,
      remnawaveTopology: this.remnawaveTopology,
      kb: this.kb,
      audit: this.auditRepo,
      conversations: this.repo,
      conversationId: conv.id,
      monitoring: this.monitoring,
      incidentSettings: this.incidentSettings,
      assistant: { level },
      lastBackup: () => this.backups.lastBackup(),
      nodeMetrics: async (minutes, uuid) => {
        const data = await this.nodeMetrics.localHistory(minutes);
        const status = await this.remnawave.status();
        if (data.panel !== status.domain) return { error: 'Подключение изменилось. Повторите запрос.' };
        const current = new Set(status.nodes.map((n) => n.uuid));
        return {
          ...data,
          history: data.history.filter((n) => current.has(n.uuid) && (!uuid || n.uuid === uuid)),
        };
      },
      remnawave: this.remnawave,
      saveArticle: async (a) => {
        const doc = await this.knowledge.create(
          { title: a.title, content: a.content, tags: a.tags, source: 'ai' },
          { auditSource: 'auto' },
        );
        return { id: doc.id, title: doc.title };
      },
      addGlossary: (terms) => this.knowledge.appendGlossary(terms, { auditSource: 'auto' }),
      whitelisted: (domain) => this.nodePrefs.whitelisted(domain),
      maintenance: async (domain) => (await this.nodeMaintenance?.active(domain)) ?? new Map(),
      // Сценарии, интеграции, копии, сайты, провайдеры и разделы настроек — только чтение.
      ...this.panelReader.deps(),
    };
    const citations: AssistantCitation[] = [];
    const advice: AssistantAdvice[] = [];
    /** Реплики по ходу работы («Смотрю данные…»): каждая идёт отдельным сообщением. */
    const interim: string[] = [];
    let answer = '';
    let toolCalls = 0;
    let kbWrites = 0;
    let nudges = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const res = await this.runLlm({
        apiKey,
        model,
        system,
        messages,
        tools: ASSISTANT_TOOLS,
      });
      const text = textOf(res.blocks);
      const uses = res.blocks.filter(
        (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (uses.length === 0) {
        // Пустой ответ или обещание вызвать инструмент без вызова: один-два толчка вместо «Не удалось сформировать ответ».
        const promised = PROMISE_RE.test(text);
        const claimed = kbWrites === 0 && CLAIM_RE.test(text);
        if (nudges < MAX_NUDGES && round < MAX_TOOL_ROUNDS - 1 && (!text || promised || claimed)) {
          nudges += 1;
          if (text) messages.push({ role: 'assistant', content: res.blocks });
          appendUserText(messages, !text ? NUDGE_EMPTY : promised ? NUDGE_PROMISE : NUDGE_CLAIM);
          continue;
        }
        answer = text;
        break;
      }
      if (text && interim.at(-1) !== text) interim.push(text);

      messages.push({ role: 'assistant', content: res.blocks });
      const results: LlmBlock[] = [];
      for (const use of uses) {
        toolCalls += 1;
        try {
          const outcome = await runTool(use.name, use.input, deps);
          if (outcome.kbWritten) kbWrites += 1;
          citations.push(...outcome.citations);
          if (outcome.advice) advice.push(...outcome.advice);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content });
        } catch (err) {
          // Падение одного инструмента не должно ронять весь чат: логируем и даём модели
          // текстовый результат, чтобы она ответила по имеющимся данным.
          this.log.warn(
            `Инструмент «${use.name}» завершился ошибкой: ${err instanceof Error ? err.message : String(err)}`,
          );
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'Инструмент временно недоступен — ответь по имеющимся данным.',
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    if (!answer) {
      // Раунды кончились на вызовах инструментов или ответа так и нет: просим итог по собранному, без инструментов.
      appendUserText(messages, NUDGE_FINAL);
      const res = await this.runLlm({ apiKey, model, system, messages, tools: [] });
      answer = textOf(res.blocks);
    }

    let finalText = answer || 'Не удалось получить ответ. Повторите вопрос.';
    // Модель заявила «сохранил», а инструмент записи так и не вызвала: честно говорим, что записи нет.
    if (kbWrites === 0 && CLAIM_RE.test(finalText)) finalText = `${finalText}\n\n${CLAIM_WARNING}`;
    // Ответ можно разбить на несколько сообщений строкой «===»: вывод, затем инструкция, затем команды.
    const parts = finalText
      .split(/\n[ \t]*={3,}[ \t]*\n/)
      .map((t) => t.trim())
      .filter(Boolean);
    const texts = [...interim, ...(parts.length > 0 ? parts : [finalText])];
    const saved: AssistantMessageRow[] = [];
    for (const [i, content] of texts.entries()) {
      const last = i === texts.length - 1;
      saved.push(
        await this.repo.addMessage({
          conversationId: conv.id,
          role: 'assistant',
          content,
          // Вложения относятся к итогу, а не к промежуточным репликам.
          citations: last ? dedupe(citations) : [],
          advice: last ? dedupeAdvice(advice) : [],
        }),
      );
    }
    await this.audit.record({
      action: 'assistant.chat',
      target: { type: 'assistant', id: conv.id, display: conv.title },
      // Вопрос и превью ответа — прямо в записи Журнала, чтобы её было видно без открытия беседы.
      metadata: {
        question: previewText(message),
        answer: previewText(finalText),
        model,
        toolCalls,
        messages: texts.length,
        kbWrites,
        advice: dedupeAdvice(advice).map((a) => `${a.check}:${a.nodeName}`),
        ...(ctx ? { context: ctx.context.label } : {}),
      },
    });
    const out = saved.map((r) => this.toMessage(r));
    return { conversationId: conv.id, message: out[out.length - 1] as AssistantMessage, messages: out };
  }
}

const textOf = (blocks: LlmBlock[]): string =>
  blocks
    .filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/** Реплика пользователя в конец: к уже стоящей подряд реплике пользователя дописывается блоком, иначе новой. */
function appendUserText(messages: LlmMsg[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

/** Однострочное превью для Журнала: схлопываем пробелы и обрезаем длинный текст. */
function previewText(s: string, max = 600): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function dedupe(list: AssistantCitation[]): AssistantCitation[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.type}:${c.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Один совет на пару «проверка — нода», не больше ASSISTANT_ADVICE_MAX под ответом. */
function dedupeAdvice(list: AssistantAdvice[]): AssistantAdvice[] {
  const seen = new Set<string>();
  return list
    .filter((a) => {
      const k = `${a.check}:${a.nodeUuid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, ASSISTANT_ADVICE_MAX);
}

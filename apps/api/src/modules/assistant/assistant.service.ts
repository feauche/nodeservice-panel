import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AssistantChatResponse,
  type AssistantCitation,
  type AssistantMessage,
  type AssistantProposal,
  type AssistantStatus,
  type ReachabilityResult,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { AssistantMessageRow } from '../../infra/db/schema/index.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { IncidentMetricsService } from '../incidents/incident-metrics.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { ProvidersService } from '../providers/providers.service.js';
import { ServersService } from '../servers/servers.service.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { buildSystem } from './assistant.prompt.js';
import { toolsFor } from './assistant.read-tools.js';
import { AssistantRepository } from './assistant.repository.js';
import { ASSISTANT_TOOLS, runTool, type ToolDeps } from './assistant.tools.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import { ChangesService } from './changes/changes.service.js';
import { FleetProbeService } from './fleet-probe.service.js';
import { extractDefinitions, glossaryImportReply, isPureGlossary } from './glossary-import.js';
import { IncidentAnalysisService } from './incident-analysis.service.js';
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
/** Сколько карточек изменений Джарвис может выдать за один ответ. */
const MAX_CHANGE_CARDS = 3;
/** Сколько раз за ход можно «подтолкнуть» модель, если она ответила пустотой или пообещала вызов без вызова. */
const MAX_NUDGES = 2;
const PROMISE_RE =
  /(?:сейчас|сразу|теперь|далее|щас|давайте)\s+(?:вызову|вызываю|проверю|посмотрю|запрошу|получу|запущу|выясню|уточню)|(?:вызову|вызываю)\s+(?:инструмент|функцию)|нужно\s+(?:было\s+)?вызвать/i;
const NUDGE_PROMISE =
  'Вы написали, что вызовете инструмент, но не вызвали. Вызовите нужный инструмент прямо сейчас, а затем дайте ответ по его результату.';
/** «Добавил», «сохранил статью» без единого вызова инструмента: на деле ничего не записано. */
const CLAIM_RE =
  /(?:добавил|сохранил|создал|записал|добавлен|сохранён|сохранены|создан)[^.\n]{0,80}(?:глоссар|стать|баз[а-я]{1,2} знаний|«?пояснени)|(?:глоссар|стать|«?пояснени)[^.\n]{0,80}(?:добавлен|сохранён|создан)/i;
const NUDGE_CLAIM =
  'Вы написали, что уже добавили или сохранили данные, но ни один инструмент не вызывали: ничего не записано. Вызовите нужный инструмент (add_glossary_terms или save_kb_article) прямо сейчас, а затем сообщите реальный результат по его ответу.';
const CLAIM_WARNING =
  'Внимание: в этом ответе инструменты не вызывались, поэтому в базе знаний ничего не сохранено. Повторите запрос.';
const NUDGE_EMPTY = 'Ответ пустой. Вызовите нужный инструмент или ответьте текстом по уже имеющимся данным.';
const NUDGE_FINAL =
  'Дайте итоговый ответ администратору по уже полученным данным. Инструменты больше недоступны, ничего не обещайте вызвать.';

/** Джарвис: цикл tool-use, предложения действий (human-in-the-loop), беседы в БД. */
@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);

  constructor(
    private readonly settings: AssistantSettingsStore,
    private readonly repo: AssistantRepository,
    private readonly servers: ServersService,
    private readonly incidents: IncidentsService,
    private readonly metrics: VmReaderService,
    private readonly incidentMetrics: IncidentMetricsService,
    private readonly providers: ProvidersService,
    private readonly maintenance: MaintenanceService,
    private readonly probe: FleetProbeService,
    private readonly kb: KnowledgeRepository,
    private readonly knowledge: KnowledgeService,
    private readonly auditRepo: AuditRepository,
    private readonly audit: AuditService,
    private readonly autochecks: AutochecksStore,
    private readonly incidentSettings: IncidentsSettingsStore,
    private readonly analysis: IncidentAnalysisService,
    private readonly changes: ChangesService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
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
      proposals: (row.proposals as AssistantProposal[]) ?? [],
      reachability: (row.reachability as ReachabilityResult[]) ?? [],
      createdAt: row.createdAt.toISOString(),
    };
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

  /** Словарь терминов из режима «Анализ»: ответ без модели, термины уже дописаны в «Пояснения». */
  private async finishGlossaryImport(
    conv: { id: string; title: string },
    message: string,
    model: string,
    found: number,
    res: { id: string; added: number; skipped: string[] },
  ): Promise<AssistantChatResponse> {
    const content = glossaryImportReply(found, res.added, res.skipped);
    const row = await this.repo.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content,
      citations: [{ type: 'kb', id: res.id, label: 'Пояснения' }],
    });
    await this.audit.record({
      action: 'assistant.chat',
      target: { type: 'assistant', id: conv.id, display: conv.title },
      metadata: {
        question: previewText(message),
        answer: previewText(content),
        model,
        glossaryImport: `найдено ${found}, добавлено ${res.added}`,
        toolCalls: 0,
        messages: 1,
        proposals: 0,
      },
    });
    const out = this.toMessage(row);
    return { conversationId: conv.id, message: out, messages: [out] };
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

  async chat(message: string, conversationId: string | undefined): Promise<AssistantChatResponse> {
    const cfg = await this.settings.config();
    if (!cfg)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Джарвис выключен: задай провайдера, ключ и модель в Настройки → Джарвис.',
      });
    const { apiKey, model, level, permissions } = cfg;

    const existing = conversationId ? await this.repo.findConversation(conversationId) : undefined;
    const conv = existing ?? (await this.repo.createConversation(message.slice(0, 60)));
    // Правила парка пишет владелец; ошибка чтения не должна ронять чат.
    const fleetRules = await this.knowledge.fleetRules().catch(() => null);
    const system = buildSystem(level, permissions, { fleetRules });

    await this.repo.addMessage({ conversationId: conv.id, role: 'user', content: message });

    // Строки-определения из присланного текста сервер дописывает в «Пояснения» сам, не полагаясь на модель.
    // Если весь текст словарь, статья не нужна и модель не зовётся; если это инструкция с терминами, модель
    // строит статью из остального и знает, что термины уже добавлены.
    let glossaryLine: string | null = null;
    let glossaryCitation: AssistantCitation | null = null;
    let glossaryHint: string | null = null;
    const defs = extractDefinitions(message);
    if (defs) {
      const res = await this.knowledge.appendGlossary(defs, { auditSource: 'auto' });
      if (isPureGlossary(message)) return this.finishGlossaryImport(conv, message, model, defs.length, res);
      glossaryLine = `Термины из строк-определений: найдено ${defs.length}, добавлено новых в «Пояснения» ${res.added}, уже были ${res.skipped.length}.`;
      glossaryCitation = { type: 'kb', id: res.id, label: 'Пояснения' };
      glossaryHint = `СЕРВЕР УЖЕ ДОБАВИЛ в глоссарий «Пояснения» термины из строк-определений этого текста (найдено ${defs.length}, новых ${res.added}). Не добавляй их повторно и не включай эти определения в статьи. Если это была инструкция, строй статью из остального содержания; другие термины и аббревиатуры, которые есть в тексте не в виде строк-определений, добавь через add_glossary_terms.`;
    }

    // История беседы → сообщения модели (только текст; предыдущий tool-контекст не тащим).
    const prior = await this.repo.messages(conv.id);
    const messages: LlmMsg[] = prior
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text', text: m.content }],
      }));

    if (glossaryHint) appendUserText(messages, glossaryHint);

    let changeCards = 0;
    const deps: ToolDeps = {
      servers: this.servers,
      incidents: this.incidents,
      metrics: this.metrics,
      incidentMetrics: this.incidentMetrics,
      providers: this.providers,
      maintenance: this.maintenance,
      probe: this.probe,
      kb: this.kb,
      audit: this.auditRepo,
      conversations: this.repo,
      conversationId: conv.id,
      autochecks: this.autochecks,
      incidentSettings: this.incidentSettings,
      assistant: { level },
      autoAnalysis: () => this.analysis.autoStatus(),
      permissions,
      changes: {
        propose: async (operation, args, reason) => {
          changeCards += 1;
          if (changeCards > MAX_CHANGE_CARDS)
            return {
              problem: `В одном ответе не больше ${MAX_CHANGE_CARDS} карточек изменений: остальные предложите следующим сообщением.`,
            };
          return this.changes.propose({ operation, args, reason, conversationId: conv.id });
        },
      },
      saveArticle: async (a) => {
        const doc = await this.knowledge.create(
          { title: a.title, content: a.content, tags: a.tags, source: 'ai' },
          { auditSource: 'auto' },
        );
        return { id: doc.id, title: doc.title };
      },
      addGlossary: (terms) => this.knowledge.appendGlossary(terms, { auditSource: 'auto' }),
    };
    const citations: AssistantCitation[] = [];
    const proposals: AssistantProposal[] = [];
    const reachability: ReachabilityResult[] = [];
    /** Реплики по ходу работы («Смотрю данные…»): каждая идёт отдельным сообщением. */
    const interim: string[] = [];
    let answer = '';
    let toolCalls = 0;
    let nudges = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const res = await this.runLlm({
        apiKey,
        model,
        system,
        messages,
        tools: toolsFor(ASSISTANT_TOOLS, permissions),
      });
      const text = textOf(res.blocks);
      const uses = res.blocks.filter(
        (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (uses.length === 0) {
        // Пустой ответ или обещание вызвать инструмент без вызова: один-два толчка вместо «Не удалось сформировать ответ».
        const promised = PROMISE_RE.test(text);
        const claimed = toolCalls === 0 && CLAIM_RE.test(text);
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
          citations.push(...outcome.citations);
          for (const r of outcome.reachability ?? []) {
            const at = reachability.findIndex((x) => x.target.name === r.target.name);
            if (at >= 0) reachability.splice(at, 1);
            reachability.push(r);
          }
          for (const p of outcome.proposals)
            if (!proposals.some((x) => proposalKey(x) === proposalKey(p))) proposals.push(p);
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
    // Модель заявила «сохранил», а инструменты так и не вызвала: честно говорим, что записи нет.
    if (toolCalls === 0 && CLAIM_RE.test(finalText)) finalText = `${finalText}\n\n${CLAIM_WARNING}`;
    if (glossaryLine) finalText = `${finalText}\n\n${glossaryLine}`;
    if (glossaryCitation) citations.push(glossaryCitation);
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
          proposals: last ? proposals : [],
          reachability: last ? reachability : [],
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
        proposals: proposals.length,
      },
    });
    const out = saved.map((r) => this.toMessage(r));
    return { conversationId: conv.id, message: out[out.length - 1] as AssistantMessage, messages: out };
  }
}

const proposalKey = (p: AssistantProposal): string =>
  p.kind === 'autofix' ? `autofix:${p.incidentId}:${p.preset}` : `change:${p.changeId}`;

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

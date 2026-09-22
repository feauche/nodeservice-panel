import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSISTANT_PERMISSION_KEYS,
  ASSISTANT_PERMISSION_LABELS,
  type AssistantChatResponse,
  type AssistantCitation,
  type AssistantLevel,
  type AssistantMessage,
  type AssistantMode,
  type AssistantPermissions,
  type AssistantProposal,
  type AssistantStatus,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { AssistantMessageRow } from '../../infra/db/schema/index.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { ServersService } from '../servers/servers.service.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { AssistantRepository } from './assistant.repository.js';
import { ASSISTANT_TOOLS, runTool, type ToolDeps } from './assistant.tools.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import { LLM_PROVIDER, type LlmBlock, type LlmMsg, type LlmProvider } from './llm.provider.js';

const MAX_TOOL_ROUNDS = 6;

const SYSTEM = `Ты — встроенный помощник панели NodeService: самохостируемой панели управления парком VPN/прокси-серверов (единственный администратор). Ты глубоко знаешь, как устроена сама панель, и знаешь её реальные данные через инструменты.

ПРАВИЛА:
- Отвечай кратко и по делу, на русском, обращайся на «ты».
- Для реальных данных ВСЕГДА зови инструменты (get_fleet_status, get_server_detail, query_metrics, get_settings, search_audit, search_kb). Не выдумывай метрики, адреса, теги, события.
- Если спрашивают «как что-то сделать в панели» — объясни точный путь по интерфейсу (см. карту ниже). Это встроенное знание, инструкции в базе знаний для этого не нужны.
- Действия ты не выполняешь сам — если нужно, зови propose_action, администратор подтвердит.

КАРТА ПАНЕЛИ (навигация слева):
- «Обзор» (/) — здоровье парка, KPI (средний CPU, память, трафик, соединения), «Требует внимания», «Трафик парка», последние события, баннер активных инцидентов.
- «Серверы» (/servers) — сетка карточек. На карточке: кнопка «Проверить связь» (иконка обновления) и меню «⋮» с пунктами: «Изменить», «Установить агента» (пока агента нет), «Дублировать», «Удалить». Сверху: поиск, фильтр «Теги», «Проверить все», «Добавить сервер». Карточки можно перетаскивать за ручку «⠿» (менять порядок). Клик по карточке открывает модалку сервера.
- Модалка сервера — вкладки: «Метрики» (графики CPU/Память/Диск/Сеть/Load average/Conntrack, диапазоны 1 час/24 часа/7 дней), «Журнал» (события этого сервера), «Подключение» (разделы «Общее»: название, теги, заметка; «Доступ по SSH»: IP/домен, порт, пользователь SSH, способ входа — «Не менять/Пароль/Свой ключ/Ключ панели»; «Опасная зона» с удалением; футер: «SSH-терминал», «Дублировать», «Сохранить»). В шапке модалки: «Проверить связь», меню «⋮» (в т.ч. «Установить агента»), крестик.
- УСТАНОВКА АГЕНТА: при добавлении сервера агент ставится автоматически по SSH. Вручную: карточка сервера → «⋮» → «Установить агента» → в диалоге кнопка «Установить по SSH» (панель сама заходит по SSH из релизов GitHub и ставит), либо готовая команда для ручного запуска. После установки статус станет «Агент в сети».
- ВЕБ-ТЕРМИНАЛ: модалка сервера → вкладка «Подключение» → кнопка «SSH-терминал» (плавающее окно xterm, можно двигать/растягивать/на весь экран).
- «Инциденты» (/incidents) — список (фильтр Все/Открытые/Решённые), раскрытие карточки показывает таймлайн и блок «Автопочинка» с пресетами («Перезапустить Xray», «Перезапустить контейнер ноды», «Освободить диск») кнопкой «Применить» (за подтверждением паролем), «Взять в работу», «Закрыть вручную».
- «Настройки» (/settings) — вкладки: «Внешний вид» (логотип, имя бренда), «Безопасность» (смена пароля, 2FA и коды восстановления, таймаут сессии по бездействию, автоблокировка экрана, «всегда спрашивать код 2FA», активные сессии и устройства), «Автопроверки» (тумблеры и интервалы: серверы без агента, серверы с агентом, «агент не в сети», метрики агента), «Инциденты» (пороги CPU/памяти/диска, «время реакции», автопочинка, кулдаун), «Ассистент» (провайдер zveno.ai, название модели, ключ).
- «Журнал» (/audit) — все события панели, фильтры (категория/результат/период/поиск), экспорт CSV/JSON, кнопка «Скопировать» отчёт по записи.
- «Ассистент» (/assistant) — это ты. «База знаний» (/knowledge) — markdown-статьи (runbooks) с поиском и редактором.
- Вход/безопасность: 6 часов жизни сессии, блокировка экрана по бездействию (разблокировка паролем), step-up (подтверждение паролем) на чувствительные действия.

Пиши пути через интерфейс человеку понятно: «Серверы → карточка → ⋮ → Установить агента → Установить по SSH».`;

const ANSWER_STYLE = `ОФОРМЛЕНИЕ ОТВЕТОВ:
- Пиши в Markdown: заголовки, **жирный**, списки, блоки кода с языком (\`\`\`bash, \`\`\`json), таблицы — где это делает ответ понятнее и красивее.
- На вопрос «как что-то сделать» давай ПОДРОБНУЮ пошаговую инструкцию (нумерованный список): что именно нажать, а где полезно — как это работает и зачем. Не отвечай сухим «Настройки → Безопасность» без деталей.
- Ссылайся на статьи базы знаний по теме: используй search_kb и упоминай найденную статью (она станет цитатой под ответом).`;

const KB_RULES = `БАЗА ЗНАНИЙ И ГЛОССАРИЙ:
- ПЕРЕД созданием статьи обязательно сделай search_kb. Если такая статья уже есть — не создавай дубликат: дополни существующую или просто сошлись на неё.
- ГЛОССАРИЙ (важно, базовое поведение): всякий раз, когда объясняешь термин или аббревиатуру — даже базовые (SSH, CPU, conntrack) — добавляй их в общий глоссарий «Пояснения» инструментом add_glossary_terms. Делай это ВСЕГДА, в любом режиме, попутно с ответом. Дубликаты инструмент отсекает сам. Отдельную статью на один термин НЕ создавай — термины идут только в глоссарий.
- save_kb_article — для полноценных инструкций/руководств, а не для одной строчки.`;

/** Инструкция под уровень пользователя — подробность и терминология. */
function levelRule(level: AssistantLevel): string {
  if (level === 'novice')
    return 'УРОВЕНЬ — НОВИЧОК: объясняй максимально подробно и простыми словами. Любую аббревиатуру и технический термин (даже SSH, CPU, conntrack) коротко расшифровывай при первом упоминании. Не пропускай очевидные для тебя шаги.';
  if (level === 'pro')
    return 'УРОВЕНЬ — ПРОФЕССИОНАЛ: пиши кратко и плотно, можно терминами и аббревиатурами без расшифровки. Не разжёвывай базовое и не повторяй очевидное.';
  return 'УРОВЕНЬ — СРЕДНИЙ: по делу, но поясняй неочевидные термины и шаги. Баланс между подробностью и краткостью.';
}

const ANALYSIS_TASK = `РЕЖИМ «АНАЛИЗ»: пользователь прислал текст или скопированную страницу на разбор. Твоя задача — собрать из него аккуратную статью-инструкцию (или несколько) для базы знаний, НИЧЕГО полезного не потеряв:
- СОХРАНИ ВСЁ содержательное из присланного. Не выкидывай разделы, шаги, команды, таблицы и темы. Выбрасывать можно только воду, рекламу, навигацию сайта и артефакты вёрстки — но не полезные разделы.
- Если в тексте НЕСКОЛЬКО разных тем/инструкций (например «как выбрать SNI-донор» и «self-steal на nginx») — не сваливай их в одну статью и НЕ бросай часть. Сделай ОТДЕЛЬНУЮ статью на каждую самостоятельную тему: вызови save_kb_article несколько раз, по разу на тему.
- Каждая статья: заголовок, короткое «что это», затем суть ПО ШАГАМ (нумерованный список), простыми словами и подробно — по уровню пользователя.
- Оформи красиво в Markdown: списки, блоки кода с языком, таблицы. Сохрани полезную разметку из исходника или добавь свою.
- Сохрани готовые статьи инструментом save_kb_article (метка AI ставится сама). В ответе перечисли, какие статьи собрал, и явно скажи, если какую-то тему из текста НЕ включил и почему.
- Если создание статей запрещено — не сохраняй, а верни готовый текст статьи прямо в ответе и скажи, что сохранить не можешь (нет разрешения).`;

/** Полный системный промпт с учётом уровня, разрешений и режима работы. */
function buildSystem(level: AssistantLevel, permissions: AssistantPermissions, mode: AssistantMode): string {
  const perms = ASSISTANT_PERMISSION_KEYS.map(
    (k) => `${ASSISTANT_PERMISSION_LABELS[k]} — ${permissions[k] ? 'разрешено' : 'запрещено'}`,
  ).join('; ');
  const modeBlock = mode === 'analysis' ? `\n\n${ANALYSIS_TASK}` : '';
  const now = new Date().toISOString();
  return `ТЕКУЩЕЕ ВРЕМЯ СЕРВЕРА (UTC): ${now}. Отвечая про периоды («за час», «за сутки», «сегодня»), опирайся на него и зови search_audit с sinceMinutes (час = 60).

${SYSTEM}

${ANSWER_STYLE}

${KB_RULES}

${levelRule(level)}

РАЗРЕШЕНИЯ (сейчас): ${perms}. Свои разрешения смотри через get_settings. Настройки ты только читаешь — менять их не можешь. Если просят действие, на которое нет разрешения, честно скажи об этом и подскажи, что включается это в «Настройки → Ассистент → Разрешения».${modeBlock}`;
}

/** AI-ассистент: цикл tool-use, предложения действий (human-in-the-loop), беседы в БД. */
@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);

  constructor(
    private readonly settings: AssistantSettingsStore,
    private readonly repo: AssistantRepository,
    private readonly servers: ServersService,
    private readonly incidents: IncidentsService,
    private readonly metrics: VmReaderService,
    private readonly kb: KnowledgeRepository,
    private readonly knowledge: KnowledgeService,
    private readonly auditRepo: AuditRepository,
    private readonly audit: AuditService,
    private readonly autochecks: AutochecksStore,
    private readonly incidentSettings: IncidentsSettingsStore,
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
      createdAt: row.createdAt.toISOString(),
    };
  }

  async conversations() {
    const rows = await this.repo.listConversations();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      mode: r.mode,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async history(conversationId: string) {
    const conv = await this.repo.findConversation(conversationId);
    if (!conv) throw problem(HttpStatus.NOT_FOUND, { detail: 'Беседа не найдена.' });
    return (await this.repo.messages(conversationId)).map((r) => this.toMessage(r));
  }

  async chat(
    message: string,
    conversationId: string | undefined,
    mode: AssistantMode = 'agent',
  ): Promise<AssistantChatResponse> {
    const cfg = await this.settings.config();
    if (!cfg)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'AI-ассистент выключен: задай провайдера, ключ и модель в Настройки → Ассистент.',
      });
    const { apiKey, model, level, permissions } = cfg;

    // Режим закреплён за беседой: в существующем чате нельзя переключить агента на анализ.
    const existing = conversationId ? await this.repo.findConversation(conversationId) : undefined;
    const conv = existing ?? (await this.repo.createConversation(message.slice(0, 60), mode));
    const effectiveMode: AssistantMode = existing ? (conv.mode as AssistantMode) : mode;
    const system = buildSystem(level, permissions, effectiveMode);

    await this.repo.addMessage({ conversationId: conv.id, role: 'user', content: message });

    // История беседы → сообщения модели (только текст; предыдущий tool-контекст не тащим).
    const prior = await this.repo.messages(conv.id);
    const messages: LlmMsg[] = prior
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text', text: m.content }],
      }));

    const deps: ToolDeps = {
      servers: this.servers,
      incidents: this.incidents,
      metrics: this.metrics,
      kb: this.kb,
      audit: this.auditRepo,
      autochecks: this.autochecks,
      incidentSettings: this.incidentSettings,
      assistant: { level, permissions },
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
    let answer = '';
    let toolCalls = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const res = await this.llm.run({ apiKey, model, system, messages, tools: ASSISTANT_TOOLS });
      answer = res.blocks
        .filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const uses = res.blocks.filter(
        (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (res.stopReason !== 'tool_use' || uses.length === 0) break;

      messages.push({ role: 'assistant', content: res.blocks });
      const results: LlmBlock[] = [];
      for (const use of uses) {
        toolCalls += 1;
        try {
          const outcome = await runTool(use.name, use.input, deps);
          citations.push(...outcome.citations);
          proposals.push(...outcome.proposals);
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

    const finalAnswer = answer || 'Не удалось сформировать ответ.';
    const saved = await this.repo.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: finalAnswer,
      citations: dedupe(citations),
      proposals,
    });
    await this.audit.record({
      action: 'assistant.chat',
      target: { type: 'assistant', id: conv.id, display: conv.title },
      // Вопрос и превью ответа — прямо в записи Журнала, чтобы её было видно без открытия беседы.
      metadata: {
        question: previewText(message),
        answer: previewText(finalAnswer),
        model,
        mode: effectiveMode,
        toolCalls,
        proposals: proposals.length,
      },
    });
    return { conversationId: conv.id, message: this.toMessage(saved) };
  }
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

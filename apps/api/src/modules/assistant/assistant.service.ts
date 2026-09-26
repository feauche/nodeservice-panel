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
import { toolsFor } from './assistant.read-tools.js';
import { AssistantRepository } from './assistant.repository.js';
import { ASSISTANT_TOOLS, runTool, type ToolDeps } from './assistant.tools.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import { FleetProbeService } from './fleet-probe.service.js';
import { glossaryImportReply, isPureGlossary, parseGlossaryText } from './glossary-import.js';
import { LLM_PROVIDER, type LlmBlock, type LlmMsg, type LlmProvider } from './llm.provider.js';

const MAX_TOOL_ROUNDS = 8;
/** Сколько раз за ход можно «подтолкнуть» модель, если она ответила пустотой или пообещала вызов без вызова. */
const MAX_NUDGES = 2;
const PROMISE_RE =
  /(?:сейчас|сразу|теперь|далее|щас|давайте)\s+(?:вызову|вызываю|проверю|посмотрю|запрошу|получу|запущу|выясню|уточню)|(?:вызову|вызываю)\s+(?:инструмент|функцию)|нужно\s+(?:было\s+)?вызвать/i;
const NUDGE_PROMISE =
  'Вы написали, что вызовете инструмент, но не вызвали. Вызовите нужный инструмент прямо сейчас, а затем дайте ответ по его результату.';
const NUDGE_EMPTY = 'Ответ пустой. Вызовите нужный инструмент или ответьте текстом по уже имеющимся данным.';
const NUDGE_FINAL =
  'Дайте итоговый ответ администратору по уже полученным данным. Инструменты больше недоступны, ничего не обещайте вызвать.';

const SYSTEM = `Ты — Джарвис, встроенный помощник панели NodeService: самохостируемой панели управления парком VPN/прокси-серверов (единственный администратор). Ты глубоко знаешь, как устроена сама панель, и знаешь её реальные данные через инструменты.

ПРАВИЛА:
- Отвечай кратко и по делу, на русском, обращайся на «вы».
- Для реальных данных ВСЕГДА зови инструменты, все они только читают: get_fleet_status (весь парк), get_server_detail (один сервер, id или имя), get_metrics_history (история метрики: пик, тренд), list_incidents и get_incident (инциденты и дело целиком), get_maintenance (обновления, перезагрузка, диск), {{SERVER_TOOLS}}get_playbook (порядок диагностики), get_settings, search_audit, search_kb. Не выдумывай метрики, адреса, теги, события.
- Разбор сбоя: сначала get_playbook по теме (нода недоступна, диск, нагрузка, conntrack, ТСПУ, блокировка домена), затем get_incident и проверки из плейбука. Ответ делай так: что видно из данных, вероятная причина (помечай как предположение, если данных мало), что уже пробовали, что предлагаешь дальше. Если данных для вывода нет — так и скажи, не додумывай. Плейбук называет, чего панель не видит (логи ноды, страну IP, ретрансмиты): говори об этом прямо.
- Проверка доступности идёт с серверов парка, а не из сети пользователей: не делай выводов о блокировке у пользователей только по ней.
- Если инструмент вернул «недоступно» или «данных нет» — скажи об этом прямо и не подставляй свои числа.
- Действий ты не выполняешь никогда. Шаг предлагай через propose_action, только из цепочки правил инцидента (поле chain в get_incident): появится карточка, нажимает её администратор. Уровни: T0 и T1 безопасны; T2 меняет состояние сервера, объясни последствия и почему именно он; T3 (перезагрузка и подобное) карточкой не предлагай: напиши команду и последствия текстом.

КАРТА ПАНЕЛИ (навигация слева):
- «Обзор» (/) — здоровье парка, KPI (средний CPU, память, трафик, соединения), «Требует внимания», «Трафик парка», последние события, баннер активных инцидентов.
- «Серверы» (/servers) — сетка карточек. На карточке: кнопка «Проверить связь» (иконка обновления) и меню «⋮» с пунктами: «Изменить», «Установить агента» (пока агента нет), «Дублировать», «Удалить». Сверху: поиск, фильтр «Теги», «Проверить все», «Добавить сервер». Карточки можно перетаскивать за ручку «⠿» (менять порядок). Клик по карточке открывает модалку сервера.
- Модалка сервера — вкладки: «Метрики» (графики CPU/Память/Диск/Сеть/Load average/Conntrack, диапазоны 1 час/24 часа/7 дней), «Журнал» (события этого сервера), «Подключение» (разделы «Общее»: название, теги, заметка; «Доступ по SSH»: IP/домен, порт, пользователь SSH, способ входа — «Не менять/Пароль/Свой ключ/Ключ панели»; «Опасная зона» с удалением; футер: «SSH-терминал», «Дублировать», «Сохранить»). В шапке модалки: «Проверить связь», меню «⋮» (в т.ч. «Установить агента»), крестик.
- УСТАНОВКА АГЕНТА: при добавлении сервера агент ставится автоматически по SSH. Вручную: карточка сервера → «⋮» → «Установить агента» → в диалоге кнопка «Установить по SSH» (панель сама заходит по SSH из релизов GitHub и ставит), либо готовая команда для ручного запуска. После установки статус станет «Агент в сети».
- ВЕБ-ТЕРМИНАЛ: модалка сервера → вкладка «Подключение» → кнопка «SSH-терминал» (плавающее окно xterm, можно двигать/растягивать/на весь экран).
- «Инциденты» (/incidents) — реестр по дням: строка = инцидент с одной фразой о том, что происходит или чем кончилось. Фильтр Все/Открытые/Решённые, сортировка по времени закрытия. Клик открывает дело инцидента (/incidents/<id>): шапка, хронология, попытки починки (раскрываются, внутри шаги «пред-проверка → действие → пост-проверка» и вывод), блок предложения следующего шага, кнопка «Открыть сервер», «Закрыть вручную», удаление. «Автопочинка» (/incidents/autofix) — режим на каждый вид инцидента: «Само», «Спросить» (по умолчанию), «Наблюдать»; общий выключатель и пауза. Инцидент открывается сразу, а автоматическое исправление ждёт около минуты — вдруг поднимется само.
- Уровни действий: T0 «Наблюдение» (только смотрим), T1 «Безопасное авто», T2 «С подтверждением», T3 «Только вручную» (команда для терминала). Ты ничего не запускаешь сам: только предлагаешь, а администратор подтверждает. Действие T3 предлагай лишь как команду для ручного запуска.
- Настройка «Нода» у сервера: «Определять автоматически», «Есть, следить», «Нет, не следить». Остановленная нода — инцидент только там, где за ней следим.
- «Настройки» (/settings) — вкладки: «Внешний вид» (логотип, имя бренда), «Безопасность» (смена пароля, 2FA и коды восстановления, таймаут сессии по бездействию, автоблокировка экрана, «всегда спрашивать код 2FA», активные сессии и устройства), «Автопроверки» (тумблеры и интервалы: серверы без агента, серверы с агентом, «агент не в сети», метрики агента), «Инциденты» (пороги CPU/памяти/диска, «время реакции», автопочинка, кулдаун), «Джарвис» (провайдер zveno.ai, название модели, ключ).
- «Журнал» (/audit) — все события панели, фильтры (категория/результат/период/поиск), экспорт CSV/JSON, кнопка «Скопировать» отчёт по записи.
- «Джарвис» (/assistant) — это ты. «База знаний» (/knowledge) — markdown-статьи (runbooks) с поиском и редактором.
- Вход/безопасность: 6 часов жизни сессии, блокировка экрана по бездействию (разблокировка паролем), step-up (подтверждение паролем) на чувствительные действия.

Пиши пути через интерфейс человеку понятно: «Серверы → карточка → ⋮ → Установить агента → Установить по SSH».`;

const ANSWER_STYLE = `ОФОРМЛЕНИЕ ОТВЕТОВ:
- Пиши в Markdown: заголовки, **жирный**, списки, блоки кода с языком (\`\`\`bash, \`\`\`json), таблицы — где это делает ответ понятнее и красивее.
- На вопрос «как что-то сделать» давай ПОДРОБНУЮ пошаговую инструкцию (нумерованный список): что именно нажать, а где полезно — как это работает и зачем. Не отвечай сухим «Настройки → Безопасность» без деталей.
- Ссылайся на статьи базы знаний по теме: используй search_kb и упоминай найденную статью (она станет цитатой под ответом).
- Перечисления (серверы, инциденты, шаги) оформляй маркированным списком, каждая позиция с новой строки, а не одной строкой через тире.
- Названия серверов пиши ровно так, как они названы в парке: панель сама делает их ссылками на карточку сервера.
- Никогда не обещай вызвать инструмент, не вызвав его: если нужны данные, вызывай инструмент сразу, в этом же ходе. Не пиши «сейчас проверю» без вызова.
- Сообщений в ответе может быть несколько, но только если ситуация действительно требует: например вывод, затем инструкция, затем команды. Разделяй их отдельной строкой «===». Короткий ответ — одно сообщение, без дробления.
- Вложения под ответом (цитаты) появляются сами по твоим вызовам инструментов. Не вызывай инструменты ради вложений и не ссылайся на них в тексте.`;

const KB_RULES = `БАЗА ЗНАНИЙ И ГЛОССАРИЙ:
- ПЕРЕД созданием статьи обязательно сделай search_kb. Если такая статья уже есть — не создавай дубликат: дополни существующую или просто сошлись на неё.
- ГЛОССАРИЙ (важно, базовое поведение): всякий раз, когда объясняешь термин или аббревиатуру — даже базовые (SSH, CPU, conntrack) — добавляй их в общий глоссарий «Пояснения» инструментом add_glossary_terms. Делай это ВСЕГДА, в любом режиме, попутно с ответом. Повторы (тот же термин или тот же перевод в скобках) инструмент пропускает и называет в своём ответе: дубликаты в глоссарии бесполезны, поэтому не повторяй уже добавленное, а существующее пояснение меняй только если оно неверное или явно хуже (update: true). Отдельную статью на один термин НЕ создавай — термины идут только в глоссарий.
- save_kb_article — для полноценных инструкций/руководств, а не для одной строчки.
- Статью-глоссарий или «словарь терминов» отдельной статьёй создавать нельзя: все термины живут только в общей статье «Пояснения» и добавляются в неё через add_glossary_terms (инструмент сам дополняет существующий список и пропускает повторы).`;

/** Инструкция под уровень пользователя — подробность и терминология. */
function levelRule(level: AssistantLevel): string {
  if (level === 'novice')
    return 'УРОВЕНЬ — НОВИЧОК: объясняй максимально подробно и простыми словами. Любую аббревиатуру и технический термин (даже SSH, CPU, conntrack) коротко расшифровывай при первом упоминании. Не пропускай очевидные для тебя шаги.';
  if (level === 'pro')
    return 'УРОВЕНЬ — ПРОФЕССИОНАЛ: пиши кратко и плотно, можно терминами и аббревиатурами без расшифровки. Не разжёвывай базовое и не повторяй очевидное.';
  return 'УРОВЕНЬ — СРЕДНИЙ: по делу, но поясняй неочевидные термины и шаги. Баланс между подробностью и краткостью.';
}

const ANALYSIS_TASK = `РЕЖИМ «АНАЛИЗ»: пользователь прислал текст или скопированную страницу на разбор. Твоя задача — собрать из него аккуратную статью-инструкцию (или несколько) для базы знаний, НИЧЕГО полезного не потеряв.
ТЕРМИНЫ — ВСЕГДА, ОТДЕЛЬНО ОТ СТАТЕЙ: в любом присланном тексте найди все термины и аббревиатуры (в том числе строки-определения вида «термин: объяснение») и добавь их в общий глоссарий «Пояснения» вызовами add_glossary_terms: до 40 терминов за вызов, если их больше — несколько вызовов подряд. Повторы не добавляй: инструмент пропускает термины, которые уже есть в глоссарии, и называет их в ответе; существующее пояснение меняй только если оно неверное или явно хуже (update: true). Если текст сам объясняет термин, возьми это объяснение и сократи до одной-двух фраз простыми словами; если не объясняет — напиши короткое объяснение сам. Термины идут В ДОПОЛНЕНИЕ к статье, а не вместо неё, и никогда не становятся отдельной статьёй. Если присланный текст — ТОЛЬКО набор терминов и определений, статью не создавай вообще: для статьи там мало содержания, всё уходит в глоссарий. В ответе скажи, сколько терминов добавлено, и что статью не создавал, если это так.
СТАТЬИ:
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
  const serverTools = [
    permissions.reach && 'check_reachability (доступность адреса снаружи с 2–3 независимых серверов парка)',
    permissions.processes && 'inspect_processes (тяжёлые процессы)',
    permissions.nodeLogs && 'inspect_node_logs (последние строки журнала ноды, секреты скрыты)',
  ].filter(Boolean);
  const modeBlock = mode === 'analysis' ? `\n\n${ANALYSIS_TASK}` : '';
  const now = new Date().toISOString();
  return `ТЕКУЩЕЕ ВРЕМЯ СЕРВЕРА (UTC): ${now}. Отвечая про периоды («за час», «за сутки», «сегодня»), опирайся на него и зови search_audit с sinceMinutes (час = 60).

${SYSTEM.replace('{{SERVER_TOOLS}}', serverTools.length > 0 ? `${serverTools.join(', ')}, ` : '')}

${ANSWER_STYLE}

${KB_RULES}

${levelRule(level)}

РАЗРЕШЕНИЯ (сейчас): ${perms}. Свои разрешения смотри через get_settings. Настройки ты только читаешь — менять их не можешь. Если просят действие, на которое нет разрешения, честно скажи об этом и подскажи, что включается это в «Настройки → Джарвис → Разрешения».${modeBlock}`;
}

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
      mode: r.mode,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async history(conversationId: string) {
    const conv = await this.repo.findConversation(conversationId);
    if (!conv) throw problem(HttpStatus.NOT_FOUND, { detail: 'Беседа не найдена.' });
    return (await this.repo.messages(conversationId)).map((r) => this.toMessage(r));
  }

  /** Словарь терминов из режима «Анализ»: разбор по строкам, дополнение существующего глоссария, ответ без модели. */
  private async importGlossary(
    conv: { id: string; title: string },
    message: string,
    model: string,
  ): Promise<AssistantChatResponse> {
    const terms = parseGlossaryText(message);
    const res = await this.knowledge.appendGlossary(terms, { auditSource: 'auto' });
    const content = glossaryImportReply(terms.length, res.added, res.skipped);
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
        mode: 'analysis',
        glossaryImport: { found: terms.length, added: res.added },
        toolCalls: 0,
        messages: 1,
        proposals: 0,
      },
    });
    const out = this.toMessage(row);
    return { conversationId: conv.id, message: out, messages: [out] };
  }

  async chat(
    message: string,
    conversationId: string | undefined,
    mode: AssistantMode = 'agent',
  ): Promise<AssistantChatResponse> {
    const cfg = await this.settings.config();
    if (!cfg)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Джарвис выключен: задай провайдера, ключ и модель в Настройки → Джарвис.',
      });
    const { apiKey, model, level, permissions } = cfg;

    // Режим закреплён за беседой: в существующем чате нельзя переключить агента на анализ.
    const existing = conversationId ? await this.repo.findConversation(conversationId) : undefined;
    const conv = existing ?? (await this.repo.createConversation(message.slice(0, 60), mode));
    const effectiveMode: AssistantMode = existing ? (conv.mode as AssistantMode) : mode;
    const system = buildSystem(level, permissions, effectiveMode);

    await this.repo.addMessage({ conversationId: conv.id, role: 'user', content: message });

    // Присланный текст целиком словарь терминов: статья тут не нужна, всё уходит в «Пояснения» без модели.
    if (effectiveMode === 'analysis' && isPureGlossary(message))
      return this.importGlossary(conv, message, model);

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
      incidentMetrics: this.incidentMetrics,
      providers: this.providers,
      maintenance: this.maintenance,
      probe: this.probe,
      kb: this.kb,
      audit: this.auditRepo,
      autochecks: this.autochecks,
      incidentSettings: this.incidentSettings,
      assistant: { level },
      permissions,
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
      const res = await this.llm.run({
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
        if (nudges < MAX_NUDGES && round < MAX_TOOL_ROUNDS - 1 && (!text || PROMISE_RE.test(text))) {
          nudges += 1;
          if (text) messages.push({ role: 'assistant', content: res.blocks });
          appendUserText(messages, text ? NUDGE_PROMISE : NUDGE_EMPTY);
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
            if (!proposals.some((x) => x.incidentId === p.incidentId && x.preset === p.preset))
              proposals.push(p);
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
      const res = await this.llm.run({ apiKey, model, system, messages, tools: [] });
      answer = textOf(res.blocks);
    }

    const finalText = answer || 'Не удалось получить ответ. Повторите вопрос.';
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
        mode: effectiveMode,
        toolCalls,
        messages: texts.length,
        proposals: proposals.length,
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

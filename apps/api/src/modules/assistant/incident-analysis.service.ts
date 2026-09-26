import { HttpException, HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ANALYSIS_THREAD_MAX,
  AUTOFIX_GRACE_SECONDS,
  INCIDENT_CHART_METRIC,
  type Incident,
  type IncidentAnalysis,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { AuditService } from '../audit/audit.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { playbookForKind, renderPlaybook } from './assistant.playbooks.js';
import { incidentCase, type ReadDeps, runReadTool, toolsFor } from './assistant.read-tools.js';
import { ReadDepsService } from './assistant-read-deps.service.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import {
  ANALYSIS_TOOLS,
  ASK_TOOLS,
  AUTO_ANALYSIS_PER_HOUR,
  analysisSystem,
  askSystem,
  chartName,
  dataBlock,
  parseSubmission,
  pickAutoAnalysis,
  type Submission,
  stepLabel,
} from './incident-analysis.logic.js';
import { LLM_PROVIDER, type LlmBlock, type LlmMsg, type LlmProvider } from './llm.provider.js';

const MAX_ROUNDS = 6;
const ASK_ROUNDS = 4;
/** Весь разбор не дольше этого: зависший провайдер не должен держать «идёт разбор» бесконечно. */
const TOTAL_MS = 150_000;
const ANSWER_MAX = 1_800;

const now = () => new Date().toISOString();
const text = (t: string): LlmBlock[] => [{ type: 'text', text: t }];

/** Ошибка с текстом, который можно показать администратору как есть. */
class AnalysisError extends Error {}
/** Инцидент удалили, пока шёл разбор: писать некуда. */
class Gone extends Error {}

/** Что показать администратору вместо технической ошибки провайдера. */
function explain(err: unknown): string {
  if (err instanceof AnalysisError) return err.message;
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/Timeout|Abort/i.test(m)) return 'Провайдер не ответил за 60 секунд. Повторите разбор.';
  if (/ответил (401|403)/.test(m)) return 'Провайдер отклонил ключ. Проверьте ключ в «Настройки → Джарвис».';
  if (/ответил 429/.test(m)) return 'Провайдер ограничил число запросов. Повторите позже.';
  return 'Не удалось получить ответ Джарвиса. Повторите разбор.';
}

/**
 * Разбор инцидента Джарвисом (R4.2). Работает в фоне: вывод, доказательства и шаг пишутся прямо в
 * инцидент, ход работы виден по мере выполнения. Джарвис только читает; шаг из цепочки правил
 * запускает администратор.
 */
@Injectable()
export class IncidentAnalysisService implements OnModuleInit {
  private readonly log = new Logger(IncidentAnalysisService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly settings: AssistantSettingsStore,
    private readonly incidents: IncidentsService,
    private readonly readDepsService: ReadDepsService,
    private readonly audit: AuditService,
    private readonly knowledge: KnowledgeService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    const n = await this.incidents.failRunningAnalyses(
      'Разбор прерван перезапуском панели. Запустите его заново.',
    );
    if (n > 0) this.log.warn(`Оборванных разборов после старта: ${n}`);
  }

  private readDeps(cfg: NonNullable<Awaited<ReturnType<AssistantSettingsStore['config']>>>): ReadDeps {
    return this.readDepsService.get(cfg.permissions);
  }

  /** Когда запускали разборы сами: почасовой лимит считаем по этим меткам. */
  private readonly autoStarts: number[] = [];
  private lastAutoRunAt: number | null = null;

  /** Состояние автоматического разбора для настроек и Джарвиса; данные с момента запуска панели. */
  autoStatus(): { lastRunAt: string | null; startedLastHour: number; limitPerHour: number } {
    const nowMs = Date.now();
    return {
      lastRunAt: this.lastAutoRunAt ? new Date(this.lastAutoRunAt).toISOString() : null,
      startedLastHour: this.autoStarts.filter((t) => nowMs - t <= 3_600_000).length,
      limitPerHour: AUTO_ANALYSIS_PER_HOUR,
    };
  }

  /** Раз в минуту: при включённом «Автоматическом разборе» берёт свежие открытые инциденты без разбора. */
  @Interval(60_000)
  async autoTick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.autoRun();
    } catch (err) {
      this.log.warn(`Автоматический разбор не удался: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Один проход автоматического разбора; вернёт id запущенных. Вынесено из таймера ради тестов. */
  async autoRun(): Promise<string[]> {
    const cfg = await this.settings.config();
    if (!cfg?.permissions.analysis || !cfg.permissions.autoAnalysis) return [];
    const nowMs = Date.now();
    while (this.autoStarts.length > 0 && nowMs - (this.autoStarts[0] as number) > 3_600_000)
      this.autoStarts.shift();
    const { items } = await this.incidents.list('open');
    const ids = pickAutoAnalysis(
      items.filter((i) => !this.running.has(i.id)),
      nowMs,
      this.autoStarts.length,
      AUTOFIX_GRACE_SECONDS * 1000,
    );
    const started: string[] = [];
    for (const id of ids) {
      try {
        await this.start(id, 'auto');
        this.autoStarts.push(Date.now());
        this.lastAutoRunAt = Date.now();
        started.push(id);
      } catch (err) {
        this.log.warn(
          `Автоматический разбор ${id} не запущен: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return started;
  }

  private async config() {
    const cfg = await this.settings.config();
    if (!cfg)
      throw problem(HttpStatus.CONFLICT, {
        detail: 'Джарвис выключен: задайте провайдера, ключ и модель в «Настройки → Джарвис».',
      });
    return cfg;
  }

  /** Запустить разбор: возвращает инцидент со статусом «идёт», дальше работа идёт в фоне. */
  async start(id: string, by: 'manual' | 'auto' = 'manual'): Promise<Incident> {
    const cfg = await this.config();
    if (!cfg.permissions.analysis)
      throw problem(HttpStatus.CONFLICT, {
        detail:
          'Разбор инцидентов выключен: включите «Разбор по кнопке» в «Настройки → Джарвис → Разрешения».',
      });
    const inc = await this.incidents.get(id);
    if (this.running.has(id)) throw problem(HttpStatus.CONFLICT, { detail: 'Разбор уже идёт.' });
    this.running.add(id);
    try {
      const base: IncidentAnalysis = {
        status: 'running',
        startedAt: now(),
        finishedAt: null,
        steps: ['Читаю снимок сигналов и хронологию'],
        verdict: null,
        confidence: null,
        evidence: [],
        unknown: null,
        nextAction: null,
        basedOn: { attempts: inc.attempts.length, resolved: inc.status === 'resolved' },
        model: cfg.model,
        error: null,
        thread: [],
      };
      await this.incidents.saveAnalysis(id, base);
      await this.audit.record({
        action: 'incident.analysis.run',
        target: { type: 'incident', id, display: inc.title },
        metadata: { kind: inc.kind, server: inc.serverName, model: cfg.model, by },
      });
      void this.execute(id, inc, cfg, base).finally(() => this.running.delete(id));
      return await this.incidents.get(id);
    } catch (err) {
      this.running.delete(id);
      throw err;
    }
  }

  private async execute(
    id: string,
    inc: Incident,
    cfg: NonNullable<Awaited<ReturnType<AssistantSettingsStore['config']>>>,
    base: IncidentAnalysis,
  ): Promise<void> {
    const steps = [...base.steps];
    let cur = base;
    const save = async (next: IncidentAnalysis) => {
      cur = next;
      if (!(await this.incidents.saveAnalysis(id, next))) throw new Gone();
    };
    const step = async (label: string) => {
      if (steps.at(-1) === label) return;
      steps.push(label);
      await save({ ...cur, steps: [...steps] });
    };
    const deadline = Date.now() + TOTAL_MS;
    try {
      const deps = this.readDeps(cfg);
      const fleetRules = await this.knowledge.fleetRules().catch(() => null);
      const book = playbookForKind(inc.kind);
      const playbook = book ? renderPlaybook(book) : null;
      let metricText: string | null = null;
      const metric = INCIDENT_CHART_METRIC[inc.kind];
      if (metric && inc.serverId) {
        await step(`Смотрю историю: ${chartName(metric)}`);
        const fresh = Date.now() - Date.parse(inc.openedAt) < 40 * 60_000;
        const out = await runReadTool(
          'get_metrics_history',
          { serverId: inc.serverId, metric, range: fresh ? '1h' : '24h' },
          deps,
        );
        metricText = out?.content ?? null;
      }
      const messages: LlmMsg[] = [
        { role: 'user', content: text(`${dataBlock(incidentCase(inc), metricText)}\n\nСделайте разбор.`) },
      ];
      let submission: Submission | null = null;
      let reach: IncidentAnalysis['reachability'] = null;
      let nudged = false;
      for (let round = 0; round < MAX_ROUNDS && !submission; round += 1) {
        if (Date.now() > deadline) throw new AnalysisError('Разбор занял слишком много времени. Повторите.');
        const res = await this.llm.run({
          apiKey: cfg.apiKey,
          model: cfg.model,
          system: analysisSystem(cfg.level, playbook, fleetRules),
          messages,
          tools: toolsFor(ANALYSIS_TOOLS, cfg.permissions),
        });
        const uses = res.blocks.filter(
          (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
        );
        if (uses.length === 0) {
          if (nudged) break;
          nudged = true;
          messages.push(
            { role: 'assistant', content: res.blocks.length ? res.blocks : text('Понял.') },
            { role: 'user', content: text('Сдайте разбор вызовом submit_analysis.') },
          );
          continue;
        }
        messages.push({ role: 'assistant', content: res.blocks });
        const results: LlmBlock[] = [];
        for (const use of uses) {
          await step(stepLabel(use.name, use.input, inc.kind));
          let content: string;
          if (use.name === 'submit_analysis') {
            const parsed = parseSubmission(use.input, inc.kind);
            if (parsed.ok) submission = parsed.value;
            content = parsed.ok ? 'Разбор принят.' : parsed.error;
          } else if (ANALYSIS_TOOLS.some((t) => t.name === use.name)) {
            try {
              const out = await runReadTool(use.name, (use.input ?? {}) as Record<string, unknown>, deps);
              content = out?.content ?? 'Нет данных.';
              if (out?.reachability?.[0]) reach = out.reachability[0];
            } catch (err) {
              this.log.warn(
                `Инструмент «${use.name}» в разборе: ${err instanceof Error ? err.message : err}`,
              );
              content = 'Инструмент временно недоступен.';
            }
          } else content = 'Этот инструмент в разборе недоступен.';
          results.push({ type: 'tool_result', tool_use_id: use.id, content });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!submission) throw new AnalysisError('Джарвис не сформулировал вывод. Повторите разбор.');
      await save({
        ...cur,
        ...submission,
        reachability: reach,
        status: 'done',
        finishedAt: now(),
        error: null,
        steps: [...steps],
      });
    } catch (err) {
      if (err instanceof Gone) return;
      if (!(err instanceof AnalysisError))
        this.log.warn(`Разбор ${id}: ${err instanceof Error ? err.message : err}`);
      await this.incidents
        .saveAnalysis(id, {
          ...cur,
          status: 'failed',
          finishedAt: now(),
          error: explain(err),
          steps: [...steps],
        })
        .catch(() => undefined);
    }
  }

  /** Уточняющий вопрос по готовому разбору; ответ и вопрос остаются в инциденте. */
  async ask(id: string, question: string): Promise<Incident> {
    const cfg = await this.config();
    if (!cfg.permissions.analysis)
      throw problem(HttpStatus.CONFLICT, {
        detail:
          'Разбор инцидентов выключен: включите «Разбор по кнопке» в «Настройки → Джарвис → Разрешения».',
      });
    const inc = await this.incidents.get(id);
    const analysis = inc.analysis?.status === 'done' ? inc.analysis : null;
    if (!analysis) throw problem(HttpStatus.CONFLICT, { detail: 'Сначала запустите разбор инцидента.' });
    if (this.running.has(id))
      throw problem(HttpStatus.CONFLICT, { detail: 'Джарвис ещё отвечает. Подождите.' });
    this.running.add(id);
    try {
      const deps = this.readDeps(cfg);
      const past = analysis.thread;
      const messages: LlmMsg[] = [
        {
          role: 'user',
          content: text(`${dataBlock(incidentCase(inc), null)}\n\n${past[0]?.question ?? question}`),
        },
      ];
      past.forEach((t, i) => {
        messages.push({ role: 'assistant', content: text(t.answer) });
        messages.push({ role: 'user', content: text(past[i + 1]?.question ?? question) });
      });
      let answer = '';
      for (let round = 0; round < ASK_ROUNDS; round += 1) {
        const res = await this.llm.run({
          apiKey: cfg.apiKey,
          model: cfg.model,
          system: askSystem(cfg.level, analysis),
          messages,
          tools: toolsFor(ASK_TOOLS, cfg.permissions),
        });
        const uses = res.blocks.filter(
          (b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use',
        );
        answer = res.blocks
          .filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (uses.length === 0) break;
        messages.push({ role: 'assistant', content: res.blocks });
        const results: LlmBlock[] = [];
        for (const use of uses) {
          let content: string;
          try {
            content =
              (await runReadTool(use.name, (use.input ?? {}) as Record<string, unknown>, deps))?.content ??
              'Этот инструмент недоступен.';
          } catch {
            content = 'Инструмент временно недоступен.';
          }
          results.push({ type: 'tool_result', tool_use_id: use.id, content });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!answer) throw new AnalysisError('Джарвис не ответил. Повторите вопрос.');
      const thread = [...past, { question, answer: answer.slice(0, ANSWER_MAX), at: now() }].slice(
        -ANALYSIS_THREAD_MAX,
      );
      if (!(await this.incidents.saveAnalysis(id, { ...analysis, thread })))
        throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
      await this.audit.record({
        action: 'incident.analysis.ask',
        target: { type: 'incident', id, display: inc.title },
        metadata: { model: cfg.model },
      });
      return await this.incidents.get(id);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw problem(HttpStatus.FAILED_DEPENDENCY, { detail: explain(err) });
    } finally {
      this.running.delete(id);
    }
  }
}

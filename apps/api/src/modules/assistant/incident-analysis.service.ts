import { HttpException, HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ANALYSIS_THREAD_MAX,
  AUDIT_ACTIONS,
  AUTOFIX_GRACE_SECONDS,
  INCIDENT_CHART_METRIC,
  type Incident,
  type IncidentAnalysis,
  KB_SOURCE_LABELS,
  type KbSource,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingService } from '../billing/billing.service.js';
import { NODE_ONLINE_METRIC } from '../fleet-stats/fleet-stats.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { NodeBlockCheckService } from '../incidents/node-block-check.service.js';
import { resolveUpstreamTarget } from '../incidents/upstream-target.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { playbookForKind, renderPlaybook } from './assistant.playbooks.js';
import { incidentCase, type ReadDeps, runReadTool, toolsFor } from './assistant.read-tools.js';
import { runTool, type ToolDeps } from './assistant.tools.js';
import { ReadDepsService } from './assistant-read-deps.service.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';
import {
  ANALYSIS_EXTRA,
  ANALYSIS_TOOLS,
  ASK_TOOLS,
  AUTO_ANALYSIS_PER_HOUR,
  analysisSystem,
  askSystem,
  chartName,
  dataBlock,
  freshCheckText,
  nodeNowText,
  parseSubmission,
  pickAutoAnalysis,
  type Submission,
  stepLabel,
} from './incident-analysis.logic.js';
import {
  CONNECTIVITY_KINDS,
  changesText,
  connectionText,
  coverageText,
  fleetText,
  historyText,
  kbQuery,
  kbText,
  onlineText,
  reachText,
  summarizeOnline,
} from './incident-evidence.logic.js';
import { LLM_PROVIDER, type LlmBlock, type LlmMsg, type LlmProvider } from './llm.provider.js';

/** Сбои «сервер недоступен»: к делу добавляем просроченную оплату — частая причина. */
const BILLING_DOWN_KINDS = new Set(['server_down', 'agent_offline', 'ssh_down', 'node_down', 'node_blocked']);

const MAX_ROUNDS = 6;
const ASK_ROUNDS = 4;
/** Весь разбор не дольше этого: зависший провайдер не должен держать «идёт разбор» бесконечно. */
// Плюс до 4 минут на лёгкую проверку сервера, если Джарвис решит её дозапустить (run_server_check).
const TOTAL_MS = 150_000 + 240_000;
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
    private readonly remnawave: RemnawaveService,
    private readonly billing: BillingService,
    private readonly blockCheck: NodeBlockCheckService,
    private readonly notifications: NotificationsService,
    private readonly kbRepo: KnowledgeRepository,
    private readonly auditRepo: AuditRepository,
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
      let nowText: string | null = null;
      let nodeRef: { uuid: string; name: string } | null = null;
      if (CONNECTIVITY_KINDS.has(inc.kind)) {
        await step('Смотрю онлайн ноды сейчас');
        const host = inc.serverId
          ? ((await deps.servers.list()).find((s) => s.id === inc.serverId)?.host ?? null)
          : null;
        const st = await this.remnawave.status().catch(() => null);
        nowText = st ? nodeNowText(inc, st, host) : null;
        // Свежая проверка порта: при «Разобрать заново» Джарвис должен видеть, что сейчас, а не только
        // то, что было при открытии. Нода может и не быть сервером NodeService — адрес берём из Remnawave.
        const node = st?.connected
          ? ((host ? st.nodes.find((n) => n.address === host) : undefined) ??
            st.nodes.find((n) => n.name === inc.serverName))
          : undefined;
        if (node) nodeRef = { uuid: node.uuid, name: node.name };
        if (node) {
          await step('Проверяю порт ноды сейчас');
          const inbound = await this.remnawave.nodeInbound(node.uuid);
          const result = await this.blockCheck
            .check(
              node.name,
              node.address,
              inbound?.port ?? null,
              inbound?.sni ?? null,
              inc.serverId,
              await deps.servers.list(),
            )
            .catch(() => null);
          if (result) {
            const all = await deps.servers.list();
            const me = inc.serverId ? (all.find((x) => x.id === inc.serverId) ?? null) : null;
            const target = await resolveUpstreamTarget(me, all, this.remnawave).catch(() => null);
            if (target) {
              await step('Проверяю вход этого выхода');
              result.entry = await this.blockCheck.checkEntry(target, me?.id ?? null, all).catch(() => null);
            }
          }
          const fresh = result ? freshCheckText(result) : null;
          if (fresh) nowText = nowText ? `${nowText}\n${fresh}` : fresh;
        }
      }
      let billingLines: string[] = [];
      if (inc.serverId && BILLING_DOWN_KINDS.has(inc.kind)) {
        await step('Сверяюсь с биллингом');
        billingLines = await this.billing.paymentRiskForServer(inc.serverId).catch(() => []);
      }
      const evidence = CONNECTIVITY_KINDS.has(inc.kind)
        ? await this.gatherEvidence(inc, deps, step, nodeRef, billingLines.length > 0)
        : [];
      const messages: LlmMsg[] = [
        {
          role: 'user',
          content: text(
            `${dataBlock(incidentCase(inc), metricText, nowText, billingLines, evidence)}\n\nСделайте разбор.`,
          ),
        },
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
              const out = await this.runAnalysisTool(use.name, use.input, deps);
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
      // Сообщение в Telegram ждало разбора — теперь уходит с выводом Джарвиса.
      this.notifications.releaseAfterAnalysis(id, submission.verdict, submission.confidence ?? null);
    } catch (err) {
      // Разбор не получился — отложенное сообщение уходит как есть, без вывода.
      this.notifications.releaseAfterAnalysis(id, null);
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

  /** Чтения разбора; поиск в базе знаний и по Журналу идут через общий исполнитель инструментов. */
  private async runAnalysisTool(name: string, input: unknown, deps: ReadDeps) {
    const arg = (input ?? {}) as Record<string, unknown>;
    if (ANALYSIS_EXTRA.has(name))
      return runTool(name, arg, { ...deps, kb: this.kbRepo, audit: this.auditRepo } as unknown as ToolDeps);
    return runReadTool(name, arg, deps);
  }

  /**
   * Улики по сбою связи — собираются до первого круга модели (решение владельца 29.09.2026: учитывать всё —
   * онлайн, агент, SSH, доступность из разных стран, сбои по парку, прошлые дела, Журнал, базу знаний).
   * Любая часть может не получиться: тогда она попадает в «не удалось», а не роняет разбор.
   */
  private async gatherEvidence(
    inc: Incident,
    deps: ReadDeps,
    step: (label: string) => Promise<void>,
    node: { uuid: string; name: string } | null,
    billingChecked: boolean,
  ): Promise<string[]> {
    const out: string[] = [];
    const checked: Record<string, boolean> = {};
    const soft = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
    const all = (await soft(deps.servers.list())) ?? [];
    const me = inc.serverId ? all.find((s) => s.id === inc.serverId) : undefined;

    checked['агент и SSH'] = Boolean(me);
    if (me) out.push(connectionText(me));

    if (node) {
      await step('Смотрю онлайн ноды за 6 часов');
      const end = Math.floor(Date.now() / 1000);
      const series = await soft(
        deps.metrics.queryRange(
          `max(${NODE_ONLINE_METRIC}{node_uuid="${node.uuid.replace(/["\\\n]/g, '')}"})`,
          end - 6 * 3600,
          end,
          300,
        ),
      );
      const points = series?.[0]?.points ?? [];
      checked['онлайн ноды'] = points.length > 0;
      if (points.length > 0)
        out.push(onlineText(node.name, summarizeOnline(points, Date.parse(inc.openedAt))));
    } else checked['онлайн ноды (сервер не нода Remnawave)'] = false;

    if (me) {
      await step('Проверяю порт SSH из разных стран');
      const [reach, panelOpen] = await Promise.all([
        soft(this.blockCheck.countryReach(me.host, me.port, me.id, all)),
        soft(this.incidents.probeHost(me.host, me.port)),
      ]);
      checked['порт из разных стран'] = Boolean(reach && reach.length > 0);
      out.push(reachText(me.port, reach ?? [], panelOpen));
    }

    await step('Сверяю со сбоями на других серверах');
    const open = await soft(this.incidents.list('open'));
    checked['сбои по парку'] = Boolean(open);
    if (open) out.push(fleetText(inc, open.items));

    if (inc.serverId) {
      await step('Смотрю прошлые дела этого сервера');
      const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const past = await soft(this.incidents.list('all', { openedFrom: from, page: 1, pageSize: 100 }));
      checked['прошлые дела сервера'] = Boolean(past);
      if (past)
        out.push(
          historyText(
            inc,
            past.items.filter((i) => i.serverId === inc.serverId),
          ),
        );

      await step('Смотрю Журнал по серверу за сутки');
      const log = await soft(
        this.auditRepo.list({
          targetId: inc.serverId,
          from: new Date(Date.now() - 86_400_000).toISOString(),
          page: 1,
          pageSize: 10,
        }),
      );
      checked['Журнал'] = Boolean(log);
      if (log)
        out.push(
          changesText(
            log.items.map((e) => ({
              at: e.occurredAt,
              action:
                (AUDIT_ACTIONS as Record<string, { label: string } | undefined>)[e.action]?.label ?? e.action,
              result: e.result,
            })),
          ),
        );
    }

    await step('Ищу похожие случаи в базе знаний');
    const docs = await soft(this.kbRepo.searchForContext(kbQuery(inc), 3));
    checked['база знаний'] = Boolean(docs);
    if (docs)
      out.push(
        kbText(
          docs.map((d) => ({
            title: d.title,
            content: d.content,
            updatedAt: d.updatedAt,
            source: KB_SOURCE_LABELS[d.source as KbSource] ?? d.source,
          })),
        ),
      );

    checked['биллинг'] = billingChecked || BILLING_DOWN_KINDS.has(inc.kind);
    out.push(coverageText(checked));
    return out;
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
              (await this.runAnalysisTool(use.name, use.input, deps))?.content ??
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

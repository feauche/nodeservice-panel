import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type ActionKey,
  type ActionLevel,
  ATTEMPT_LOG_MAX,
  ATTEMPT_STATUS_LABELS,
  type AttemptStep,
  type AttemptStepKey,
  AUTOFIX_GRACE_SECONDS,
  actionByKey,
  actionMeta,
  INCIDENT_CHAINS,
  type IncidentAttempt,
  type IncidentEvent,
  type IncidentKind,
  type IncidentProposal,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { IncidentRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { ACTION_SPECS, type Precheck, postcheckMetricFor } from './actions.registry.js';
import { IncidentMetricsService } from './incident-metrics.service.js';
import { IncidentsRepository } from './incidents.repository.js';

const TEST = process.env.NODE_ENV === 'test';
/** Тайминги: в проде — реальные секунды, в e2e — миллисекунды, чтобы тесты шли быстро. */
const T = TEST
  ? {
      pollMs: 40,
      probeMs: 40,
      diskTimeoutMs: 400,
      agentTimeoutMs: 400,
      xrayTimeoutMs: 400,
      execTimeoutMs: 5_000,
      staleMs: 1_000,
      graceMs: 0,
    }
  : {
      pollMs: 20_000,
      /** Быстрые проверки по SSH (процесс, df) — не ждём следующую метрику агента. */
      probeMs: 5_000,
      diskTimeoutMs: 90_000,
      agentTimeoutMs: 120_000,
      xrayTimeoutMs: 60_000,
      execTimeoutMs: 180_000,
      /** Попытка, которая идёт дольше и не числится в памяти, — зависла: сторож её закрывает. */
      staleMs: 15 * 60_000,
      /** Пауза перед первым шагом цепочки: вдруг поднимется само. */
      graceMs: AUTOFIX_GRACE_SECONDS * 1000,
    };

/**
 * Контейнер ноды ищем по имени `*remna*` или образу `remnawave/node` — имя у установок разное
 * (remnanode, remnawave-node…). Зонд по SSH от root: `true` / `false` / `none` (контейнера нет).
 */
export const NODE_FIND =
  "N=$(docker ps -a --format '{{.Names}}|{{.Image}}' 2>/dev/null | awk -F'|' 'tolower($1) ~ /remna/ || tolower($2) ~ /remnawave\\/node/ {print $1; exit}')";
export const NODE_PROBE = `${NODE_FIND}; [ -n "$N" ] && docker inspect -f '{{.State.Running}}' "$N" 2>/dev/null || echo none`;

const NUL_RE = new RegExp(String.fromCharCode(0), 'g');
const iso = () => new Date().toISOString();

/** Что сделано с открытым инцидентом: ждём паузу автопочинки, предложили шаг, запустили, ничего. */
export type Decision = 'waiting' | 'proposed' | 'started' | 'none';
const ev = (
  by: 'auto' | 'manual',
  action: string,
  result: IncidentEvent['result'],
  level?: ActionLevel,
): IncidentEvent => ({ at: iso(), by, action, result, ...(level ? { level } : {}) });

const STEP_LABELS: Record<AttemptStepKey, string> = {
  precheck: 'Пред-проверка',
  action: 'Действие',
  postcheck: 'Пост-проверка',
  rollback: 'Откат',
};

/** Попытку оборвали снаружи (закрыли инцидент, сторож) — её ход в памяти молча останавливается. */
class AttemptAborted extends Error {
  constructor() {
    super('attempt aborted');
  }
}

/** Оборванная попытка: идущий шаг — «ошибка» с пометкой, не начатые — «пропущен». */
function abortAttempt(a: IncidentAttempt, note: string): IncidentAttempt {
  const now = iso();
  return {
    ...a,
    status: 'failed',
    finishedAt: now,
    steps: a.steps.map((s) =>
      s.status === 'running'
        ? { ...s, status: 'failed', finishedAt: now, note }
        : s.status === 'pending'
          ? { ...s, status: 'skipped' }
          : s,
    ),
  };
}

/**
 * Исполнитель действий по инциденту (§2 мастер-плана). Одна попытка = пред-проверка → действие →
 * пост-проверка → откат. Не помогло — следующий шаг цепочки: T1 при включённом авто выполняется
 * сам, T2 ждёт подтверждения, T3 показывается как команда. Всё пишется в попытку (шаги + лог) и в Журнал.
 * Одновременно на сервере идёт не больше одного действия.
 */
@Injectable()
export class IncidentRunnerService implements OnModuleInit {
  private readonly log = new Logger(IncidentRunnerService.name);
  /** id попыток, которые реально идут в этом процессе. Есть в БД, но нет здесь — осиротела. */
  private readonly active = new Set<string>();
  /** serverId → incidentId с идущим действием. */
  private readonly busy = new Map<string, string>();
  /** Куски вывода пишутся в БД строго по очереди — иначе параллельные read-modify-write затирают друг друга. */
  private readonly logChains = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly repo: IncidentsRepository,
    private readonly servers: ServersService,
    private readonly serversRepo: ServersRepository,
    private readonly ssh: SshService,
    private readonly settings: IncidentsSettingsStore,
    private readonly audit: AuditService,
    private readonly metrics: IncidentMetricsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Панель перезапустили — попытки, шедшие в памяти, некому завершить: закрываем их как прерванные. */
  async onModuleInit(): Promise<void> {
    const n = await this.failOrphans('Прервано перезапуском панели', () => true).catch(() => 0);
    if (n > 0) this.log.warn(`Закрыто незавершённых попыток по инцидентам: ${n}`);
  }

  /**
   * Закрыть попытки со статусом «выполняется», которых нет в памяти процесса. Иначе инцидент
   * навсегда «идёт» и блокирует новые действия. Шаг, что шёл, — «ошибка» с пометкой, остальные — «пропущен».
   */
  async failOrphans(note: string, pick: (a: IncidentAttempt) => boolean): Promise<number> {
    let n = 0;
    for (const row of await this.repo.list('all')) {
      const stale = row.attempts.filter((a) => a.status === 'running' && !this.active.has(a.id) && pick(a));
      if (stale.length === 0) continue;
      const ids = new Set(stale.map((a) => a.id));
      await this.repo.update(row.id, {
        attempts: row.attempts.map((a) => (ids.has(a.id) ? abortAttempt(a, note) : a)),
        timeline: [
          ...row.timeline,
          ...stale.map((a) =>
            ev(a.by, `${actionMeta(a.action).title}: ${note.toLowerCase()}`, 'failed', a.level),
          ),
        ],
      });
      n += stale.length;
    }
    return n;
  }

  /** Инцидент закрывают руками, пока действие идёт — попытку обрываем, чтобы не висела «выполняется». */
  async cancelRunning(incidentId: string, note: string): Promise<void> {
    const row = await this.repo.findById(incidentId);
    if (!row) return;
    const running = row.attempts.filter((a) => a.status === 'running');
    if (running.length === 0) return;
    for (const a of running) this.active.delete(a.id);
    await this.repo.update(incidentId, {
      attempts: row.attempts.map((a) => (a.status === 'running' ? abortAttempt(a, note) : a)),
      timeline: [
        ...row.timeline,
        ...running.map((a) =>
          ev(a.by, `${actionMeta(a.action).title}: ${note.toLowerCase()}`, 'failed', a.level),
        ),
      ],
    });
    if (row.serverId && this.busy.get(row.serverId) === incidentId) this.busy.delete(row.serverId);
  }

  /** Дождаться всех идущих попыток — для тестов и корректного выключения. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Запустить действие: проверки уместности здесь, сама работа — в фоне. Возвращает инцидент
   * с попыткой в статусе «выполняется»; клиент перечитывает его, пока попытка идёт.
   */
  async start(incidentId: string, key: ActionKey, by: 'auto' | 'manual'): Promise<IncidentRow> {
    const row = await this.repo.findById(incidentId);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row.status === 'resolved') throw problem(HttpStatus.CONFLICT, { detail: 'Инцидент уже закрыт.' });
    if (!row.serverId)
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'У инцидента нет сервера для починки.' });
    const action = actionByKey(key);
    if (!action.kinds.includes(row.kind as IncidentKind))
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'Это действие не подходит к инциденту.' });
    if (action.terminal || !ACTION_SPECS[key])
      throw problem(HttpStatus.BAD_REQUEST, {
        detail: 'Действие уровня T3 панель не выполняет — только вручную в терминале.',
      });
    if (row.attempts.some((a) => a.status === 'running'))
      throw problem(HttpStatus.CONFLICT, { detail: 'По инциденту уже идёт действие — дождись его конца.' });
    if (this.busy.has(row.serverId))
      throw problem(HttpStatus.CONFLICT, { detail: 'На этом сервере уже выполняется другое действие.' });

    const attempt: IncidentAttempt = {
      id: randomUUID(),
      action: key,
      level: action.level,
      by,
      status: 'running',
      startedAt: iso(),
      finishedAt: null,
      steps: (['precheck', 'action', 'postcheck', 'rollback'] as AttemptStepKey[]).map((k) => ({
        key: k,
        label: k === 'action' ? action.title : STEP_LABELS[k],
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        note: null,
      })),
      log: '',
    };
    const updated = await this.repo.update(incidentId, {
      attempts: [...row.attempts, attempt],
      proposal: null,
      lastAutofixAt: new Date(),
      ...(row.status === 'open' && by === 'manual' ? { status: 'acknowledged' } : {}),
    });
    this.busy.set(row.serverId, incidentId);
    this.active.add(attempt.id);
    const job = this.run(incidentId, attempt.id, key, by)
      .catch((err) => {
        if (err instanceof AttemptAborted) return;
        this.log.warn(`действие ${key} по инциденту ${incidentId}: ${(err as Error).message}`);
      })
      .finally(() => {
        this.active.delete(attempt.id);
        if (this.busy.get(row.serverId as string) === incidentId) this.busy.delete(row.serverId as string);
        this.inflight.delete(job);
      });
    this.inflight.add(job);
    return updated ?? row;
  }

  /** Тик автопочинки: свежие инциденты без попыток — решаем, что с ними делать; сторож зависших попыток. */
  async autoTick(): Promise<void> {
    // Сторож: «выполняется» дольше лимита и не в памяти — зависла, закрываем.
    await this.failOrphans(
      'Прервано: действие зависло',
      (a) => Date.now() - new Date(a.startedAt).getTime() > T.staleMs,
    ).catch((err) => this.log.warn(`сторож попыток: ${(err as Error).message}`));
    const cfg = await this.settings.get();
    for (const row of await this.repo.list('open')) await this.decide(row, cfg);
  }

  /** Инцидент только что открыт — решаем сразу, не дожидаясь тика. */
  async onOpened(row: IncidentRow): Promise<Decision> {
    return this.decide(row, await this.settings.get());
  }

  /**
   * Первый шаг цепочки. T1 с включённым авто — выполняется сам, но не раньше AUTOFIX_GRACE_SECONDS
   * после открытия: вдруг поднимется само. Всё остальное (T2, T3, выключенное авто) предлагается
   * сразу — предложение и ручной запуск не ждут.
   */
  private async decide(
    row: IncidentRow,
    cfg: Awaited<ReturnType<IncidentsSettingsStore['get']>>,
  ): Promise<Decision> {
    if (!row.serverId || row.proposal || row.attempts.length > 0) return 'none';
    const first = INCIDENT_CHAINS[row.kind as IncidentKind][0];
    if (!first) return 'none';
    const action = actionByKey(first);
    const autoAllowed = cfg.autofixEnabled && action.level === 'T1' && cfg.actions[first] === true;
    if (!autoAllowed) {
      await this.propose(
        row,
        first,
        action.level === 'T1' ? 'авто для этого действия выключено' : 'первый шаг цепочки',
      );
      return 'proposed';
    }
    if (Date.now() - row.openedAt.getTime() < T.graceMs) return 'waiting';
    if (this.busy.has(row.serverId)) return 'waiting';
    if (row.lastAutofixAt && Date.now() - row.lastAutofixAt.getTime() < cfg.autofixCooldownMinutes * 60_000)
      return 'waiting';
    await this.notifications.push({
      severity: row.severity === 'crit' ? 'crit' : 'warn',
      title: `${row.title}: чиню автоматически`,
      body: `${row.detail} Запускаю «${action.title}» (T1).`,
      link: { to: `/incidents?open=${row.id}`, label: 'Открыть инцидент' },
    });
    await this.start(row.id, first, 'auto').catch((err) =>
      this.log.warn(`автопочинка ${row.id}: ${(err as Error).message}`),
    );
    return 'started';
  }

  /* ---------- ход попытки ---------- */

  private async run(
    incidentId: string,
    attemptId: string,
    key: ActionKey,
    by: 'auto' | 'manual',
  ): Promise<void> {
    const spec = ACTION_SPECS[key];
    const action = actionByKey(key);
    if (!spec) return;
    const row0 = await this.repo.findById(incidentId);
    if (!row0?.serverId) return;
    const serverId = row0.serverId;
    const kind = row0.kind as IncidentKind;
    const cfg = await this.settings.get();

    // 1. Пред-проверка
    await this.step(incidentId, attemptId, 'precheck', 'running');
    const pre = await this.precheck(spec.precheck, serverId, incidentId);
    if (!pre.ok) {
      await this.step(incidentId, attemptId, 'precheck', 'failed', pre.note);
      await this.finish(incidentId, attemptId, 'precheck_failed', ['action', 'postcheck', 'rollback']);
      await this.repo.appendEvent(
        incidentId,
        ev(
          by,
          `Пред-проверка не пройдена: ${pre.note} — «${action.title}» не запускалось`,
          'failed',
          action.level,
        ),
      );
      await this.auditAttempt(row0, key, by, 'precheck_failed', pre.note);
      // Автоматика не уверена на 100 % → понижаем до T2: пусть решает администратор.
      if (by === 'auto') await this.propose(row0, key, `пред-проверка не пройдена: ${pre.note}`, 'T2');
      return;
    }
    await this.step(incidentId, attemptId, 'precheck', 'ok', pre.note);

    // 2. Действие
    await this.step(incidentId, attemptId, 'action', 'running');
    const act = await this.execute(spec, serverId, incidentId, attemptId);
    if (!act.ok) {
      await this.step(incidentId, attemptId, 'action', 'failed', act.note);
      await this.rollback(spec, serverId, incidentId, attemptId, action.rollbackNote);
      await this.finish(incidentId, attemptId, 'failed', ['postcheck']);
      await this.repo.appendEvent(
        incidentId,
        ev(by, `«${action.title}»: ошибка выполнения — ${act.note}`, 'failed', action.level),
      );
      await this.auditAttempt(row0, key, by, 'failed', act.note);
      await this.escalate(incidentId, key, by, `«${action.title}» завершилось с ошибкой`);
      return;
    }
    await this.step(incidentId, attemptId, 'action', 'ok', act.note);
    await this.repo.appendEvent(incidentId, ev(by, `Выполнено: ${action.title}`, 'applied', action.level));

    // 3. Пост-проверка
    await this.step(incidentId, attemptId, 'postcheck', 'running', `ждём: ${action.postcheck}`);
    const post = await this.postcheck(spec, kind, serverId, cfg);
    if (post.ok) {
      await this.step(incidentId, attemptId, 'postcheck', 'ok', post.note);
      await this.step(incidentId, attemptId, 'rollback', 'skipped', action.rollbackNote ?? 'не потребовался');
      await this.finish(incidentId, attemptId, 'helped', []);
      const row = await this.repo.findById(incidentId);
      if (!row) return;
      await this.repo.update(incidentId, {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: by,
        proposal: null,
        timeline: [
          ...row.timeline,
          ev(by, `Пост-проверка: ${post.note} — помогло`, 'helped', action.level),
          ev(by, 'Проблема устранена — инцидент закрыт', 'resolved'),
        ],
      });
      await this.auditAttempt(row0, key, by, 'helped', post.note);
      await this.audit.record({
        action: 'incident.resolved',
        ...(by === 'auto' ? { actor: SYSTEM_ACTOR, source: 'auto' as const } : {}),
        target: { type: 'incident', id: incidentId, display: row0.title },
        metadata: { by, action: key },
      });
      return;
    }
    await this.step(incidentId, attemptId, 'postcheck', 'failed', post.note);
    await this.rollback(spec, serverId, incidentId, attemptId, action.rollbackNote);
    await this.finish(incidentId, attemptId, 'not_helped', []);
    await this.repo.appendEvent(
      incidentId,
      ev(by, `Пост-проверка: ${post.note} — не помогло`, 'failed', action.level),
    );
    await this.auditAttempt(row0, key, by, 'not_helped', post.note);
    await this.escalate(incidentId, key, by, `«${action.title}» не помогло`);
  }

  private async precheck(
    checks: Precheck[],
    serverId: string,
    incidentId: string,
  ): Promise<{ ok: boolean; note: string }> {
    const passed: string[] = [];
    for (const c of checks) {
      if (c === 'no_other_action') {
        const other = this.busy.get(serverId);
        if (other && other !== incidentId) return { ok: false, note: 'на ноде уже идёт другое действие' };
        passed.push('нода свободна');
      } else if (c === 'agent_online') {
        const srv = await this.serversRepo.findById(serverId);
        if (srv?.agentStatus !== 'online') return { ok: false, note: 'агент не в сети' };
        passed.push('агент в сети');
      } else if (c === 'disk_not_full') {
        const m = await this.metrics.latestFor(serverId);
        if (m?.disk === undefined) return { ok: false, note: 'нет свежей метрики диска' };
        if (m.disk >= 100) return { ok: false, note: 'диск переполнен, командам может не хватить места' };
        passed.push(`диск ${Math.round(m.disk)} %`);
      } else if (c === 'ssh_ok') {
        try {
          const { target } = await this.servers.sshTargetFor(serverId);
          const s = await this.ssh.connect(target);
          s.end();
          passed.push('SSH отвечает');
        } catch (err) {
          return { ok: false, note: `SSH не отвечает: ${(err as Error).message}` };
        }
      }
    }
    return { ok: true, note: passed.join(', ') };
  }

  private async execute(
    spec: NonNullable<(typeof ACTION_SPECS)[ActionKey]>,
    serverId: string,
    incidentId: string,
    attemptId: string,
  ): Promise<{ ok: boolean; note: string }> {
    const t0 = Date.now();
    const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} с`;
    try {
      if (spec.special === 'agent_reinstall') {
        await this.appendLog(incidentId, attemptId, '$ установка агента по SSH (как из окна сервера)\n');
        await this.servers.installAgent(serverId);
        await this.appendLog(incidentId, attemptId, 'агент переустановлен, ждём выхода на связь\n');
        return { ok: true, note: `установлено за ${secs()}` };
      }
      if (!spec.command) return { ok: false, note: 'у действия нет команды' };
      const { target } = await this.servers.sshTargetFor(serverId);
      const session = await this.ssh.connect(target);
      try {
        await this.appendLog(incidentId, attemptId, `$ ${spec.command}\n`);
        const res = await session.execStream(spec.command, {
          timeoutMs: T.execTimeoutMs,
          onData: (chunk: string) => void this.appendLog(incidentId, attemptId, chunk),
        });
        if (res.code !== 0) return { ok: false, note: `код возврата ${res.code}` };
        if (spec.containerCheck) {
          const chk = await session.exec(spec.containerCheck);
          const out = chk.stdout.trim();
          await this.appendLog(incidentId, attemptId, `$ ${spec.containerCheck}\n${out || '(пусто)'}\n`);
          if (out === 'false') return { ok: false, note: 'контейнер не поднялся' };
        }
        return { ok: true, note: `выполнено за ${secs()}` };
      } finally {
        session.end();
      }
    } catch (err) {
      return { ok: false, note: String((err as Error).message ?? err).slice(0, 160) };
    }
  }

  private async postcheck(
    spec: NonNullable<(typeof ACTION_SPECS)[ActionKey]>,
    kind: IncidentKind,
    serverId: string,
    cfg: { cpuPct: number; memPct: number; diskPct: number },
  ): Promise<{ ok: boolean; note: string }> {
    const pc = spec.postcheck;
    if (pc.kind === 'none') return { ok: true, note: 'проверка не нужна' };
    if (pc.kind === 'node_up') {
      // Контейнер запущен: docker inspect по SSH каждые probeMs; SSH не вышло — состояние из зонда панели.
      const deadline = Date.now() + T.xrayTimeoutMs;
      while (Date.now() < deadline) {
        const probe = await this.sshProbe(serverId, NODE_PROBE);
        if (probe === 'true') return { ok: true, note: 'контейнер ноды запущен' };
        if (probe === 'none') return { ok: false, note: 'контейнера remnanode на сервере нет' };
        if (probe === null && this.metrics.nodeRunning(serverId) === true)
          return { ok: true, note: 'контейнер ноды запущен' };
        await sleep(T.probeMs);
      }
      return { ok: false, note: `контейнер не запустился за ${Math.round(T.xrayTimeoutMs / 1000)} с` };
    }
    if (pc.kind === 'agent_online') {
      const deadline = Date.now() + T.agentTimeoutMs;
      while (Date.now() < deadline) {
        const srv = await this.serversRepo.findById(serverId);
        if (srv?.agentStatus === 'online') return { ok: true, note: 'агент вышел на связь' };
        await sleep(T.pollMs);
      }
      return { ok: false, note: `агент не вышел на связь за ${Math.round(T.agentTimeoutMs / 1000)} с` };
    }
    const metric = pc.metric === 'cpu' || pc.metric === 'mem' ? postcheckMetricFor(kind) : pc.metric;
    const threshold = metric === 'cpu' ? cfg.cpuPct : metric === 'mem' ? cfg.memPct : cfg.diskPct;
    const limit = threshold - pc.marginPct;
    const label = metric === 'cpu' ? 'CPU' : metric === 'mem' ? 'память' : 'диск';
    const deadline = Date.now() + (pc.samples > 1 ? pc.samples * T.pollMs + T.pollMs : T.diskTimeoutMs);
    let below = 0;
    const seen: number[] = [];
    while (Date.now() < deadline) {
      // Диск проверяем по SSH сразу (df), CPU/память — по метрикам агента (нужны замеры во времени).
      let v: number | undefined;
      if (metric === 'disk') {
        const probe = await this.sshProbe(serverId, `df -P / | awk 'NR==2{gsub("%","",$5);print $5}'`);
        const n = probe === null ? Number.NaN : Number(probe);
        v = Number.isFinite(n) ? n : (await this.metrics.latestFor(serverId))?.disk;
      } else {
        v = (await this.metrics.latestFor(serverId))?.[metric];
      }
      if (v !== undefined) {
        seen.push(Math.round(v));
        below = v < limit ? below + 1 : 0;
        if (below >= pc.samples) return { ok: true, note: `${label} ${seen.join(' % · ')} % < ${limit} %` };
      }
      await sleep(metric === 'disk' ? T.probeMs : T.pollMs);
    }
    return {
      ok: false,
      note: seen.length
        ? `${label} ${seen.slice(-3).join(' % · ')} % — не ниже ${limit} %`
        : `нет свежей метрики: ${label}`,
    };
  }

  /** Короткая команда по SSH; вывод без пробелов или null, если не вышло (тогда решает метрика). */
  async sshProbe(serverId: string, command: string): Promise<string | null> {
    try {
      const { target } = await this.servers.sshTargetFor(serverId);
      const session = await this.ssh.connect(target);
      try {
        const res = await session.exec(command);
        const out = res.stdout.trim();
        return res.code === 0 && out ? out : null;
      } finally {
        session.end();
      }
    } catch {
      return null;
    }
  }

  private async rollback(
    spec: NonNullable<(typeof ACTION_SPECS)[ActionKey]>,
    serverId: string,
    incidentId: string,
    attemptId: string,
    note: string | null,
  ): Promise<void> {
    if (!spec.rollback) {
      await this.step(incidentId, attemptId, 'rollback', 'skipped', note ?? 'отката у действия нет');
      return;
    }
    await this.step(incidentId, attemptId, 'rollback', 'running');
    try {
      const { target } = await this.servers.sshTargetFor(serverId);
      const session = await this.ssh.connect(target);
      try {
        await this.appendLog(incidentId, attemptId, `$ ${spec.rollback}\n`);
        const res = await session.execStream(spec.rollback, {
          timeoutMs: T.execTimeoutMs,
          onData: (chunk: string) => void this.appendLog(incidentId, attemptId, chunk),
        });
        await this.step(
          incidentId,
          attemptId,
          'rollback',
          res.code === 0 ? 'ok' : 'failed',
          `код ${res.code}`,
        );
      } finally {
        session.end();
      }
    } catch (err) {
      await this.step(
        incidentId,
        attemptId,
        'rollback',
        'failed',
        String((err as Error).message).slice(0, 160),
      );
    }
  }

  /** Следующий шаг цепочки: T1 при включённом авто — сразу, иначе предложение (T2/T3 или подтверждение T1). */
  private async escalate(
    incidentId: string,
    current: ActionKey,
    by: 'auto' | 'manual',
    reason: string,
  ): Promise<void> {
    const row = await this.repo.findById(incidentId);
    if (!row || row.status === 'resolved' || !row.serverId) return;
    const chain = INCIDENT_CHAINS[row.kind as IncidentKind];
    const next = chain[chain.indexOf(current) + 1];
    if (!next) {
      await this.repo.appendEvent(
        incidentId,
        ev(by, 'Шаги цепочки исчерпаны — нужно разбираться вручную', 'escalate'),
      );
      return;
    }
    const action = actionByKey(next);
    const cfg = await this.settings.get();
    if (by === 'auto' && action.level === 'T1' && cfg.autofixEnabled && cfg.actions[next] === true) {
      await this.repo.appendEvent(
        incidentId,
        ev('auto', `${reason} — следующий шаг: ${action.title}`, 'escalate', 'T1'),
      );
      // Цепочка продолжается сама: занятость сервера снимет finally предыдущего запуска чуть позже,
      // поэтому стартуем после него.
      setTimeout(() => {
        void this.start(incidentId, next, 'auto').catch((err) =>
          this.log.warn(`цепочка ${incidentId}: ${(err as Error).message}`),
        );
      }, 0);
      return;
    }
    await this.propose(row, next, reason);
  }

  private async propose(
    row: IncidentRow,
    key: ActionKey,
    reason: string,
    levelOverride?: ActionLevel,
  ): Promise<void> {
    const action = actionByKey(key);
    const level = levelOverride ?? action.level;
    const proposal: IncidentProposal = { action: key, level, reason, proposedAt: iso() };
    const fresh = await this.repo.findById(row.id);
    if (!fresh || fresh.status === 'resolved') return;
    await this.repo.update(row.id, {
      proposal,
      timeline: [
        ...fresh.timeline,
        ev(
          'auto',
          level === 'T3'
            ? `Следующий шаг только вручную: ${action.title} — команда показана в инциденте`
            : `Предложено: ${action.title} — ждёт подтверждения`,
          'escalate',
          level,
        ),
      ],
    });
    const first = fresh.attempts.length === 0;
    await this.notifications.push({
      severity: level === 'T3' || row.severity === 'crit' ? 'crit' : 'warn',
      title: level === 'T3' ? `${row.title}: нужно вмешательство` : `${row.title}: ждёт подтверждения`,
      body:
        level === 'T3'
          ? `${action.title} — только вручную. ${reason}.`
          : `${first ? `${row.detail} ` : ''}Предложено: ${action.title} (${level}), ${reason}. Подтвердите запуск в инциденте.`,
      link: { to: `/incidents?open=${row.id}`, label: 'Открыть инцидент' },
    });
    await this.audit.record({
      action: 'incident.action.proposed',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { action: key, level, reason },
    });
  }

  /* ---------- служебное ---------- */

  private async step(
    incidentId: string,
    attemptId: string,
    key: AttemptStepKey,
    status: AttemptStep['status'],
    note?: string | null,
  ): Promise<void> {
    await this.patchAttempt(incidentId, attemptId, (a) => ({
      ...a,
      steps: a.steps.map((s) =>
        s.key === key
          ? {
              ...s,
              status,
              startedAt:
                status === 'running' ? iso() : (s.startedAt ?? (status === 'skipped' ? null : iso())),
              finishedAt: status === 'running' || status === 'pending' ? null : iso(),
              note: note ?? s.note,
            }
          : s,
      ),
    }));
  }

  private async finish(
    incidentId: string,
    attemptId: string,
    status: IncidentAttempt['status'],
    skip: AttemptStepKey[],
  ): Promise<void> {
    await this.logChains.get(attemptId);
    this.logChains.delete(attemptId);
    await this.patchAttempt(incidentId, attemptId, (a) => ({
      ...a,
      status,
      finishedAt: iso(),
      steps: a.steps.map((s) =>
        skip.includes(s.key) && s.status === 'pending' ? { ...s, status: 'skipped' } : s,
      ),
    }));
  }

  /**
   * Куски вывода пишутся по очереди. Цепочка никогда не отклоняется: вызовы из onData не ждут её,
   * а необработанный reject роняет процесс. Вывод чистим от ANSI, нулевых байтов и битого UTF-16 —
   * jsonb в Postgres такое не принимает.
   */
  private appendLog(incidentId: string, attemptId: string, chunk: string): Promise<void> {
    const clean = sanitizeOutput(chunk);
    const prev = this.logChains.get(attemptId) ?? Promise.resolve();
    const next = prev
      .then(() =>
        this.patchAttempt(incidentId, attemptId, (a) => ({
          ...a,
          log: (a.log + clean).slice(-ATTEMPT_LOG_MAX),
        })),
      )
      .catch((err) => {
        if (!(err instanceof AttemptAborted))
          this.log.warn(`лог попытки ${attemptId}: ${(err as Error).message}`);
      });
    this.logChains.set(attemptId, next);
    return next;
  }

  private async patchAttempt(
    incidentId: string,
    attemptId: string,
    fn: (a: IncidentAttempt) => IncidentAttempt,
  ): Promise<void> {
    const row = await this.repo.findById(incidentId);
    if (!row) return;
    // Попытку уже оборвали (закрыли инцидент, сторож) — ход в памяти останавливается, ничего не пишет.
    if (!row.attempts.some((a) => a.id === attemptId && a.status === 'running')) throw new AttemptAborted();
    await this.repo.update(incidentId, {
      attempts: row.attempts.map((a) => (a.id === attemptId ? fn(a) : a)),
    });
  }

  private async auditAttempt(
    row: IncidentRow,
    key: ActionKey,
    by: 'auto' | 'manual',
    result: IncidentAttempt['status'],
    note: string,
  ): Promise<void> {
    const action = actionByKey(key);
    if (result !== 'done')
      await this.notifications.push({
        severity: result === 'helped' ? 'ok' : 'warn',
        title:
          result === 'helped'
            ? `${row.title}: «${action.title}» помогло`
            : `${row.title}: «${action.title}» — ${ATTEMPT_STATUS_LABELS[result]}`,
        body: `${by === 'auto' ? 'Автоматически' : 'По вашей команде'} · ${note}`,
        link: { to: `/incidents?open=${row.id}`, label: 'Открыть инцидент' },
      });
    await this.audit.record({
      action: 'incident.autofix',
      ...(result === 'helped' || result === 'done'
        ? {}
        : { result: 'failed' as const, severity: 'warn' as const }),
      ...(by === 'auto' ? { actor: SYSTEM_ACTOR, source: 'auto' as const } : {}),
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { action: key, level: action.level, result, note },
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Цвета и управляющие последовательности терминала в логе не нужны. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}|\\r`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');
/** Вывод команды для jsonb: без ANSI, без NUL, без одиноких суррогатов. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const sanitizeOutput = (s: string) => stripAnsi(s).replace(NUL_RE, '').replace(LONE_SURROGATE_RE, '');

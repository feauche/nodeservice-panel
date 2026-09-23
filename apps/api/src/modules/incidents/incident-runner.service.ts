import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type ActionKey,
  type ActionLevel,
  ATTEMPT_LOG_MAX,
  ATTEMPT_STATUS_LABELS,
  type AttemptStep,
  type AttemptStepKey,
  actionByKey,
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
  ? { pollMs: 40, diskTimeoutMs: 400, agentTimeoutMs: 400, execTimeoutMs: 5_000 }
  : { pollMs: 20_000, diskTimeoutMs: 90_000, agentTimeoutMs: 120_000, execTimeoutMs: 180_000 };

const iso = () => new Date().toISOString();
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

/**
 * Исполнитель действий по инциденту (§2 мастер-плана). Одна попытка = пред-проверка → действие →
 * пост-проверка → откат. Не помогло — следующий шаг цепочки: T1 при включённом авто выполняется
 * сам, T2 ждёт «Да», T3 показывается как команда. Всё пишется в попытку (шаги + лог) и в Журнал.
 * Одновременно на сервере идёт не больше одного действия.
 */
@Injectable()
export class IncidentRunnerService {
  private readonly log = new Logger(IncidentRunnerService.name);
  /** serverId → incidentId с идущим действием. */
  private readonly busy = new Map<string, string>();
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
    const job = this.run(incidentId, attempt.id, key, by)
      .catch((err) => this.log.warn(`действие ${key} по инциденту ${incidentId}: ${(err as Error).message}`))
      .finally(() => {
        if (this.busy.get(row.serverId as string) === incidentId) this.busy.delete(row.serverId as string);
        this.inflight.delete(job);
      });
    this.inflight.add(job);
    return updated ?? row;
  }

  /** Тик автопочинки: первый шаг цепочки — сам (T1 включено) или как предложение. */
  async autoTick(): Promise<void> {
    const cfg = await this.settings.get();
    for (const row of await this.repo.list('open')) {
      if (!row.serverId || row.proposal || row.attempts.some((a) => a.status === 'running')) continue;
      // Уже пробовали — эскалация решает, что дальше; сюда только «свежие» инциденты.
      if (row.attempts.length > 0) continue;
      const first = INCIDENT_CHAINS[row.kind as IncidentKind][0];
      if (!first) continue;
      const action = actionByKey(first);
      const autoAllowed =
        cfg.autofixEnabled &&
        action.level === 'T1' &&
        cfg.actions[first] === true &&
        !this.busy.has(row.serverId);
      if (autoAllowed) {
        if (
          row.lastAutofixAt &&
          Date.now() - row.lastAutofixAt.getTime() < cfg.autofixCooldownMinutes * 60_000
        )
          continue;
        await this.start(row.id, first, 'auto').catch((err) =>
          this.log.warn(`автопочинка ${row.id}: ${(err as Error).message}`),
        );
      } else {
        await this.propose(
          row,
          first,
          action.level === 'T1'
            ? 'авто для этого действия выключено'
            : `первый шаг цепочки для «${row.title}»`,
        );
      }
    }
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
    await this.step(incidentId, attemptId, 'postcheck', 'running');
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
    if (kind === 'xray_down') {
      // Для «Xray не запущен» пост-проверка одна: процесс появился.
      const deadline = Date.now() + T.agentTimeoutMs;
      while (Date.now() < deadline) {
        const m = await this.metrics.latestFor(serverId);
        if (m?.xray !== undefined && m.xray >= 0.5) return { ok: true, note: 'процесс xray запущен' };
        await sleep(T.pollMs);
      }
      return { ok: false, note: `процесс xray не появился за ${Math.round(T.agentTimeoutMs / 1000)} с` };
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
      const m = await this.metrics.latestFor(serverId);
      const v = m?.[metric];
      if (v !== undefined) {
        seen.push(Math.round(v));
        below = v < limit ? below + 1 : 0;
        if (below >= pc.samples) return { ok: true, note: `${label} ${seen.join(' % · ')} % < ${limit} %` };
      }
      await sleep(T.pollMs);
    }
    return {
      ok: false,
      note: seen.length
        ? `${label} ${seen.slice(-3).join(' % · ')} % — не ниже ${limit} %`
        : `нет свежей метрики: ${label}`,
    };
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

  /** Следующий шаг цепочки: T1 при включённом авто — сразу, иначе предложение (T2/T3 или «Да»). */
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
            : `Предложено: ${action.title} — ждёт «Да»`,
          'escalate',
          level,
        ),
      ],
    });
    await this.notifications.push({
      severity: level === 'T3' ? 'crit' : 'warn',
      title: level === 'T3' ? `${row.title}: нужно вмешательство` : `${row.title}: ждёт «Да»`,
      body:
        level === 'T3'
          ? `${action.title} — только вручную. ${reason}.`
          : `${action.title} (${level}). ${reason}.`,
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
    await this.patchAttempt(incidentId, attemptId, (a) => ({
      ...a,
      status,
      finishedAt: iso(),
      steps: a.steps.map((s) =>
        skip.includes(s.key) && s.status === 'pending' ? { ...s, status: 'skipped' } : s,
      ),
    }));
  }

  private async appendLog(incidentId: string, attemptId: string, chunk: string): Promise<void> {
    await this.patchAttempt(incidentId, attemptId, (a) => ({
      ...a,
      log: (a.log + chunk).slice(-ATTEMPT_LOG_MAX),
    }));
  }

  private async patchAttempt(
    incidentId: string,
    attemptId: string,
    fn: (a: IncidentAttempt) => IncidentAttempt,
  ): Promise<void> {
    const row = await this.repo.findById(incidentId);
    if (!row) return;
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
      ...(result === 'helped' ? {} : { result: 'failed' as const, severity: 'warn' as const }),
      ...(by === 'auto' ? { actor: SYSTEM_ACTOR, source: 'auto' as const } : {}),
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { action: key, level: action.level, result, note },
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

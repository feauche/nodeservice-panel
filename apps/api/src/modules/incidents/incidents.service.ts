import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUTOFIX_PRESETS,
  type AutofixPresetKey,
  INCIDENT_KIND_META,
  type Incident,
  type IncidentEvent,
  type IncidentKind,
  type IncidentsListResponse,
} from '@nodeservice/shared';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { IncidentRow, ServerRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import { IncidentsSettingsStore } from '../settings/incidents-settings.store.js';
import { AUTOFIX_COMMANDS } from './autofix.registry.js';
import { IncidentsRepository } from './incidents.repository.js';

const now = () => new Date().toISOString();
const ev = (by: 'auto' | 'manual', action: string, result: IncidentEvent['result']): IncidentEvent => ({
  at: now(),
  by,
  action,
  result,
});

/** Инциденты: жизненный цикл, детекция правил, автопочинка пресетами по SSH. */
@Injectable()
export class IncidentsService {
  private readonly log = new Logger(IncidentsService.name);
  /** Момент первого превышения порога (server:kind) — для «времени реакции» без флаппинга. */
  private readonly exceededSince = new Map<string, number>();

  constructor(
    private readonly repo: IncidentsRepository,
    private readonly servers: ServersService,
    private readonly serversRepo: ServersRepository,
    private readonly ssh: SshService,
    private readonly settings: IncidentsSettingsStore,
    private readonly audit: AuditService,
  ) {}

  toDto(row: IncidentRow): Incident {
    return {
      id: row.id,
      serverId: row.serverId,
      serverName: row.serverName,
      kind: row.kind as IncidentKind,
      severity: row.severity as Incident['severity'],
      status: row.status as Incident['status'],
      title: row.title,
      detail: row.detail,
      openedAt: row.openedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: (row.resolvedBy as Incident['resolvedBy']) ?? null,
      timeline: row.timeline,
    };
  }

  async list(status: 'all' | 'open' | 'resolved'): Promise<IncidentsListResponse> {
    const rows = await this.repo.list(status);
    const open = (await this.repo.list('open')).length;
    const openRows = await this.repo.list('open');
    return {
      items: rows.map((r) => this.toDto(r)),
      counts: {
        open,
        crit: openRows.filter((r) => r.severity === 'crit').length,
        warn: openRows.filter((r) => r.severity === 'warn').length,
      },
    };
  }

  async get(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    return this.toDto(row);
  }

  async acknowledge(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row.status !== 'open') return this.toDto(row);
    const updated = await this.repo.update(id, {
      status: 'acknowledged',
      timeline: [...row.timeline, ev('manual', 'Взято в работу администратором', 'notify')],
    });
    await this.audit.record({
      action: 'incident.acknowledged',
      target: { type: 'incident', id, display: row.title },
    });
    return this.toDto(updated ?? row);
  }

  /** Ручное закрытие администратором. */
  async resolveManual(id: string): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row.status === 'resolved') return this.toDto(row);
    const updated = await this.repo.update(id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'manual',
      timeline: [...row.timeline, ev('manual', 'Закрыт администратором', 'resolved')],
    });
    if (row.serverId) this.exceededSince.delete(`${row.serverId}:${row.kind}`);
    await this.audit.record({
      action: 'incident.resolved',
      target: { type: 'incident', id, display: row.title },
      metadata: { by: 'manual' },
    });
    return this.toDto(updated ?? row);
  }

  /** Автопочинка пресетом: панель выполняет команду по SSH и дописывает таймлайн. */
  async runAutofix(id: string, preset: AutofixPresetKey, by: 'auto' | 'manual'): Promise<Incident> {
    const row = await this.repo.findById(id);
    if (!row) throw problem(HttpStatus.NOT_FOUND, { detail: 'Инцидент не найден.' });
    if (row.status === 'resolved') throw problem(HttpStatus.CONFLICT, { detail: 'Инцидент уже закрыт.' });
    if (!row.serverId)
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'У инцидента нет сервера для починки.' });
    const meta = AUTOFIX_PRESETS.find((p) => p.key === preset);
    if (!meta || !meta.kinds.includes(row.kind as IncidentKind))
      throw problem(HttpStatus.BAD_REQUEST, { detail: 'Этот пресет не подходит к инциденту.' });

    const cfg = await this.settings.get();
    if (row.lastAutofixAt && Date.now() - row.lastAutofixAt.getTime() < cfg.autofixCooldownMinutes * 60_000)
      throw problem(HttpStatus.TOO_MANY_REQUESTS, {
        detail: `Автопочинка недавно запускалась — подожди (кулдаун ${cfg.autofixCooldownMinutes} мин).`,
      });

    let result: 'applied' | 'failed' = 'failed';
    let note = '';
    try {
      const { target } = await this.servers.sshTargetFor(row.serverId);
      const session = await this.ssh.connect(target);
      try {
        const res = await session.exec(AUTOFIX_COMMANDS[preset]);
        result = res.code === 0 ? 'applied' : 'failed';
        note = (res.stderr || res.stdout).slice(-160);
      } finally {
        session.end();
      }
    } catch (err) {
      note = String((err as Error).message ?? err).slice(-160);
    }

    const updated = await this.repo.update(id, {
      lastAutofixAt: new Date(),
      timeline: [...row.timeline, ev(by, meta.title, result)],
    });
    await this.audit.record({
      action: 'incident.autofix',
      ...(result === 'failed' ? { result: 'failed' as const, severity: 'warn' as const } : {}),
      ...(by === 'auto' ? { actor: SYSTEM_ACTOR, source: 'auto' as const } : {}),
      target: { type: 'incident', id, display: row.title },
      metadata: { preset, result, ...(note ? { note } : {}) },
    });
    return this.toDto(updated ?? row);
  }

  /* ---------- детекция (джоба) ---------- */

  async evaluate(latest: {
    cpu: Map<string, number>;
    mem: Map<string, number>;
    disk: Map<string, number>;
  }): Promise<void> {
    const cfg = await this.settings.get();
    const rows = await this.serversRepo.list();
    for (const server of rows) {
      await this.evalBinary(server, 'agent_offline', server.agentStatus === 'offline');
      await this.evalBinary(server, 'ssh_down', server.sshOk === false);
      await this.evalThreshold(
        server,
        'cpu_high',
        latest.cpu.get(server.id),
        cfg.cpuPct,
        cfg.forDurationMinutes,
      );
      await this.evalThreshold(
        server,
        'mem_high',
        latest.mem.get(server.id),
        cfg.memPct,
        cfg.forDurationMinutes,
      );
      await this.evalThreshold(
        server,
        'disk_high',
        latest.disk.get(server.id),
        cfg.diskPct,
        cfg.forDurationMinutes,
      );
    }
    if (cfg.autofixEnabled) await this.autoRunFixes();
  }

  /** Мгновенное состояние (агент офлайн / SSH недоступен): без «времени реакции». */
  private async evalBinary(server: ServerRow, kind: IncidentKind, active: boolean): Promise<void> {
    const existing = await this.repo.findOpen(server.id, kind);
    if (active && !existing) await this.openIncident(server, kind, this.binaryDetail(kind));
    else if (!active && existing) await this.autoResolve(existing);
  }

  /** Пороговое состояние с «временем реакции»: держится дольше forDuration → инцидент. */
  private async evalThreshold(
    server: ServerRow,
    kind: IncidentKind,
    value: number | undefined,
    threshold: number,
    forMinutes: number,
  ): Promise<void> {
    const key = `${server.id}:${kind}`;
    const existing = await this.repo.findOpen(server.id, kind);
    if (value === undefined) {
      // Нет метрики (агент офлайн) — этим займётся agent_offline; порог не трогаем.
      this.exceededSince.delete(key);
      return;
    }
    if (value > threshold) {
      const since = this.exceededSince.get(key) ?? Date.now();
      this.exceededSince.set(key, since);
      if (!existing && Date.now() - since >= forMinutes * 60_000)
        await this.openIncident(
          server,
          kind,
          `${INCIDENT_KIND_META[kind].component} держится на ${Math.round(value)}% дольше ${forMinutes} мин.`,
        );
    } else {
      this.exceededSince.delete(key);
      if (existing) await this.autoResolve(existing);
    }
  }

  private binaryDetail(kind: IncidentKind): string {
    return kind === 'agent_offline'
      ? 'Агент не выходит на связь — панель не получает метрики.'
      : 'Панель не может подключиться к серверу по SSH.';
  }

  private async openIncident(server: ServerRow, kind: IncidentKind, detail: string): Promise<void> {
    const meta = INCIDENT_KIND_META[kind];
    const row = await this.repo.open({
      serverId: server.id,
      serverName: server.name,
      kind,
      severity: meta.severity,
      title: `${meta.label} · ${server.name}`,
      detail,
      timeline: [ev('auto', `Обнаружено: ${meta.label}`, 'detect')],
    });
    if (row)
      await this.audit.record({
        action: 'incident.opened',
        actor: SYSTEM_ACTOR,
        source: 'auto',
        severity: meta.severity === 'crit' ? 'crit' : 'warn',
        target: { type: 'incident', id: row.id, display: row.title },
        metadata: { server: server.name, kind },
      });
  }

  private async autoResolve(row: IncidentRow): Promise<void> {
    await this.repo.update(row.id, {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'auto',
      timeline: [...row.timeline, ev('auto', 'Проблема исчезла — инцидент закрыт', 'resolved')],
    });
    await this.audit.record({
      action: 'incident.resolved',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      target: { type: 'incident', id: row.id, display: row.title },
      metadata: { by: 'auto' },
    });
  }

  private async autoRunFixes(): Promise<void> {
    const cfg = await this.settings.get();
    for (const row of await this.repo.list('open')) {
      if (!row.serverId) continue;
      const preset = AUTOFIX_PRESETS.find((p) => p.kinds.includes(row.kind as IncidentKind));
      if (!preset) continue;
      if (row.lastAutofixAt && Date.now() - row.lastAutofixAt.getTime() < cfg.autofixCooldownMinutes * 60_000)
        continue;
      await this.runAutofix(row.id, preset.key, 'auto').catch((err) =>
        this.log.warn(`Автопочинка ${row.id} не удалась: ${(err as Error).message}`),
      );
    }
  }
}

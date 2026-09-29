import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Server } from '@nodeservice/shared';

import { AuditService } from '../audit/audit.service.js';
import { NotificationsService, SERVER_TOKEN } from '../notifications/notifications.service.js';
import { ServersService } from '../servers/servers.service.js';
import { egressText, egressVerdict } from './egress-check.logic.js';
import { EgressCheckService } from './egress-check.service.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

/** Сколько ждём агента после установки, прежде чем выяснять, почему он молчит. */
const PENDING_GRACE_MS = process.env.NODE_ENV === 'test' ? 0 : 3 * 60_000;

/**
 * «Ожидает агента» не должно висеть молча (случай «Казахстан-1»: агент стоял и работал, но сеть сервера
 * не пропускала трафик к панели — владелец трижды переустанавливал агента). Через 3 минуты после установки
 * панель один раз заходит на сервер (напрямую или через сервер парка, откуда он доступен) и проверяет,
 * куда он может выйти, — и пишет причину словами в колокольчик.
 */
@Injectable()
export class AgentPendingJob {
  private readonly log = new Logger(AgentPendingJob.name);
  private busy = false;
  /** Когда впервые увидели «Ожидает агента» и проверяли ли уже — до смены статуса. */
  private readonly seen = new Map<string, { since: number; checked: boolean }>();

  constructor(
    private readonly servers: ServersService,
    private readonly egress: EgressCheckService,
    private readonly blockCheck: NodeBlockCheckService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const all = await this.servers.list();
      const pending = new Set(all.filter((s) => s.agentStatus === 'pending').map((s) => s.id));
      for (const id of this.seen.keys()) if (!pending.has(id)) this.seen.delete(id);
      for (const s of all) {
        if (!pending.has(s.id)) continue;
        const st = this.seen.get(s.id) ?? { since: now, checked: false };
        this.seen.set(s.id, st);
        if (st.checked || now - st.since < PENDING_GRACE_MS) continue;
        st.checked = true;
        await this.explain(s, all).catch((err) =>
          this.log.warn(`Разбор «Ожидает агента» (${s.name}): ${err instanceof Error ? err.message : err}`),
        );
      }
    } finally {
      this.busy = false;
    }
  }

  private async explain(s: Server, all: Server[]): Promise<void> {
    // Панель сама до сервера не заходит — ищем, откуда он доступен, и заходим через тот сервер.
    const openFrom =
      s.sshOk === true
        ? []
        : (await this.blockCheck.countryReach(s.host, s.port, s.id, all))
            .filter((r) => r.open)
            .map((r) => r.from);
    const report = await this.egress.check(s, all, openFrom);
    const verdict = report ? egressVerdict(report) : 'unknown';
    const body = !report
      ? `Агент установлен, но за 3 минуты не вышел на связь, и зайти на сервер, чтобы выяснить почему, не удалось ни напрямую, ни через другие серверы парка. Проверьте сервер у хостера. На самом сервере причину покажет команда «journalctl -u nodeservice-agent -n 20 --no-pager -l».`
      : verdict === 'ok'
        ? `Агент установлен, но за 3 минуты не вышел на связь, хотя сеть сервера в порядке — до панели он доходит. Причину покажет команда на сервере «journalctl -u nodeservice-agent -n 20 --no-pager -l» (её можно выполнить в терминале панели).\n\n${egressText(report)}`
        : `Агент установлен, но не может выйти на связь: причина в сети сервера, повторная установка не поможет.\n\n${egressText(report)}`;
    await this.notifications.push({
      severity: verdict === 'ok' ? 'info' : 'warn',
      title: `Агент на ${SERVER_TOKEN} не выходит на связь`,
      server: { id: s.id, name: s.name, host: s.host },
      body,
    });
    await this.audit.record({
      action: 'server.agent.pending_explained',
      source: 'auto',
      target: { type: 'server', id: s.id, display: s.name },
      metadata: { verdict, via: report?.via ?? null },
    });
  }
}

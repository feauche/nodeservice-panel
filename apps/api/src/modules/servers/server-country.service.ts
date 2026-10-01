import { Inject, Injectable, Logger } from '@nestjs/common';
import { countryName, decideCountry, GEO_CONFIRMATIONS } from '@nodeservice/shared';

import type { ServerRow } from '../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../audit/audit.context.js';
import { AuditService } from '../audit/audit.service.js';
import { GEO_LOOKUP, type GeoLookup } from './geo.lookup.js';
import { ServersRepository } from './servers.repository.js';

type Decision =
  | { code: string; agree: number; total: number }
  | { code: null; agree: number; total: number; reason: string };

/**
 * Страна сервера по IP. Ручной выбор автоматика не трогает. Определение по запросу человека применяется сразу;
 * плановая перепроверка меняет уже определённую страну только когда другая страна подтвердилась несколько раз подряд,
 * а неудачная перепроверка не стирает прежний результат.
 */
@Injectable()
export class ServerCountryService {
  private readonly log = new Logger(ServerCountryService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly repo: ServersRepository,
    private readonly audit: AuditService,
    @Inject(GEO_LOOKUP) private readonly geo: GeoLookup,
  ) {}

  /** Запустить определение в фоне: ответ клиенту его не ждёт. */
  kick(id: string): void {
    void this.detect(id, { scheduled: false }).catch((err) =>
      this.log.warn(`Страна сервера ${id}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  async detect(id: string, opts: { scheduled: boolean }): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const row = await this.repo.findById(id);
      if (row?.countrySource !== 'auto') return;
      if (!opts.scheduled && row.countryStatus !== 'detecting')
        await this.repo.update(id, { countryStatus: 'detecting' });
      const got = await this.geo.detect(row.host);
      const decision: Decision = got.problem
        ? { code: null, agree: 0, total: got.answers.length, reason: got.problem }
        : decideCountry(got.answers);
      // За время запроса человек мог выбрать страну вручную или удалить сервер.
      const fresh = await this.repo.findById(id);
      if (fresh?.countrySource !== 'auto') return;
      await this.apply(fresh, decision, opts.scheduled);
    } catch (err) {
      const fresh = await this.repo.findById(id).catch(() => undefined);
      if (fresh && fresh.countrySource === 'auto' && fresh.countryStatus === 'detecting')
        await this.repo.update(id, {
          countryStatus: fresh.country ? 'ok' : 'failed',
          countryNote: 'Определение прервалось из-за ошибки панели.',
        });
      throw err;
    } finally {
      this.running.delete(id);
    }
  }

  private async apply(row: ServerRow, d: Decision, scheduled: boolean): Promise<void> {
    const now = new Date();
    const prev = row.country;
    if (d.code === null) {
      // Плановая проверка не стирает то, что уже определено: ответили не все источники, это не смена страны.
      if (scheduled && row.country && row.countryStatus === 'ok') {
        await this.repo.update(row.id, { countryCheckedAt: now });
        return;
      }
      await this.repo.update(row.id, {
        countryStatus: 'failed',
        countryAgree: d.total > 0 ? d.agree : null,
        countryTotal: d.total > 0 ? d.total : null,
        countryCheckedAt: now,
        countryNote: d.reason,
      });
      return;
    }
    const base = {
      countryStatus: 'ok',
      countryAgree: d.agree,
      countryTotal: d.total,
      countryCheckedAt: now,
      countryNote: null,
    } as const;
    if (!row.country || row.country === d.code || !scheduled) {
      await this.repo.update(row.id, {
        ...base,
        country: d.code,
        countryCandidate: null,
        countryCandidateCount: 0,
      });
      if (prev !== d.code) await this.record(row, d.code, d, prev ? 'changed' : 'detected', prev);
      return;
    }
    // Другая страна при плановой проверке: применяем после подтверждения подряд.
    const count = row.countryCandidate === d.code ? row.countryCandidateCount + 1 : 1;
    if (count >= GEO_CONFIRMATIONS) {
      await this.repo.update(row.id, {
        ...base,
        country: d.code,
        countryCandidate: null,
        countryCandidateCount: 0,
      });
      await this.record(row, d.code, d, 'changed', prev);
    } else {
      await this.repo.update(row.id, {
        countryCheckedAt: now,
        countryCandidate: d.code,
        countryCandidateCount: count,
      });
    }
  }

  private async record(
    row: ServerRow,
    to: string,
    d: { agree: number; total: number },
    kind: 'detected' | 'changed',
    from: string | null,
  ): Promise<void> {
    await this.audit.record({
      action: `server.country.${kind}`,
      severity: kind === 'changed' ? 'warn' : 'info',
      source: 'auto',
      actor: SYSTEM_ACTOR,
      target: { type: 'server', id: row.id, display: row.name },
      metadata: {
        ...(from ? { from, fromName: countryName(from) } : {}),
        to,
        toName: countryName(to),
        agree: d.agree,
        total: d.total,
      },
    });
  }
}

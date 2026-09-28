import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { TelegramService } from '../notifications/telegram/telegram.service.js';
import { IncidentsRepository } from './incidents.repository.js';

/**
 * «Напоминать о нерешённом критичном» (Telegram): раз в 5 минут смотрим открытые критичные инциденты;
 * если с последнего сообщения по нему прошло больше выбранного числа часов — напоминание ответом на
 * исходное сообщение. Отсчёт — от последнего сообщения в Telegram, поэтому перезапуск панели не дублирует.
 */
@Injectable()
export class IncidentReminderJob {
  private readonly log = new Logger(IncidentReminderJob.name);

  constructor(
    private readonly repo: IncidentsRepository,
    private readonly telegram: TelegramService,
  ) {}

  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run().catch((err) => this.log.warn(`Напоминания: ${(err as Error).message}`));
  }

  async run(): Promise<void> {
    const hours = await this.telegram.remindHours();
    if (hours === null) return;
    const due = Date.now() - hours * 3_600_000;
    for (const row of await this.repo.list('open')) {
      if (row.severity !== 'crit') continue;
      const last = await this.telegram.lastMessageAt(row.id);
      // Ни одного сообщения не было (вид выключен или чатов не было) — напоминать не о чем.
      if (!last || last.getTime() > due) continue;
      const openH = Math.max(1, Math.round((Date.now() - row.openedAt.getTime()) / 3_600_000));
      await this.telegram.dispatch({
        event: 'reminder',
        kind: row.kind as never,
        incidentId: row.id,
        title: `Всё ещё не решено: ${row.title}`,
        body: `Открыт ${openH} ч назад.`,
        link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
      });
      await this.telegram.markReminded(row.id);
    }
  }
}

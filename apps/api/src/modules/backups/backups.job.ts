import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { BackupsService } from './backups.service.js';

/** Раз в минуту: не пора ли сделать копию по расписанию (время — по часовому поясу панели). */
@Injectable()
export class BackupsJob {
  private readonly log = new Logger(BackupsJob.name);

  constructor(private readonly backups: BackupsService) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    // Ошибка до запуска копии (база, настройки) иначе пропадала бы бесследно, и расписание тихо вставало.
    await this.backups.tick().catch((e: unknown) => {
      this.log.error(`Проверка расписания копий не удалась: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import type { Env } from '../../config/env.schema.js';
import { PanelAlertsService } from './panel-alerts.service.js';

/** Мало места: свободно меньше этой доли раздела… */
export const DISK_LOW_SHARE = 0.1;
/** …или меньше этого в байтах (10 % маленького диска — слишком мало). */
export const DISK_LOW_BYTES = 2 * 1024 ** 3;

type StatFs = { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint };

/**
 * Место на разделе данных сервера панели — раз в 10 минут. Раньше его было видно только на странице копий:
 * когда место кончалось, панель переставала сохранять данные молча. Смотрим папку копий и, в контейнере, раздел
 * с данными Docker (база, метрики, образы, журналы контейнеров) — это может быть другой диск. Не удалось
 * посмотреть — ничего не утверждаем. Мало места — оповещение (не чаще раза в сутки, пока не исправлено).
 */
@Injectable()
export class PanelDiskJob implements OnApplicationBootstrap {
  private readonly log = new Logger(PanelDiskJob.name);
  private readonly paths: string[];
  /** Свойством, а не импортом: модульные тесты подменяют раздел. */
  statfs: (path: string) => Promise<StatFs> = (path) => statfs(path);

  constructor(
    config: ConfigService<Env, true>,
    private readonly alerts: PanelAlertsService,
  ) {
    const host = config.get('HOST_ROOT');
    this.paths = [
      resolve(config.get('BACKUPS_DIR')),
      ...(host ? [resolve(join(host, 'var/lib/docker'))] : []),
    ];
  }

  /** Первая проверка — через минуту после запуска: панель, которая падает из-за нехватки места, 10 минут не живёт. */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.tick(), 60_000).unref?.();
  }

  @Interval(10 * 60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.check().catch((err) => this.log.warn(`Проверка места: ${(err as Error).message}`));
  }

  async check(now = new Date()): Promise<void> {
    let low: { freeBytes: number; totalBytes: number } | null = null;
    for (const path of this.paths) {
      const fs = await this.statfs(path).catch(() => null);
      if (!fs || Number(fs.blocks) <= 0) continue;
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      const totalBytes = Number(fs.blocks) * Number(fs.bsize);
      if (freeBytes >= DISK_LOW_BYTES && freeBytes / totalBytes >= DISK_LOW_SHARE) continue;
      if (!low || freeBytes < low.freeBytes) low = { freeBytes, totalBytes };
    }
    if (low) await this.alerts.diskLow(low, now);
  }
}

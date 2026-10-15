import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { DB, type Db } from '../../infra/db/db.module.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { PanelPulse } from './panel-pulse.js';

/** Таймаут каждой зависимости: зависшая база не должна блокировать ответ готовности. */
export const READY_CHECK_TIMEOUT_MS = 3_000;
/** Поиск инцидентов идёт раз в 30 с; не отрабатывал дольше — встал, и сбои на серверах никто не замечает. */
export const INCIDENTS_SILENT_MAX_MS = 3 * 60_000;

export interface ReadyCheck {
  ok: boolean;
  /** Сколько заняла проверка, мс (для базы, Valkey и хранилища метрик). */
  ms?: number;
  /** Для поиска инцидентов: сколько секунд назад он отработал. */
  silentSec?: number;
  /** Что не так — коротко, по-русски, без адресов и текста ошибки (он — только в лог). */
  problem?: string;
}
export type ReadyChecks = Record<'postgres' | 'valkey' | 'incidents', ReadyCheck>;
export interface ReadyState {
  ok: boolean;
  checks: ReadyChecks;
  /** Что не так, по-русски, в порядке проверок; пусто — панель готова. */
  problems: string[];
}

/**
 * Панель действительно работает: отвечают база и Valkey, а поиск инцидентов отработал за последние 3 минуты.
 * Одна проверка на двоих — для /api/health/ready и для сигнала «панель жива» внешнему сервису.
 */
@Injectable()
export class PanelReadiness {
  private readonly log = new Logger(PanelReadiness.name);
  /** Свойством, а не константой: модульные тесты сокращают ожидание зависшей части. */
  timeoutMs = READY_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly pulse: PanelPulse,
  ) {}

  async check(): Promise<ReadyState> {
    const [postgres, valkey] = await Promise.all([
      this.part('база данных не отвечает', async () => {
        await this.db.execute(sql`select 1`);
      }),
      this.part('хранилище сессий не отвечает', async () => {
        const pong = await this.valkey.ping();
        if (pong !== 'PONG') throw new Error(`Valkey ответил "${pong}"`);
      }),
    ]);
    const silent = this.pulse.incidentsSilentMs();
    const incidents: ReadyCheck =
      silent <= INCIDENTS_SILENT_MAX_MS
        ? { ok: true, silentSec: Math.round(silent / 1000) }
        : {
            ok: false,
            silentSec: Math.round(silent / 1000),
            problem: `поиск инцидентов не отрабатывал ${Math.floor(silent / 60_000)} мин`,
          };
    const checks = { postgres, valkey, incidents };
    const problems = Object.values(checks).flatMap((c) => (c.problem ? [c.problem] : []));
    return { ok: problems.length === 0, checks, problems };
  }

  /** Одна часть: успела и не упала — в порядке; иначе — `problem`, а причина как есть — в лог. */
  private async part(problemText: string, run: () => Promise<void>): Promise<ReadyCheck> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`нет ответа за ${this.timeoutMs} мс`)), this.timeoutMs);
          timer.unref?.();
        }),
      ]);
      return { ok: true, ms: Math.round(performance.now() - started) };
    } catch (err) {
      this.log.warn(`Готовность: ${problemText} (${err instanceof Error ? err.message : String(err)})`);
      return { ok: false, ms: Math.round(performance.now() - started), problem: problemText };
    } finally {
      clearTimeout(timer);
    }
  }
}

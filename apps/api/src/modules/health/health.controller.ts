import { Controller, Get, HttpStatus, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { Public } from '../auth/auth.decorators.js';
import { PanelPulse } from './panel-pulse.js';

/** Тип ответа 503 «панель не готова»: по нему и по `detail` сторож панели понимает, что не так. */
export const NOT_READY_PROBLEM = 'urn:nodeservice:problem:not-ready';
/** Сколько ждём каждую часть: сторож ждёт весь ответ 10 с — зависшая база не должна съесть их все. */
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
export interface ReadyReport {
  status: 'ok';
  checks: Record<'postgres' | 'valkey' | 'metrics' | 'incidents', ReadyCheck>;
}

/**
 * /api/health/live — процесс жив (для Docker healthcheck, без зависимостей).
 * /api/health/ready — панель действительно работает: отвечают база, Valkey и хранилище метрик, а поиск
 * инцидентов отработал за последние 3 минуты. Иначе 503 с перечнем того, что не так (его читает сторож
 * панели на сервере парка и пересказывает в Telegram).
 */
@Public()
@ApiExcludeController()
@Controller('health')
export class HealthController {
  private readonly log = new Logger(HealthController.name);
  private readonly vmUrl: string;
  /** Свойством, а не константой: модульные тесты сокращают ожидание зависшей части. */
  timeoutMs = READY_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
    config: ConfigService<Env, true>,
    private readonly pulse: PanelPulse,
  ) {
    this.vmUrl = config.get('VM_URL');
  }

  @Get('live')
  live(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(): Promise<ReadyReport> {
    const [postgres, valkey, metrics] = await Promise.all([
      this.check('база данных не отвечает', async () => {
        await this.db.execute(sql`select 1`);
      }),
      this.check('хранилище сессий не отвечает', async () => {
        const pong = await this.valkey.ping();
        if (pong !== 'PONG') throw new Error(`Valkey ответил "${pong}"`);
      }),
      this.check('хранилище метрик не отвечает', async () => {
        const res = await fetch(`${this.vmUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`VictoriaMetrics ответила ${res.status}`);
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
    const checks = { postgres, valkey, metrics, incidents };
    const problems = Object.values(checks).flatMap((c) => (c.problem ? [c.problem] : []));
    if (problems.length > 0)
      throw problem(HttpStatus.SERVICE_UNAVAILABLE, {
        type: NOT_READY_PROBLEM,
        detail: problems.join('; '),
        extensions: { problems, checks },
      });
    return { status: 'ok', checks };
  }

  /** Одна часть: успела и не упала — в порядке; иначе — `problem`, а причина как есть — в лог. */
  private async check(problemText: string, run: () => Promise<void>): Promise<ReadyCheck> {
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

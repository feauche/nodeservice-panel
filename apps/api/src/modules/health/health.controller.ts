import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { DB, type Db } from '../../infra/db/db.module.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { Public } from '../auth/auth.decorators.js';

/**
 * /api/health/live — процесс жив (для Docker healthcheck, без зависимостей).
 * /api/health/ready — готов обслуживать: БД и Valkey отвечают.
 */
@Public()
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(DB) private readonly db: Db,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  @Get('live')
  live(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.checkDb(), () => this.checkValkey()]);
  }

  private async checkDb(): Promise<HealthIndicatorResult> {
    const started = performance.now();
    await this.db.execute(sql`select 1`);
    return { postgres: { status: 'up', latencyMs: Math.round(performance.now() - started) } };
  }

  private async checkValkey(): Promise<HealthIndicatorResult> {
    const started = performance.now();
    const pong = await this.valkey.ping();
    if (pong !== 'PONG') throw new Error(`Valkey ответил "${pong}"`);
    return { valkey: { status: 'up', latencyMs: Math.round(performance.now() - started) } };
  }
}

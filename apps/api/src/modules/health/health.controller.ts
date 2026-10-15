import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { problem } from '../../common/filters/problem-details.filter.js';
import { Public } from '../auth/auth.decorators.js';
import { PanelReadiness, type ReadyChecks } from './panel-readiness.js';

export {
  INCIDENTS_SILENT_MAX_MS,
  READY_CHECK_TIMEOUT_MS,
  type ReadyCheck,
} from './panel-readiness.js';

/** Тип ответа 503 «панель не готова»: detail описывает отказавшие зависимости. */
export const NOT_READY_PROBLEM = 'urn:nodeservice:problem:not-ready';

export interface ReadyReport {
  status: 'ok';
  checks: ReadyChecks;
}

/**
 * /api/health/live — процесс жив (для Docker healthcheck, без зависимостей).
 * /api/health/ready — панель действительно работает: отвечают база, Valkey и хранилище метрик, а поиск
 * инцидентов отработал за последние 3 минуты. Иначе 503 с перечнем отказавших зависимостей.
 */
@Public()
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: PanelReadiness) {}

  @Get('live')
  live(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(): Promise<ReadyReport> {
    const { checks, problems } = await this.readiness.check();
    if (problems.length > 0)
      throw problem(HttpStatus.SERVICE_UNAVAILABLE, {
        type: NOT_READY_PROBLEM,
        detail: problems.join('; '),
        extensions: { problems, checks },
      });
    return { status: 'ok', checks };
  }
}

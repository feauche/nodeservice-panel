import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type ServerCheckRun, serverCheckRunSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { CheckExplainService } from './check-explain.service.js';

class ServerCheckRunDto extends createZodDto(serverCheckRunSchema) {}

@ApiTags('server-checks')
@ApiCookieAuth()
@Controller('servers/:id/checks/runs/:runId/explain')
export class CheckExplainController {
  constructor(private readonly explainer: CheckExplainService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Джарвис пересказывает итог проверки простыми словами (сохраняется у запуска)' })
  @ApiOkResponse({ type: ServerCheckRunDto })
  explain(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<ServerCheckRun> {
    return this.explainer.explain(id, runId);
  }
}

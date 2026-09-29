import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type EgressResponse, egressResponseSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { serverProblems } from '../servers/servers.problems.js';
import { ServersService } from '../servers/servers.service.js';
import { egressDto } from './egress-check.logic.js';
import { EgressCheckService } from './egress-check.service.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

export class EgressResponseDto extends createZodDto(egressResponseSchema) {}

/** «Куда сервер может выйти» в окне сервера: последний результат и «Проверить снова». */
@ApiTags('servers')
@ApiCookieAuth()
@Controller('servers/:id/egress')
export class EgressController {
  constructor(
    private readonly egress: EgressCheckService,
    private readonly servers: ServersService,
    private readonly blockCheck: NodeBlockCheckService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Последняя проверка «куда сервер может выйти» (null — ещё не проверяли)' })
  @ApiOkResponse({ type: EgressResponseDto })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<EgressResponse> {
    const server = (await this.servers.list()).find((s) => s.id === id);
    if (!server) throw serverProblems.notFound();
    const last = this.egress.lastFor(id);
    return { report: last ? egressDto(last.value, last.at, server.host) : null };
  }

  @Post()
  @HttpCode(200)
  @Audit('server.egress.checked')
  @ApiOperation({
    summary: 'Проверить сейчас: зайти на сервер (напрямую или через сервер парка) и проверить выход наружу',
  })
  @ApiOkResponse({ type: EgressResponseDto })
  async run(@Param('id', ParseUUIDPipe) id: string): Promise<EgressResponse> {
    const all = await this.servers.list();
    const server = all.find((s) => s.id === id);
    if (!server) throw serverProblems.notFound();
    // Панель сама до сервера не заходит — ищем, откуда он доступен, и заходим через тот сервер.
    const openFrom =
      server.sshOk === true
        ? []
        : (await this.blockCheck.countryReach(server.host, server.port, server.id, all))
            .filter((r) => r.open)
            .map((r) => r.from);
    const report = await this.egress.check(server, all, openFrom, { force: true });
    const last = this.egress.lastFor(id);
    return { report: report && last ? egressDto(last.value, last.at, server.host) : null };
  }
}

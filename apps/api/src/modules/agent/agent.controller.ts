import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../auth/auth.decorators.js';
import {
  AgentEnrollRequestDto,
  AgentEnrollResponseDto,
  AgentPulseRequestDto,
  AgentPulseResponseDto,
} from './agent.dto.js';
import { AgentService } from './agent.service.js';
import { AgentPulseLimiter } from './agent-pulse.limiter.js';
import { VpnProbeTargetService } from './vpn-probe-target.service.js';

/**
 * API для агентов: без cookie-сессий и CSRF (setup-http исключает /api/agent/),
 * аутентификация — одноразовый токен (enroll) и подпись ed25519 (WebSocket).
 */
@ApiTags('agent')
@Public()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly pulseLimiter: AgentPulseLimiter,
    private readonly probeTarget: VpnProbeTargetService,
  ) {}

  @Post('v1/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Энроллмент агента: одноразовый токен → привязка ключа (TOFU)' })
  @ApiOkResponse({ type: AgentEnrollResponseDto })
  enroll(@Body() body: AgentEnrollRequestDto): Promise<AgentEnrollResponseDto> {
    return this.agents.enroll(body);
  }

  @Post('v1/pulse')
  @HttpCode(200)
  @ApiOperation({ summary: 'Запасной HTTPS heartbeat и метрики с подписью агента' })
  @ApiOkResponse({ type: AgentPulseResponseDto })
  pulse(@Req() req: Request, @Body() body: AgentPulseRequestDto): Promise<AgentPulseResponseDto> {
    this.pulseLimiter.assertAllowed(req.ip ?? req.socket.remoteAddress ?? '');
    return this.agents.pulse(body);
  }

  /** Одноразовые 64 КБ: проба успешна, только если эти данные пришли через VPN-маршрут. */
  @Get('v1/probe-target')
  probeDownload(@Query('token') token: string, @Res() response: Response): void {
    if (!this.probeTarget.consume(token ?? '')) {
      response.status(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-NodeService-Probe', 'v1');
    response.status(200).send(Buffer.alloc(64 << 10, 0x4e));
  }
}

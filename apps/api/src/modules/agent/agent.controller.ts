import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/auth.decorators.js';
import {
  AgentEnrollRequestDto,
  AgentEnrollResponseDto,
  AgentPulseRequestDto,
  AgentPulseResponseDto,
} from './agent.dto.js';
import { AgentService } from './agent.service.js';
import { AgentPulseLimiter } from './agent-pulse.limiter.js';

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
}

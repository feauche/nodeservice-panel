import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/auth.decorators.js';
import { AgentEnrollRequestDto, AgentEnrollResponseDto } from './agent.dto.js';
import { AgentService } from './agent.service.js';

/**
 * API для агентов: без cookie-сессий и CSRF (setup-http исключает /api/agent/),
 * аутентификация — одноразовый токен (enroll) и подпись ed25519 (WebSocket).
 */
@ApiTags('agent')
@Public()
@Controller('agent')
export class AgentController {
  constructor(private readonly agents: AgentService) {}

  @Post('v1/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Энроллмент агента: одноразовый токен → привязка ключа (TOFU)' })
  @ApiOkResponse({ type: AgentEnrollResponseDto })
  enroll(@Body() body: AgentEnrollRequestDto): Promise<AgentEnrollResponseDto> {
    return this.agents.enroll(body);
  }
}

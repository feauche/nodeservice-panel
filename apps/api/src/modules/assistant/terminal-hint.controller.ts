import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { terminalHintRequestSchema, terminalHintResponseSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { TerminalHintService } from './terminal-hint.service.js';

export class TerminalHintRequestDto extends createZodDto(terminalHintRequestSchema) {}
export class TerminalHintResponseDto extends createZodDto(terminalHintResponseSchema) {}

@ApiTags('terminal')
@ApiCookieAuth()
@Controller('servers')
export class TerminalHintController {
  constructor(private readonly hints: TerminalHintService) {}

  @Post(':id/terminal/hint')
  @HttpCode(200)
  @ApiOperation({ summary: 'Подсказка ассистента к выводу терминала: объяснение и команды для вставки' })
  @ApiOkResponse({ type: TerminalHintResponseDto })
  hint(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TerminalHintRequestDto,
  ): Promise<TerminalHintResponseDto> {
    return this.hints.hint(id, body);
  }
}

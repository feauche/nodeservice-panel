import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assistantChatRequestSchema,
  assistantChatResponseSchema,
  assistantConversationsResponseSchema,
  assistantHistoryResponseSchema,
  assistantStatusSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { AssistantService } from './assistant.service.js';

export class AssistantStatusDto extends createZodDto(assistantStatusSchema) {}
export class AssistantChatRequestDto extends createZodDto(assistantChatRequestSchema) {}
export class AssistantChatResponseDto extends createZodDto(assistantChatResponseSchema) {}
export class AssistantConversationsResponseDto extends createZodDto(assistantConversationsResponseSchema) {}
export class AssistantHistoryResponseDto extends createZodDto(assistantHistoryResponseSchema) {}

@ApiTags('assistant')
@ApiCookieAuth()
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('status')
  @ApiOperation({ summary: 'Доступен ли Джарвис (задан ли ключ) и модель' })
  @ApiOkResponse({ type: AssistantStatusDto })
  status(): Promise<AssistantStatusDto> {
    return this.assistant.status();
  }

  @Get('conversations')
  @ApiOperation({ summary: 'История бесед' })
  @ApiOkResponse({ type: AssistantConversationsResponseDto })
  async conversations(): Promise<AssistantConversationsResponseDto> {
    return { items: await this.assistant.conversations() };
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Сообщения беседы' })
  @ApiOkResponse({ type: AssistantHistoryResponseDto })
  async history(@Param('id', ParseUUIDPipe) id: string): Promise<AssistantHistoryResponseDto> {
    return { items: await this.assistant.history(id) };
  }

  @Post('chat')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отправить сообщение Джарвису (tool-use, предложения действий)' })
  @ApiOkResponse({ type: AssistantChatResponseDto })
  chat(@Body() body: AssistantChatRequestDto): Promise<AssistantChatResponseDto> {
    return this.assistant.chat(body.message, body.conversationId, body.mode);
  }
}

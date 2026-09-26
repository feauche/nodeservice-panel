import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { assistantChangeSchema, assistantChangesSummarySchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ChangesService } from './changes.service.js';

export class AssistantChangeDto extends createZodDto(assistantChangeSchema) {}
export class AssistantChangesSummaryDto extends createZodDto(assistantChangesSummarySchema) {}
class SummaryQueryDto extends createZodDto(
  z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
) {}

@ApiTags('assistant')
@ApiCookieAuth()
@Controller('assistant/changes')
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  // Статический маршрут раньше `:id`, иначе ParseUUIDPipe отвергнет «summary».
  @Get('summary')
  @ApiOperation({ summary: 'Сколько изменений по предложениям Джарвиса применено, отменено, отклонено' })
  @ApiOkResponse({ type: AssistantChangesSummaryDto })
  summary(@Query() q: SummaryQueryDto): Promise<AssistantChangesSummaryDto> {
    return this.changes.summary(q.days);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Изменение по предложению Джарвиса: превью, состояние, итог' })
  @ApiOkResponse({ type: AssistantChangeDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AssistantChangeDto> {
    return this.changes.get(id);
  }

  @Post(':id/apply')
  @HttpCode(200)
  @ApiOperation({ summary: 'Применить изменение: проверка состояния, применение, проверка результата' })
  @ApiOkResponse({ type: AssistantChangeDto })
  apply(@Param('id', ParseUUIDPipe) id: string): Promise<AssistantChangeDto> {
    return this.changes.apply(id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отклонить предложение' })
  @ApiOkResponse({ type: AssistantChangeDto })
  reject(@Param('id', ParseUUIDPipe) id: string): Promise<AssistantChangeDto> {
    return this.changes.reject(id);
  }

  @Post(':id/revert')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отменить применённое изменение (вернуть прежнее значение)' })
  @ApiOkResponse({ type: AssistantChangeDto })
  revert(@Param('id', ParseUUIDPipe) id: string): Promise<AssistantChangeDto> {
    return this.changes.revert(id);
  }
}

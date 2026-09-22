import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  kbDocCreateSchema,
  kbDocSchema,
  kbDocUpdateSchema,
  kbListQuerySchema,
  kbListResponseSchema,
  kbVersionsResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { KnowledgeService } from './knowledge.service.js';

export class KbListQueryDto extends createZodDto(kbListQuerySchema) {}
export class KbListResponseDto extends createZodDto(kbListResponseSchema) {}
export class KbDocDto extends createZodDto(kbDocSchema) {}
export class KbDocCreateDto extends createZodDto(kbDocCreateSchema) {}
export class KbDocUpdateDto extends createZodDto(kbDocUpdateSchema) {}
export class KbVersionsResponseDto extends createZodDto(kbVersionsResponseSchema) {}

@ApiTags('knowledge')
@ApiCookieAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

  @Get()
  @ApiOperation({ summary: 'Список статей базы знаний (поиск, архив)' })
  @ApiOkResponse({ type: KbListResponseDto })
  async list(@Query() query: KbListQueryDto): Promise<KbListResponseDto> {
    return { items: await this.kb.list(query.q, query.archived) };
  }

  @Post()
  @ApiOperation({ summary: 'Создать статью' })
  @ApiOkResponse({ type: KbDocDto })
  create(@Body() body: KbDocCreateDto): Promise<KbDocDto> {
    return this.kb.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Одна статья' })
  @ApiOkResponse({ type: KbDocDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<KbDocDto> {
    return this.kb.get(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Изменить статью (в т.ч. архивировать)' })
  @ApiOkResponse({ type: KbDocDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: KbDocUpdateDto): Promise<KbDocDto> {
    return this.kb.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить статью' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.kb.remove(id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'История версий статьи' })
  @ApiOkResponse({ type: KbVersionsResponseDto })
  async versions(@Param('id', ParseUUIDPipe) id: string): Promise<KbVersionsResponseDto> {
    return { items: await this.kb.versions(id) };
  }

  @Post(':id/versions/:versionId/revert')
  @HttpCode(200)
  @ApiOperation({ summary: 'Откатить статью к версии' })
  @ApiOkResponse({ type: KbDocDto })
  revert(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<KbDocDto> {
    return this.kb.revert(id, versionId);
  }
}

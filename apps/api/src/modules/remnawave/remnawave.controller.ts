import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { remnawaveConnectRequestSchema, remnawaveStatusSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { RemnawaveService } from './remnawave.service.js';

export class RemnawaveStatusDto extends createZodDto(remnawaveStatusSchema) {}
export class RemnawaveConnectRequestDto extends createZodDto(remnawaveConnectRequestSchema) {}

@ApiTags('remnawave')
@ApiCookieAuth()
@Controller('remnawave')
export class RemnawaveController {
  constructor(private readonly remnawave: RemnawaveService) {}

  @Get('status')
  @ApiOperation({ summary: 'Подключение к Remnawave: сводка, ноды, сертификат панели' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  status(): Promise<RemnawaveStatusDto> {
    return this.remnawave.status();
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Подключить Remnawave: проверить домен и токен, сохранить при успехе' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  connect(@Body() body: RemnawaveConnectRequestDto): Promise<RemnawaveStatusDto> {
    return this.remnawave.connect(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Обновить данные Remnawave прямо сейчас' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  refresh(): Promise<RemnawaveStatusDto> {
    return this.remnawave.refresh();
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Отключить Remnawave (стереть домен и токен)' })
  disconnect(): Promise<void> {
    return this.remnawave.disconnect();
  }
}

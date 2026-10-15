import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type HeartbeatTestResponse,
  type HeartbeatView,
  heartbeatSettingsSchema,
  heartbeatTestRequestSchema,
  heartbeatTestResponseSchema,
  heartbeatViewSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { HeartbeatService, hostOf } from './heartbeat.service.js';

class HeartbeatViewDto extends createZodDto(heartbeatViewSchema) {}
class HeartbeatSettingsDto extends createZodDto(heartbeatSettingsSchema) {}
class HeartbeatTestRequestDto extends createZodDto(heartbeatTestRequestSchema) {}
class HeartbeatTestResponseDto extends createZodDto(heartbeatTestResponseSchema) {}

const TARGET = { type: 'settings', id: 'heartbeat', display: 'Сигнал «панель жива»' } as const;

/** «Настройки → Уведомления»: адрес внешнего сервиса проверки и что было с сигналом. */
@ApiTags('settings')
@ApiCookieAuth()
@Controller('settings/heartbeat')
export class HeartbeatController {
  constructor(
    private readonly heartbeat: HeartbeatService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Адрес сигнала «панель жива» и итоги последних сигналов' })
  @ApiOkResponse({ type: HeartbeatViewDto })
  get(): Promise<HeartbeatView> {
    return this.heartbeat.view();
  }

  @Put()
  @Audit('settings.heartbeat.updated', { target: TARGET })
  @ApiOperation({ summary: 'Сохранить адрес сервиса проверки (пустой — выключить сигнал)' })
  @ApiOkResponse({ type: HeartbeatViewDto })
  async update(@Body() body: HeartbeatSettingsDto): Promise<HeartbeatView> {
    const { view, before, after } = await this.heartbeat.update(body);
    // Сам адрес в Журнал не пишем: в пути у сервисов секретный ключ. Только что произошло и хост.
    const state =
      before === after ? 'без изменений' : !before ? 'адрес задан' : !after ? 'адрес убран' : 'адрес сменён';
    this.audit.extend({ metadata: { state, host: after ? hostOf(after) : hostOf(before) } });
    return view;
  }

  @Post('test')
  @HttpCode(200)
  @Audit('settings.heartbeat.test', { target: TARGET })
  @ApiOperation({ summary: 'Отправить один сигнал сейчас — на переданный или сохранённый адрес' })
  @ApiOkResponse({ type: HeartbeatTestResponseDto })
  async test(@Body() body: HeartbeatTestRequestDto): Promise<HeartbeatTestResponse> {
    const { host, ...res } = await this.heartbeat.test(body.url);
    this.audit.extend({
      metadata: { ok: res.ok, host, httpStatus: res.httpStatus ?? '—', problem: res.problem ?? '—' },
    });
    return res;
  }
}

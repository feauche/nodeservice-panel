import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { StepUpGuard } from '../security/step-up.guard.js';
import { PanelKeyService } from './panel-key.service.js';
import {
  CreateServerRequestDto,
  EnrollmentTokenResponseDto,
  PanelKeyResponseDto,
  ReorderServersRequestDto,
  ServerDto,
  ServersResponseDto,
  TestConnectionRequestDto,
  TestConnectionResponseDto,
  TrustHostKeyRequestDto,
  UpdateServerRequestDto,
} from './servers.dto.js';
import { ServersService } from './servers.service.js';

@ApiTags('servers')
@ApiCookieAuth()
@Controller('servers')
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly panelKey: PanelKeyService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Список серверов' })
  @ApiOkResponse({ type: ServersResponseDto })
  async list(): Promise<ServersResponseDto> {
    return { items: await this.servers.list() };
  }

  @Get('panel-key')
  @ApiOperation({ summary: 'Публичный SSH-ключ панели (для ручной установки в authorized_keys)' })
  @ApiOkResponse({ type: PanelKeyResponseDto })
  async publicKey(): Promise<PanelKeyResponseDto> {
    return { publicKey: await this.panelKey.publicKeyLine() };
  }

  @Post('test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Проверить SSH-доступы до создания (ничего не сохраняет)' })
  @ApiOkResponse({ type: TestConnectionResponseDto })
  test(@Body() body: TestConnectionRequestDto): Promise<TestConnectionResponseDto> {
    return this.servers.testConnection(body);
  }

  @Post()
  @ApiOperation({ summary: 'Добавить сервер: подключение, факты, ключ панели, TOFU host key' })
  @ApiOkResponse({ type: ServerDto })
  create(@Body() body: CreateServerRequestDto): Promise<ServerDto> {
    return this.servers.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Один сервер' })
  @ApiOkResponse({ type: ServerDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return this.servers.get(id);
  }

  @Post('reorder')
  @HttpCode(200)
  @ApiOperation({ summary: 'Задать порядок карточек серверов (drag-and-drop)' })
  @ApiOkResponse({ type: ServersResponseDto })
  async reorder(@Body() body: ReorderServersRequestDto): Promise<ServersResponseDto> {
    return { items: await this.servers.reorder(body.ids) };
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Дублировать сервер: копия записи, имя получает номер (-2, -3, …)' })
  @ApiOkResponse({ type: ServerDto })
  duplicate(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return this.servers.duplicate(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Изменить сервер (смена адреса сбрасывает отпечаток host key)' })
  @ApiOkResponse({ type: ServerDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateServerRequestDto): Promise<ServerDto> {
    return this.servers.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Удалить сервер (step-up)' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.servers.delete(id);
  }

  @Post(':id/check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Проверить связь по SSH и обновить факты' })
  @ApiOkResponse({ type: ServerDto })
  check(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return this.servers.check(id);
  }

  @Post(':id/trust-host-key')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Доверять новому отпечатку host key (после переустановки сервера; step-up)' })
  @ApiOkResponse({ type: ServerDto })
  trust(@Param('id', ParseUUIDPipe) id: string, @Body() body: TrustHostKeyRequestDto): Promise<ServerDto> {
    return this.servers.trustHostKey(id, body.fingerprint);
  }

  @Post(':id/agent/install')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @ApiOperation({
    summary: 'Установить агента: панель заходит по SSH и выполняет скрипт из релизов (step-up)',
  })
  @ApiOkResponse({ type: ServerDto })
  installAgent(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return this.servers.installAgent(id);
  }

  @Post(':id/enrollment-token')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Выпустить токен подключения агента (step-up); установка агента — этап 5' })
  @ApiOkResponse({ type: EnrollmentTokenResponseDto })
  enrollmentToken(@Param('id', ParseUUIDPipe) id: string): Promise<EnrollmentTokenResponseDto> {
    return this.servers.issueEnrollmentToken(id);
  }
}

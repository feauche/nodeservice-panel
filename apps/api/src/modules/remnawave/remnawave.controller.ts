import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  remnawaveConnectRequestSchema,
  remnawaveStatusSchema,
  remnawaveTopologySchema,
  remnawaveVpnProbeRequestSchema,
  remnawaveVpnProbeStatusSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { RemnawaveService } from './remnawave.service.js';
import { RemnawaveTopologyService } from './remnawave-topology.service.js';
import { RemnawaveVpnProbeService } from './remnawave-vpn-probe.service.js';

export class RemnawaveStatusDto extends createZodDto(remnawaveStatusSchema) {}
export class RemnawaveConnectRequestDto extends createZodDto(remnawaveConnectRequestSchema) {}
export class RemnawaveVpnProbeRequestDto extends createZodDto(remnawaveVpnProbeRequestSchema) {}
export class RemnawaveVpnProbeStatusDto extends createZodDto(remnawaveVpnProbeStatusSchema) {}
export class RemnawaveTopologyDto extends createZodDto(remnawaveTopologySchema) {}

@ApiTags('remnawave')
@ApiCookieAuth()
@Controller('remnawave')
export class RemnawaveController {
  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly vpnProbe: RemnawaveVpnProbeService,
    private readonly topologyService: RemnawaveTopologyService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Подключение к Remnawave: сводка, ноды, сертификат панели' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  async status(): Promise<RemnawaveStatusDto> {
    return this.remnawave.status();
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Подключить Remnawave: проверить домен и токен, сохранить при успехе' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  async connect(@Body() body: RemnawaveConnectRequestDto): Promise<RemnawaveStatusDto> {
    this.topologyService.clear();
    return this.remnawave.connect(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Обновить данные Remnawave прямо сейчас' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  async refresh(): Promise<RemnawaveStatusDto> {
    this.topologyService.clear();
    return this.remnawave.refresh();
  }

  @Get('topology')
  @ApiOperation({ summary: 'Безопасная карта хостов, нод и маршрутов Remnawave' })
  @ApiOkResponse({ type: RemnawaveTopologyDto })
  topology(): Promise<RemnawaveTopologyDto> {
    return this.topologyService.get();
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Отключить Remnawave (стереть домен и токен)' })
  disconnect(): Promise<void> {
    this.topologyService.clear();
    return this.remnawave.disconnect();
  }

  @Put('vpn-probe')
  @ApiOperation({ summary: 'Проверить и сохранить сервисную подписку для настоящих VPN-проб' })
  @ApiOkResponse({ type: RemnawaveVpnProbeStatusDto })
  configureVpnProbe(@Body() body: RemnawaveVpnProbeRequestDto): Promise<RemnawaveVpnProbeStatusDto> {
    return this.vpnProbe.configure(body.subscriptionUrl);
  }

  @Delete('vpn-probe')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить сервисную подписку VPN-проб' })
  clearVpnProbe(): Promise<void> {
    return this.vpnProbe.clear();
  }
}

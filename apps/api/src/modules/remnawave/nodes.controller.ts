import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { nodeLayoutSchema, nodePreferencesSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { CheckHostService } from '../incidents/check-host.service.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { NodeLayoutStore } from './node-layout.store.js';
import { NodePreferencesStore } from './node-preferences.store.js';
import { NodeTcpHistoryService } from './node-tcp-history.service.js';
import { NodesConnectRequestDto, NodesStatusDto } from './nodes.dto.js';
import { RemnaProvidersService } from './remna-providers.service.js';
import { RemnawaveService } from './remnawave.service.js';

class LayoutDto extends createZodDto(nodeLayoutSchema) {}
class PreferencesDto extends createZodDto(nodePreferencesSchema) {}

/** Node inventory comes directly from Remnawave, without a local server registry. */
@ApiTags('nodes')
@ApiCookieAuth()
@Controller('nodes')
export class NodesController {
  private pending: Promise<NodesStatusDto> | null = null;
  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly preferences: NodePreferencesStore,
    private readonly providers: RemnaProvidersService,
    private readonly layout: NodeLayoutStore,
    private readonly tcp: CheckHostService,
    private readonly monitoring: MonitoringStore,
    private readonly tcpHistory: NodeTcpHistoryService,
  ) {}

  @Post(':uuid/tcp-check')
  @HttpCode(200)
  async tcpCheck(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    const status = await this.remnawave.status();
    const node = status.nodes.find((n) => n.uuid === uuid);
    if (!node) throw new NotFoundException('Нода не найдена в Remnawave.');
    const cfg = await this.monitoring.get();
    // Ручная проверка — сразу итог, без повтора через минуту: «частично недоступен» здесь не подтверждается.
    const report = await this.tcp.checkNode(node.address, cfg.checkHostPort, node.port, { confirm: false });
    await this.tcpHistory.save(uuid, node.name, report);
    return report;
  }
  @Get(':uuid/tcp-checks') tcpChecks(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    return this.tcpHistory.list(uuid);
  }
  @Get('layout') layoutGet() {
    return this.layout.get();
  }
  @Put('layout') layoutSet(@Body() body: LayoutDto) {
    return this.layout.set(body);
  }

  @Get(':uuid/preferences')
  preferencesGet(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    return this.preferences.get(uuid);
  }

  @Put(':uuid/preferences')
  preferencesSave(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: PreferencesDto) {
    return this.preferences.set(uuid, body);
  }

  @Get('status')
  @ApiOkResponse({ type: NodesStatusDto })
  async status(): Promise<NodesStatusDto> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const current = await this.remnawave.status();
      const lastAttempt = current.lastAttemptAt ?? current.checkedAt;
      const cfg = await this.monitoring.get();
      if (
        cfg.enabled &&
        current.connected &&
        (!lastAttempt || Date.now() - Date.parse(lastAttempt) >= cfg.pollSeconds * 1000)
      ) {
        await this.remnawave.syncQuiet(cfg.apiTimeoutSeconds * 1000);
        return this.withWhitelist(await this.providers.enrich(await this.remnawave.status()));
      }
      return this.withWhitelist(await this.providers.enrich(current));
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  /** Отметка «Сервер белого списка» из настроек ноды — для метки «БС» в списке нод. */
  private async withWhitelist(status: NodesStatusDto): Promise<NodesStatusDto> {
    let marked = new Set<string>();
    try {
      marked = await this.preferences.whitelisted(status.domain);
    } catch {
      // Сбой чтения отметок не должен ломать список нод: просто без метки «БС».
    }
    if (marked.size === 0) return status;
    return { ...status, nodes: status.nodes.map((n) => ({ ...n, whitelist: marked.has(n.uuid) })) };
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Проверить и сохранить подключение панели Remnawave' })
  @ApiOkResponse({ type: NodesStatusDto })
  async connect(@Body() body: NodesConnectRequestDto): Promise<NodesStatusDto> {
    return this.providers.enrich(await this.remnawave.connect(body));
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ type: NodesStatusDto })
  async refresh(): Promise<NodesStatusDto> {
    return this.providers.enrich(await this.remnawave.refresh());
  }

  @Delete('connection')
  @HttpCode(204)
  disconnect(): Promise<void> {
    return this.remnawave.disconnect();
  }
}

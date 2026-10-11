import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../audit/audit.decorator.js';
import { NodesConnectRequestDto } from './nodes.dto.js';
import { RemnaPermissionsService } from './remna-permissions.service.js';
import { RemnaProvidersService } from './remna-providers.service.js';
import { RemnawaveService } from './remnawave.service.js';
import { getJson, RemnawaveApiError } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

class ProviderDto extends createZodDto(z.object({ providerUuid: z.uuid().nullable() })) {}
@Controller('nodes')
export class NodeActionsController {
  constructor(
    private readonly permissions: RemnaPermissionsService,
    private readonly store: RemnawaveSettingsStore,
    private readonly providers: RemnaProvidersService,
    private readonly remna: RemnawaveService,
  ) {}
  @Get('permissions') permissionsGet() {
    return this.permissions.check();
  }
  @Post('permissions') @HttpCode(200) permissionsPreview(@Body() body: NodesConnectRequestDto) {
    let url: URL;
    try {
      url = new URL(`https://${body.domain}`);
    } catch {
      throw new BadRequestException('Укажите корректный домен панели.');
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      body.domain.includes('/')
    )
      throw new BadRequestException('Укажите только домен панели и порт при необходимости.');
    return this.permissions.check({ ...body, domain: url.host });
  }
  @Patch(':uuid/provider') @Audit('remnawave.node_provider_updated') async assign(
    @Param('uuid', ParseUUIDPipe) uuid: string,
    @Body() body: ProviderDto,
  ) {
    const c = await this.store.credentials();
    if (!c) throw new BadRequestException('Подключите Remnawave.');
    if (body.providerUuid && !(await this.providers.list(false, c)).some((p) => p.uuid === body.providerUuid))
      throw new BadRequestException('Провайдер не найден.');
    try {
      await this.permissions.observe('nodes:update', c, () =>
        getJson(`https://${c.domain}/api/nodes`, c.apiKey, {
          method: 'PATCH',
          body: JSON.stringify({ uuid, providerUuid: body.providerUuid }),
        }),
      );
    } catch (e) {
      if (e instanceof RemnawaveApiError && e.kind === 'unauthorized')
        throw new ForbiddenException('Ключу нужен доступ nodes:update для смены провайдера ноды.');
      throw new BadGatewayException(
        'Remnawave не подтвердила смену провайдера. Обновите состояние перед повтором.',
      );
    }
    this.providers.invalidate();
    await this.remna.syncQuiet();
    return { saved: true };
  }
}

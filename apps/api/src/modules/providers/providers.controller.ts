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
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createProviderRequestSchema,
  type Provider,
  type ProviderIconPreviewResponse,
  type ProvidersResponse,
  providerIconPreviewRequestSchema,
  providerIconPreviewResponseSchema,
  providerSchema,
  providersResponseSchema,
  updateProviderRequestSchema,
} from '@nodeservice/shared';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';

import { ProvidersService } from './providers.service.js';

export class ProviderDto extends createZodDto(providerSchema) {}
export class ProvidersResponseDto extends createZodDto(providersResponseSchema) {}
export class CreateProviderRequestDto extends createZodDto(createProviderRequestSchema) {}
export class UpdateProviderRequestDto extends createZodDto(updateProviderRequestSchema) {}
export class ProviderIconPreviewRequestDto extends createZodDto(providerIconPreviewRequestSchema) {}
export class ProviderIconPreviewResponseDto extends createZodDto(providerIconPreviewResponseSchema) {}

@ApiTags('providers')
@ApiCookieAuth()
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  @ApiOperation({ summary: 'Справочник провайдеров с числом серверов' })
  @ApiOkResponse({ type: ProvidersResponseDto })
  async list(): Promise<ProvidersResponse> {
    return { items: await this.providers.list() };
  }

  @Post()
  @ApiOperation({ summary: 'Добавить провайдера (иконка берётся с сайта)' })
  @ApiOkResponse({ type: ProviderDto })
  create(@Body() body: CreateProviderRequestDto): Promise<Provider> {
    return this.providers.create(body);
  }

  @Post('icon-preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Превью иконки по адресу сайта — до сохранения' })
  @ApiOkResponse({ type: ProviderIconPreviewResponseDto })
  preview(@Body() body: ProviderIconPreviewRequestDto): Promise<ProviderIconPreviewResponse> {
    return this.providers.preview(body.siteUrl);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Изменить провайдера' })
  @ApiOkResponse({ type: ProviderDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProviderRequestDto): Promise<Provider> {
    return this.providers.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить провайдера (у серверов он сбрасывается)' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.providers.delete(id);
  }

  @Post(':id/icon/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Заново взять иконку с сайта' })
  @ApiOkResponse({ type: ProviderDto })
  refresh(@Param('id', ParseUUIDPipe) id: string): Promise<Provider> {
    return this.providers.refreshIcon(id);
  }

  @Get(':id/servers')
  @ApiOperation({ summary: 'Серверы провайдера (id и имя)' })
  servers(@Param('id', ParseUUIDPipe) id: string): Promise<Array<{ id: string; name: string }>> {
    return this.providers.serversOf(id);
  }

  @Get(':id/icon')
  @ApiOperation({ summary: 'Иконка провайдера (картинка); 404 — не нашли' })
  async icon(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const icon = await this.providers.icon(id);
    if (!icon) {
      res.status(404).end();
      return;
    }
    res.setHeader('content-type', icon.type);
    // Картинка с чужого сайта на нашем origin: не даём браузеру угадывать тип и исполнять что-либо.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('content-disposition', 'inline; filename="icon"');
    res.setHeader('cache-control', 'private, max-age=86400');
    res.setHeader('etag', `"v${icon.version}"`);
    res.send(icon.data);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import {
  createProviderRequestSchema,
  providerSiteUrlSchema,
  updateProviderRequestSchema,
} from '@nodeservice/shared';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audit } from '../audit/audit.decorator.js';
import { RemnaProviderAssetsService } from './remna-provider-assets.service.js';
import { RemnaProvidersService } from './remna-providers.service.js';

class CreateDto extends createZodDto(createProviderRequestSchema) {}
class UpdateDto extends createZodDto(
  updateProviderRequestSchema.extend({ siteUrl: z.union([providerSiteUrlSchema, z.literal('')]).optional() }),
) {}
@Controller('nodes/providers/catalog')
export class RemnaProviderCatalogController {
  constructor(
    private readonly remote: RemnaProvidersService,
    private readonly assets: RemnaProviderAssetsService,
  ) {}
  private async provider(id: string) {
    const provider = (await this.remote.list()).find((p) => p.uuid === id);
    if (!provider) throw new NotFoundException('Провайдер не найден в Remnawave.');
    return provider;
  }
  private name(value?: string) {
    if (value !== undefined && (value.trim().length < 2 || value.trim().length > 30))
      throw new BadRequestException('Название Remnawave должно содержать от 2 до 30 символов.');
  }
  @Get() async list() {
    const items = await Promise.all(
      (await this.remote.list())
        .sort((a, b) => b.nodes.length - a.nodes.length || a.name.localeCompare(b.name, 'ru'))
        .map((p) => this.assets.dto(p)),
    );
    return { items };
  }
  @Post() @Audit('remnawave.provider_created') async create(@Body() body: CreateDto) {
    this.name(body.name);
    const p = await this.remote.create({
      name: body.name,
      loginUrl: body.siteUrl,
      faviconLink: body.siteUrl,
    });
    return this.assets.update(p, {
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
    });
  }
  @Patch(':id') @Audit('remnawave.provider_updated') async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDto,
  ) {
    this.name(body.name);
    let p = await this.provider(id);
    if (body.name !== undefined || body.siteUrl !== undefined) {
      await this.remote.update(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.siteUrl !== undefined ? { loginUrl: body.siteUrl || null } : {}),
      });
      p = {
        ...p,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.siteUrl !== undefined
          ? { loginUrl: body.siteUrl || null, faviconLink: body.siteUrl || null }
          : {}),
      };
    }
    return this.assets.update(p, {
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
    });
  }
  @Delete(':id') @HttpCode(204) @Audit('remnawave.provider_deleted') async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.provider(id);
    await this.remote.remove(id);
  }
  @Get(':id/servers') async nodes(@Param('id', ParseUUIDPipe) id: string) {
    return (await this.provider(id)).nodes.map((n) => ({ id: n.uuid, name: n.name }));
  }
  @Post(':id/icon/refresh') @HttpCode(200) async refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.refresh(await this.provider(id));
  }
  @Get(':id/icon') async icon(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const icon = await this.assets.icon(id);
    if (!icon) {
      res.status(404).end();
      return;
    }
    res.setHeader('content-type', icon.type);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('content-disposition', 'inline; filename="icon"');
    res.setHeader('cache-control', 'private, max-age=86400');
    res.setHeader('etag', `"v${icon.version}"`);
    res.send(icon.data);
  }
}

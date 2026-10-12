import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { createProviderRequestSchema, type RemnaProvider } from '@nodeservice/shared';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { DB, type Db } from '../../infra/db/db.module.js';
import { billingItems, providers } from '../../infra/db/schema/index.js';
import { Audit } from '../audit/audit.decorator.js';
import { ProvidersService } from '../providers/providers.service.js';
import { RemnaProviderAssetsService } from './remna-provider-assets.service.js';
import { RemnaProvidersService } from './remna-providers.service.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

class CreateDto extends createZodDto(createProviderRequestSchema) {}
@Controller('nodes/billing-providers')
export class RemnaBillingProvidersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly remote: RemnaProvidersService,
    private readonly store: RemnawaveSettingsStore,
    private readonly assets: RemnaProviderAssetsService,
    private readonly legacy: ProvidersService,
  ) {}
  private async project(domain: string, items: RemnaProvider[], complete = true) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`remna-billing:${domain}`}))`);
      const old = await tx.select().from(providers).where(eq(providers.remotePanel, domain));
      for (const p of items) {
        const row = old.find((x) => x.remoteUuid === p.uuid);
        const icon = await this.assets.icon(p.uuid, domain);
        const values = {
          name: p.name,
          siteUrl: p.loginUrl ?? '',
          archivedAt: null,
          updatedAt: new Date(),
          ...(icon
            ? { iconType: icon.type, iconData: icon.data.toString('base64'), iconVersion: icon.version }
            : {}),
        };
        if (row) await tx.update(providers).set(values).where(eq(providers.id, row.id));
        else await tx.insert(providers).values({ ...values, remotePanel: domain, remoteUuid: p.uuid });
      }
      if (complete)
        for (const row of old)
          if (!items.some((p) => p.uuid === row.remoteUuid) && !row.archivedAt)
            await tx.update(providers).set({ archivedAt: new Date() }).where(eq(providers.id, row.id));
    });
  }
  @Get() async list() {
    const credentials = await this.store.credentials();
    const domain = credentials?.domain ?? null;
    let remote: RemnaProvider[] = [];
    if (credentials) {
      remote = await this.remote.list(false, credentials);
      await this.project(credentials.domain, remote);
    }
    const rows = await this.db
      .select()
      .from(providers)
      .where(
        or(
          and(
            isNull(providers.archivedAt),
            domain
              ? or(isNull(providers.remotePanel), eq(providers.remotePanel, domain))
              : isNull(providers.remotePanel),
          ),
          sql`exists(select 1 from ${billingItems} where ${billingItems.providerId} = ${providers.id})`,
        ),
      );
    const items = await Promise.all(
      rows.map(async (row) => {
        const p = row.remotePanel === domain ? remote.find((p) => p.uuid === row.remoteUuid) : undefined;
        return p
          ? { ...(await this.assets.dto(p, domain ?? undefined)), id: row.id }
          : {
              ...this.legacy.toDto(row),
              selectable: !row.archivedAt && (!row.remotePanel || row.remotePanel === domain),
            };
      }),
    );
    return { items };
  }
  @Post() @Audit('remnawave.provider_created') async create(@Body() body: CreateDto) {
    const credentials = await this.store.credentials();
    if (!credentials) return this.legacy.create(body);
    const domain = credentials.domain;
    if (body.name.trim().length < 2 || body.name.trim().length > 30)
      throw new BadRequestException('Название Remnawave должно содержать от 2 до 30 символов.');
    const p = await this.remote.create(
      { name: body.name, loginUrl: body.siteUrl, faviconLink: body.siteUrl },
      credentials,
    );
    try {
      const created = await this.assets.update(
        p,
        {
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
        },
        domain,
      );
      await this.project(domain, [p], false);
      const row = await this.db.query.providers.findFirst({
        where: and(eq(providers.remotePanel, domain), eq(providers.remoteUuid, p.uuid)),
      });
      if (!row) throw new Error('Projection missing');
      return { ...created, id: row.id };
    } catch {
      throw new BadGatewayException(
        'Провайдер уже создан в Remnawave, но список оплат не обновился. Закройте форму и обновите список; не создавайте провайдера повторно.',
      );
    }
  }
  @Get(':id/icon') async icon(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const row = await this.db.query.providers.findFirst({ where: eq(providers.id, id) });
    if (!row) {
      res.status(404).end();
      return;
    }
    const domain = await this.store.domain();
    const icon =
      row.remotePanel === domain && row.remoteUuid
        ? await this.assets.icon(row.remoteUuid, row.remotePanel ?? undefined)
        : row.iconData && row.iconType
          ? { type: row.iconType, data: Buffer.from(row.iconData, 'base64') }
          : null;
    if (!icon) {
      res.status(404).end();
      return;
    }
    res.setHeader('content-type', icon.type);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('cache-control', 'private, max-age=86400');
    res.send(icon.data);
  }
}

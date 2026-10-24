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
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import {
  reserveAutoSchema,
  reserveIpAddSchema,
  reserveIpOrderSchema,
  reserveSwitchSchema,
} from '@nodeservice/shared';
import { Audit } from '../audit/audit.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { ReserveIpsService } from './reserve-ips.service.js';

/** Запасные IP ноды (0.111.0): список, проверка Check-Host, порядок, «Переключать само», план и переключение. */
@ApiTags('nodes')
@ApiCookieAuth()
@Controller('nodes/:uuid/reserve')
export class ReserveIpsController {
  constructor(
    private readonly reserve: ReserveIpsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  get(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    return this.reserve.get(uuid);
  }

  @Audit('incident.node_reserve.added')
  @Post()
  @HttpCode(200)
  async add(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: unknown) {
    const { ip } = reserveIpAddSchema.parse(body);
    const result = await this.reserve.add(uuid, ip);
    this.audit.extend({
      metadata: { ip, check: result.items.find((i) => i.ip === ip)?.check?.text ?? null },
    });
    return result;
  }

  @Post(':ip/check')
  @HttpCode(200)
  check(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Param('ip') ip: string) {
    return this.reserve.recheck(uuid, ip);
  }

  @Audit('incident.node_reserve.removed')
  @Delete(':ip')
  async remove(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Param('ip') ip: string) {
    this.audit.extend({ metadata: { ip } });
    return this.reserve.remove(uuid, ip);
  }

  @Put('order')
  order(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: unknown) {
    return this.reserve.order(uuid, reserveIpOrderSchema.parse(body).ips);
  }

  @Audit('incident.node_reserve.auto_changed')
  @Put('auto')
  setAuto(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: unknown) {
    const { auto } = reserveAutoSchema.parse(body);
    this.audit.extend({ metadata: { auto: auto ? 'включено' : 'выключено' } });
    return this.reserve.setAuto(uuid, auto);
  }

  /** Что поменяется при переключении — до него, без изменений. */
  @Get('plan')
  async plan(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Query('to') to: string) {
    const { hosts: _hosts, records: _records, ...plan } = await this.reserve.plan(uuid, String(to ?? ''));
    return plan;
  }

  @Audit('incident.node_reserve.switched')
  @Post('switch')
  @HttpCode(200)
  async switch(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: unknown) {
    const { to } = reserveSwitchSchema.parse(body);
    const result = await this.reserve.switchTo(uuid, to, 'manual');
    const failed = result.plan.steps.filter((s) => s.ok === false);
    this.audit.extend({
      target: { type: 'node', id: uuid, display: result.nodeName },
      metadata: {
        from: result.plan.from,
        to: result.plan.to,
        changed: result.plan.steps.filter((s) => s.ok).map((s) => s.title),
        ...(failed.length ? { failing: failed.map((s) => `${s.title}: ${s.error}`) } : {}),
      },
    });
    return result;
  }
}

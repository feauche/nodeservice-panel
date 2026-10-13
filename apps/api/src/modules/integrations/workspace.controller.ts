import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { Audit } from '../audit/audit.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { DnsService } from './dns.service.js';
import { DpiService } from './dpi.service.js';

const dpiRun = z.object({
  nodeUuid: z.uuid(),
  kind: z.enum(['ip', 'vpn']),
  key: z.string().max(8192).optional(),
  popIds: z.array(z.number().int().positive()).max(100),
});
const schedule = z.object({
  enabled: z.boolean(),
  minutes: z.number().int().min(15).max(10080),
  nodes: z.array(z.uuid()).max(100),
  pops: z.array(z.number().int().positive()).max(100),
});
@Controller('integrations')
export class IntegrationWorkspaceController {
  constructor(
    private dpi: DpiService,
    private dns: DnsService,
    private audit: AuditService,
  ) {}
  @Get('dpi/overview') dpiOverview() {
    return this.dpi.overview();
  }
  @Get('dpi/checks/:id') detail(@Param('id') id: string) {
    return this.dpi.detail(id);
  }
  @Audit('integration.dpi.check_started')
  @Post('dpi/checks')
  async start(@Body() body: unknown) {
    const value = dpiRun.extend({ requestId: z.uuid() }).parse(body);
    const result = await this.dpi.start(value);
    this.audit.extend({
      metadata: { mode: value.kind === 'vpn' ? 'VLESS' : 'IP', points: value.popIds.length || 'оптимальные' },
    });
    return result;
  }
  /** Сколько спишут — бесплатно, до запуска. */
  @Post('dpi/estimate') estimate(@Body() body: unknown) {
    return this.dpi.estimate(dpiRun.parse(body));
  }
  @Audit('integration.dpi.check_cancelled')
  @Post('dpi/checks/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.dpi.cancel(id);
  }
  @Get('dpi/tools/rkn/:node') rkn(@Param('node') node: string) {
    return this.dpi.rkn(z.uuid().parse(node));
  }
  @Get('dpi/tools/noisy/quota') noisyQuota() {
    return this.dpi.noisyLeft();
  }
  @Post('dpi/tools/noisy') noisyStart(@Body() body: unknown) {
    return this.dpi.noisyStart(z.object({ nodeUuid: z.uuid() }).parse(body).nodeUuid);
  }
  @Get('dpi/tools/noisy/:id') noisy(@Param('id') id: string) {
    return this.dpi.noisy(id);
  }
  @Audit('integration.dpi.probe_started')
  @Post('dpi/tools/probe')
  probeStart(@Body() body: unknown) {
    const value = z.object({ nodeUuid: z.uuid(), requestId: z.uuid() }).parse(body);
    return this.dpi.probeStart(value.nodeUuid, value.requestId);
  }
  @Get('dpi/tools/probe/:id') probe(@Param('id') id: string) {
    return this.dpi.probe(id);
  }
  @Put('dpi/schedule') schedule(@Body() body: unknown) {
    return this.dpi.setSchedule(schedule.parse(body));
  }
  @Get('dns/overview') dnsOverview() {
    return this.dns.overview();
  }
  @Post('dns/workspace/refresh') dnsRefresh() {
    return this.dns.overview(true);
  }
  @Get('dns/history') dnsHistory() {
    return this.dns.history();
  }
  @Audit('integration.dns.autoreplace_changed')
  @Put('dns/settings')
  dnsSettings(@Body() body: unknown) {
    const value = z.object({ recordId: z.string().min(1).max(512), enabled: z.boolean() }).parse(body);
    return this.dns.setSettings(value.recordId, value.enabled);
  }
  @Audit('integration.dns.record_changed')
  @Post('dns/apply')
  async dnsApply(@Body() body: unknown) {
    const result = await this.dns.apply(
      z
        .object({
          recordId: z.string().min(1).max(512),
          nodeUuid: z.uuid(),
          expected: z.string().min(1).max(128),
        })
        .parse(body),
    );
    const { changed, ...what } = result;
    // В «Журнал» — домен, было и стало, нода: по ним видно, что поменяли руками.
    this.audit.extend({ metadata: { ...what, changed: changed ? 'адрес заменён' : 'только связь с нодой' } });
    return { changed };
  }
}

import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { DnsService } from './dns.service.js';
import { DpiService } from './dpi.service.js';

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
  ) {}
  @Get('dpi/overview') dpiOverview() {
    return this.dpi.overview();
  }
  @Get('dpi/checks/:id') detail(@Param('id') id: string) {
    return this.dpi.detail(id);
  }
  @Post('dpi/checks') start(@Body() body: unknown) {
    return this.dpi.start(
      z
        .object({
          nodeUuid: z.uuid(),
          kind: z.enum(['ip', 'vpn']),
          key: z.string().max(8192).optional(),
          popIds: z.array(z.number().int().positive()).max(100),
          requestId: z.uuid(),
        })
        .parse(body),
    );
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
  @Put('dns/settings') dnsSettings(@Body() body: unknown) {
    const value = z.object({ recordId: z.string().min(1).max(512), enabled: z.boolean() }).parse(body);
    return this.dns.setSettings(value.recordId, value.enabled);
  }
  @Post('dns/apply') dnsApply(@Body() body: unknown) {
    return this.dns.apply(
      z
        .object({
          recordId: z.string().min(1).max(512),
          nodeUuid: z.uuid(),
          expected: z.string().min(1).max(128),
        })
        .parse(body),
    );
  }
}

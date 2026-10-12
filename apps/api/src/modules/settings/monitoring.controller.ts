import { Body, Controller, Get, Put } from '@nestjs/common';
import { monitoringSettingsUpdateSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { MonitoringStore } from './monitoring.store.js';

class UpdateMonitoringDto extends createZodDto(monitoringSettingsUpdateSchema) {}
@Controller('settings/monitoring')
export class MonitoringController {
  constructor(private readonly settings: MonitoringStore) {}
  @Get() get() {
    return this.settings.get();
  }
  @Put()
  @Audit('settings.autochecks.updated', {
    target: { type: 'settings', id: 'monitoring', display: 'Мониторинг нод' },
  })
  set(@Body() body: UpdateMonitoringDto) {
    return this.settings.set(body);
  }
}

import { Module } from '@nestjs/common';
import { AssistantSettingsModule } from '../assistant/assistant-settings.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { IncidentsSettingsStore } from './incidents-settings.store.js';
import { MonitoringController } from './monitoring.controller.js';
import { MonitoringStore } from './monitoring.store.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { SiteIconsController } from './site-icons.controller.js';

@Module({
  imports: [AssistantSettingsModule, ProvidersModule],
  controllers: [MonitoringController, SettingsController, SiteIconsController],
  providers: [MonitoringStore, SettingsService, IncidentsSettingsStore],
  exports: [MonitoringStore, SettingsService, IncidentsSettingsStore],
})
export class SettingsModule {}

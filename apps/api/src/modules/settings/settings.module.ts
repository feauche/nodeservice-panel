import { MonitoringStore } from './monitoring.store.js';
import { MonitoringController } from './monitoring.controller.js';
import { Module } from '@nestjs/common';
import { AssistantSettingsModule } from '../assistant/assistant-settings.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { AutochecksStore } from './autochecks.store.js';
import { IncidentsSettingsStore } from './incidents-settings.store.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { SiteIconsController } from './site-icons.controller.js';

@Module({
  imports: [AssistantSettingsModule, ProvidersModule],
  controllers: [MonitoringController, SettingsController, SiteIconsController],
  providers: [MonitoringStore, SettingsService, AutochecksStore, IncidentsSettingsStore],
  exports: [MonitoringStore, SettingsService, AutochecksStore, IncidentsSettingsStore],
})
export class SettingsModule {}

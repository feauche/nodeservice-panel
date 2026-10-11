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
  controllers: [SettingsController, SiteIconsController],
  providers: [SettingsService, AutochecksStore, IncidentsSettingsStore],
  exports: [SettingsService, AutochecksStore, IncidentsSettingsStore],
})
export class SettingsModule {}

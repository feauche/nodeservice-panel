import { Module } from '@nestjs/common';
import { CheckHostModule } from '../incidents/check-host.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ScenariosController } from './scenarios.controller.js';
import { ScenariosJob } from './scenarios.job.js';
import { ScenariosStore } from './scenarios.store.js';
@Module({
  imports: [RemnawaveModule, SettingsModule, CheckHostModule, NotificationsModule],
  providers: [ScenariosStore, ScenariosJob],
  controllers: [ScenariosController],
  exports: [ScenariosStore],
})
export class ScenariosModule {}

import { Module } from '@nestjs/common';

import { IncidentsModule } from '../incidents/incidents.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { RussiaAccessCheckService } from './russia-access-check.service.js';
import { ServerChecksController } from './server-checks.controller.js';
import { ServerChecksJob } from './server-checks.job.js';
import { ServerChecksRepository } from './server-checks.repository.js';
import { ServerChecksService } from './server-checks.service.js';

/**
 * R5/J9: реестр проверок сервера — свои команды раз в сутки, сторонние скрипты и тяжёлые по кнопке;
 * вывод читает Джарвис.
 */
@Module({
  imports: [ServersModule, SettingsModule, IncidentsModule, RemnawaveModule],
  controllers: [ServerChecksController],
  providers: [ServerChecksRepository, ServerChecksService, ServerChecksJob, RussiaAccessCheckService],
  exports: [ServerChecksService, ServerChecksRepository],
})
export class ServerChecksModule {}

import { Module } from '@nestjs/common';

import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ServerChecksController } from './server-checks.controller.js';
import { ServerChecksJob } from './server-checks.job.js';
import { ServerChecksRepository } from './server-checks.repository.js';
import { ServerChecksService } from './server-checks.service.js';

/**
 * R5/J9: реестр проверок сервера — свои команды раз в сутки, сторонние скрипты и тяжёлые по кнопке;
 * вывод читает Джарвис.
 */
@Module({
  imports: [ServersModule, SettingsModule],
  controllers: [ServerChecksController],
  providers: [ServerChecksRepository, ServerChecksService, ServerChecksJob],
  exports: [ServerChecksService, ServerChecksRepository],
})
export class ServerChecksModule {}

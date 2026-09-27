import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { RemnawaveController } from './remnawave.controller.js';
import { RemnawaveService } from './remnawave.service.js';
import { HttpRemnawaveClient, REMNAWAVE_CLIENT } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { RemnawaveSyncJob } from './remnawave-sync.job.js';

/** J4: подключение к панели Remnawave, только чтение (домен + токен API с правами на чтение). */
@Module({
  imports: [AuditModule],
  controllers: [RemnawaveController],
  providers: [
    RemnawaveSettingsStore,
    RemnawaveService,
    RemnawaveSyncJob,
    { provide: REMNAWAVE_CLIENT, useClass: HttpRemnawaveClient },
  ],
  exports: [RemnawaveService],
})
export class RemnawaveModule {}

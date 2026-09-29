import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import { StepUpGuard } from '../security/step-up.guard.js';
import { BackupSettingsStore } from './backup-settings.store.js';
import { BACKUP_TOOLS, PgBackupTools } from './backup-tools.js';
import { BackupsController } from './backups.controller.js';
import { BackupsJob } from './backups.job.js';
import { BackupsService } from './backups.service.js';

/** Резервные копии панели: по расписанию и вручную, отправка в Telegram, восстановление. */
@Module({
  controllers: [BackupsController],
  providers: [
    BackupSettingsStore,
    BackupsService,
    BackupsJob,
    StepUpGuard,
    {
      provide: BACKUP_TOOLS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => new PgBackupTools(config.get('DATABASE_URL')),
    },
  ],
  exports: [BackupsService],
})
export class BackupsModule {}

import { Module } from '@nestjs/common';
import { StepUpGuard } from '../security/step-up.guard.js';
import { SettingsModule } from '../settings/settings.module.js';
import { PanelKeyService } from './panel-key.service.js';
import { ServersController } from './servers.controller.js';
import { ServersRepository } from './servers.repository.js';
import { ServersService } from './servers.service.js';
import { SshService } from './ssh.service.js';
import { SshAutocheckJob } from './ssh-autocheck.job.js';

/** Этап 4: инвентарь серверов и SSH. Агент и метрики придут в этапах 5–6. */
@Module({
  imports: [SettingsModule],
  controllers: [ServersController],
  providers: [ServersRepository, ServersService, SshService, PanelKeyService, StepUpGuard, SshAutocheckJob],
  exports: [ServersRepository, ServersService, SshService, PanelKeyService],
})
export class ServersModule {}

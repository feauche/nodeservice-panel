import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller.js';
import { AuthCoreModule } from './auth-core.module.js';
import { SessionGuard } from './session.guard.js';
import { SetupService } from './setup.service.js';

@Module({
  imports: [AuthCoreModule],
  controllers: [AuthController],
  providers: [SessionGuard, { provide: APP_GUARD, useExisting: SessionGuard }],
  exports: [AuthCoreModule, SessionGuard],
})
export class AuthModule implements OnApplicationBootstrap {
  constructor(private readonly setup: SetupService) {}

  /** Свежая установка: выпустить токен первого запуска и напечатать баннер. */
  async onApplicationBootstrap(): Promise<void> {
    await this.setup.ensureTokenOnBootstrap();
  }
}

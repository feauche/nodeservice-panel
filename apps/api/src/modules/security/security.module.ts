import { Module } from '@nestjs/common';

import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PwnedPasswordsService } from './pwned-passwords.service.js';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';
import { StepUpGuard } from './step-up.guard.js';

/** «Безопасность и сессии» — HTTP поверх auth-core. */
@Module({
  imports: [AuthCoreModule],
  controllers: [SecurityController],
  providers: [SecurityService, PwnedPasswordsService, StepUpGuard],
})
export class SecurityModule {}

import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthEventsService } from './auth-events.service.js';
import { PendingStore } from './pending.store.js';
import { SecurityPolicyStore } from './security-policy.store.js';
import { SessionStore } from './session.store.js';
import { SetupService } from './setup.service.js';
import { ThrottleService } from './throttle.service.js';
import { TotpService } from './totp.service.js';
import { UsersRepository } from './users.repository.js';

/**
 * Сервисы auth без HTTP-обвязки — их же использует rescue-CLI.
 * Зависит от глобальных ConfigModule/DbModule/ValkeyModule/CryptoModule/LoggerModule.
 */
@Module({
  providers: [
    UsersRepository,
    SecurityPolicyStore,
    SessionStore,
    PendingStore,
    ThrottleService,
    TotpService,
    SetupService,
    AuthEventsService,
    AuthService,
  ],
  exports: [
    UsersRepository,
    SecurityPolicyStore,
    SessionStore,
    PendingStore,
    ThrottleService,
    TotpService,
    SetupService,
    AuthService,
  ],
})
export class AuthCoreModule {}

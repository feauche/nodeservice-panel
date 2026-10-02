import { Module } from '@nestjs/common';
import { AnonAuditLimiter } from './anon-audit.limiter.js';
import { AuthService } from './auth.service.js';
import { AuthEventsService } from './auth-events.service.js';
import { PendingStore } from './pending.store.js';
import { SecurityPolicyStore } from './security-policy.store.js';
import { SessionStore } from './session.store.js';
import { SessionChannelsModule } from './session-channels.module.js';
import { SetupService } from './setup.service.js';
import { ThrottleService } from './throttle.service.js';
import { TotpService } from './totp.service.js';
import { UsersRepository } from './users.repository.js';

/**
 * Сервисы auth без HTTP-обвязки — их же использует rescue-CLI.
 * Зависит от глобальных ConfigModule/DbModule/ValkeyModule/CryptoModule/LoggerModule.
 */
@Module({
  imports: [SessionChannelsModule],
  providers: [
    UsersRepository,
    SecurityPolicyStore,
    SessionStore,
    PendingStore,
    ThrottleService,
    AnonAuditLimiter,
    TotpService,
    SetupService,
    AuthEventsService,
    AuthService,
  ],
  exports: [
    UsersRepository,
    SecurityPolicyStore,
    SessionChannelsModule,
    SessionStore,
    PendingStore,
    ThrottleService,
    AnonAuditLimiter,
    TotpService,
    SetupService,
    AuthService,
  ],
})
export class AuthCoreModule {}

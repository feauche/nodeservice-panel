import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';

import { CryptoModule } from '../../common/crypto/crypto.module.js';
import { ConfigModule } from '../../config/config.module.js';
import { DbModule } from '../../infra/db/db.module.js';
import { ValkeyModule } from '../../infra/valkey/valkey.module.js';
import { AuditCoreModule } from '../audit/audit.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { DisableTwoFactorCommand } from './commands/disable-2fa.command.js';
import { ListUsersCommand } from './commands/list-users.command.js';
import { ResetPasswordCommand } from './commands/reset-password.command.js';
import { RevokeSessionsCommand } from './commands/revoke-sessions.command.js';
import { SetupTokenCommand } from './commands/setup-token.command.js';

/** Модуль CLI: без контроллеров, guard-ов и bootstrap-хуков auth. */
@Module({
  imports: [
    ConfigModule,
    // Логи CLI — только предупреждения и ошибки, без транспорта pino-pretty.
    LoggerModule.forRoot({ pinoHttp: { level: 'warn', autoLogging: false } }),
    // CLS без middleware: Журналу нужен ClsService, активного контекста в CLI нет — актор задаётся явно.
    ClsModule.forRoot({ global: true }),
    DbModule,
    ValkeyModule,
    CryptoModule,
    AuditCoreModule,
    AuthCoreModule,
  ],
  providers: [
    SetupTokenCommand,
    ResetPasswordCommand,
    DisableTwoFactorCommand,
    RevokeSessionsCommand,
    ListUsersCommand,
  ],
})
export class CliModule {}

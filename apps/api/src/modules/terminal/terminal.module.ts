import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { SecurityModule } from '../security/security.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { TerminalController } from './terminal.controller.js';
import { TerminalGateway } from './terminal.gateway.js';
import { TerminalService } from './terminal.service.js';
import { TerminalSessionsRepository } from './terminal-sessions.repository.js';

/** Этап 7: веб-терминал (SSH-PTY через аутентифицированный и аудируемый WebSocket). */
@Module({
  imports: [ServersModule, AuthModule, SecurityModule],
  controllers: [TerminalController],
  providers: [TerminalService, TerminalGateway, TerminalSessionsRepository],
  exports: [TerminalGateway],
})
export class TerminalModule {}

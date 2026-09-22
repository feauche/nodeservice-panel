import { Global, Module } from '@nestjs/common';

import { WsUpgradeService } from './ws-upgrade.service.js';

/** Глобальный роутер WebSocket-upgrade (агент, терминал). */
@Global()
@Module({
  providers: [WsUpgradeService],
  exports: [WsUpgradeService],
})
export class WsModule {}

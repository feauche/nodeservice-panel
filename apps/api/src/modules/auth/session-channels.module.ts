import { Global, Module } from '@nestjs/common';

import { SessionChannelsService } from './session-channels.service.js';

/** Единый реестр живых HTTP/WebSocket-каналов, которые нужно закрывать при отзыве сессии. */
@Global()
@Module({
  providers: [SessionChannelsService],
  exports: [SessionChannelsService],
})
export class SessionChannelsModule {}

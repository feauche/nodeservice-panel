import { Module } from '@nestjs/common';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { DpiService } from './dpi.service.js';
import { IntegrationConnectionsModule } from './integration-connections.module.js';
@Module({
  imports: [IntegrationConnectionsModule, RemnawaveModule],
  controllers: [],
  providers: [DpiService],
  exports: [DpiService],
})
export class DpiCheckerModule {}

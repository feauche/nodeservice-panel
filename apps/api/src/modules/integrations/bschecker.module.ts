import { Module } from '@nestjs/common';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { BsRentalsController } from './bs-rentals.controller.js';
import { BsRentalsService } from './bs-rentals.service.js';
import { BsCheckerController } from './bschecker.controller.js';
import { BsCheckerService } from './bschecker.service.js';
import { IntegrationConnectionsModule } from './integration-connections.module.js';
@Module({
  imports: [IntegrationConnectionsModule, RemnawaveModule],
  controllers: [BsCheckerController, BsRentalsController],
  providers: [BsCheckerService, BsRentalsService],
  exports: [BsCheckerService, BsRentalsService],
})
export class BsCheckerModule {}

import {BsRentalsService} from './bs-rentals.service.js';
import {BsRentalsController} from './bs-rentals.controller.js';
import { BsCheckerService } from './bschecker.service.js';
import { BsCheckerController } from './bschecker.controller.js';
import { Module } from '@nestjs/common';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { DnsService } from './dns.service.js';
import { DpiService } from './dpi.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationWorkspaceController } from './workspace.controller.js';
@Module({
  imports: [RemnawaveModule],
  controllers: [BsRentalsController,BsCheckerController, IntegrationsController, IntegrationWorkspaceController],
  providers: [BsRentalsService,BsCheckerService, IntegrationsService, DpiService, DnsService],
})
export class IntegrationsModule {}

import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { HousekeepingService } from './housekeeping.service.js';

/** Ночная чистка растущих таблиц по сроку хранения. */
@Module({
  imports: [AuditModule],
  providers: [HousekeepingService],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}

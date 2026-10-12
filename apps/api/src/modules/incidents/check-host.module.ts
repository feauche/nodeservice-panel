import { Module } from '@nestjs/common';
import { CheckHostService } from './check-host.service.js';
@Module({ providers: [CheckHostService], exports: [CheckHostService] })
export class CheckHostModule {}

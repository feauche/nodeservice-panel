import { Module } from '@nestjs/common';

import { IconFetchService } from './icon-fetch.service.js';
import { ProvidersController } from './providers.controller.js';
import { ProvidersRepository } from './providers.repository.js';
import { ProvidersService } from './providers.service.js';

/** Справочник провайдеров (хостеров) с иконками сайтов. */
@Module({
  controllers: [ProvidersController],
  providers: [ProvidersRepository, ProvidersService, IconFetchService],
  exports: [ProvidersService],
})
export class ProvidersModule {}

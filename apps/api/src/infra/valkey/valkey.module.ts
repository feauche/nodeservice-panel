import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { Env } from '../../config/env.schema.js';

/** Единственный клиент Valkey на приложение — сессии, rate-limit, кэш. BullMQ берёт свой. */
export const VALKEY = Symbol('VALKEY');

@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('VALKEY_URL'), {
          lazyConnect: false,
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          connectionName: 'nodeservice-api',
        }),
    },
  ],
  exports: [VALKEY],
})
export class ValkeyModule implements OnApplicationShutdown {
  private readonly log = new Logger(ValkeyModule.name);

  constructor(@Inject(VALKEY) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
    this.log.log('Соединение с Valkey закрыто');
  }
}

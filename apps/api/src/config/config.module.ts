import { Global, Module } from '@nestjs/common';
import { type ConfigService, ConfigModule as NestConfigModule } from '@nestjs/config';

import { type Env, validateEnv } from './env.schema.js';

/** Типизированный доступ к окружению: `config.get('PORT')` уже number. */
export type AppConfig = ConfigService<Env, true>;

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),
  ],
})
export class ConfigModule {}

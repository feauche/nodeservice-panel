import { Module } from '@nestjs/common';

import { CryptoModule } from '../../common/crypto/crypto.module.js';
import { AssistantSettingsStore } from './assistant-settings.store.js';

/** Только хранилище ключа LLM — общий для Settings и Assistant, чтобы не было цикла модулей. */
@Module({
  imports: [CryptoModule],
  providers: [AssistantSettingsStore],
  exports: [AssistantSettingsStore],
})
export class AssistantSettingsModule {}

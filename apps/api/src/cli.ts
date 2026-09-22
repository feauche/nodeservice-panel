import { CommandFactory } from 'nest-commander';

import { CliModule } from './modules/cli/cli.module.js';

/**
 * Rescue-CLI: `pnpm cli <command>` (после сборки — `node dist/cli.js`).
 * Поднимает те же модули (config/db/valkey/crypto), но не HTTP-сервер.
 */
CommandFactory.run(CliModule, {
  logger: ['warn', 'error'],
  errorHandler: onError,
  serviceErrorHandler: onError,
}).catch(onError);

function onError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

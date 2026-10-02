import { Logger } from '@nestjs/common';

// Юниты намеренно вызывают таймауты, отказы БД, SSH и Telegram. Их проверяют assertions,
// поэтому штатные Nest WARN/ERROR только засоряют GitHub Actions и прячут настоящее падение Vitest.
Logger.overrideLogger(false);

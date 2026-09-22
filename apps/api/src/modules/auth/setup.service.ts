import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import { UsersRepository } from './users.repository.js';

/** Токен первого запуска: выпуск, баннер в лог, проверка. */
@Injectable()
export class SetupService {
  private readonly log = new Logger(SetupService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Мастер нужен, пока нет администратора с подтверждённым TOTP (брошенный мастер не в счёт). */
  async isSetupRequired(): Promise<boolean> {
    return !(await this.users.hasConfirmedAdmin());
  }

  /** Новый токен (старые неиспользованные — аннулируются). Возвращает открытое значение. */
  async issueToken(): Promise<string> {
    const token = this.crypto.randomToken(32);
    await this.users.replaceSetupToken(this.crypto.sha256Hex(token));
    return token;
  }

  get setupUrl(): string {
    return `${this.config.get('PUBLIC_URL').replace(/\/+$/, '')}/setup`;
  }

  /**
   * При старте: если администратора нет и живого токена нет — выпустить и напечатать.
   * Возвращает токен (для тестов), либо null, если ничего делать не нужно.
   */
  async ensureTokenOnBootstrap(): Promise<string | null> {
    if (!(await this.isSetupRequired())) return null;
    if (await this.users.hasUnusedSetupToken()) {
      this.log.warn(
        `Администратор ещё не создан. Токен первого запуска уже выпущен — если потерял, выполни: pnpm cli setup-token`,
      );
      return null;
    }
    const token = await this.issueToken();
    this.printBanner(token);
    return token;
  }

  printBanner(token: string): void {
    const lines = [
      'ПЕРВЫЙ ЗАПУСК: администратор ещё не создан.',
      `Открой ${this.setupUrl} и введи токен:`,
      '',
      `    ${token}`,
      '',
      'Токен одноразовый. Новый: pnpm cli setup-token',
    ];
    const width = Math.max(...lines.map((l) => l.length)) + 4;
    const border = `+${'-'.repeat(width)}+`;
    const body = lines.map((l) => `|  ${l.padEnd(width - 2)}|`).join('\n');
    this.log.warn(`\n${border}\n${body}\n${border}`);
  }

  /** Возвращает id живого токена или null. Хеши сравниваются constant-time, без поиска по значению. */
  async validateToken(plain: string): Promise<string | null> {
    const hash = this.crypto.sha256Hex(plain.trim());
    let found: string | null = null;
    for (const row of await this.users.listUnusedSetupTokens()) {
      if (this.crypto.constantTimeEqual(hash, row.tokenHash)) found = row.id;
    }
    return found;
  }
}

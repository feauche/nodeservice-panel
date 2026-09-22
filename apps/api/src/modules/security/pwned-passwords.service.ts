import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2_500;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Проверка пароля по утечкам — Have I Been Pwned, k-anonymity: наружу уходят только первые
 * 5 символов SHA-1, сам пароль сервер HIBP не видит. Сеть недоступна → считаем «не найден»
 * (fail-open) и пишем предупреждение: панель не должна зависеть от внешнего сервиса.
 */
@Injectable()
export class PwnedPasswordsService {
  private readonly log = new Logger(PwnedPasswordsService.name);
  private readonly enabled: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(config: ConfigService<Env, true>, @Optional() fetchImpl?: FetchLike) {
    this.enabled = config.get('PASSWORD_LEAK_CHECK');
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** true — пароль встречается в известных утечках. */
  async isPwned(password: string): Promise<boolean> {
    if (!this.enabled) return false;
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await this.fetchImpl(RANGE_URL + prefix, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'NodeService-panel' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HIBP ответил ${res.status}`);
      const body = await res.text();
      for (const line of body.split('\n')) {
        const [hashSuffix, countRaw] = line.trim().split(':');
        if (hashSuffix === suffix && Number(countRaw) > 0) return true;
      }
      return false;
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Проверка пароля по утечкам недоступна — пропускаю',
      );
      return false;
    }
  }
}

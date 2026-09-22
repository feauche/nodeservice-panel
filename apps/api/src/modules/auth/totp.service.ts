import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { generate, generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

import { VALKEY } from '../../infra/valkey/valkey.module.js';

export const TOTP_ISSUER = 'NodeService';
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** Допуск ±1 шаг (30 с) на рассинхрон часов. */
const EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD;
/** Последний принятый шаг помним заведомо дольше окна допуска. */
const LAST_STEP_TTL_SECONDS = 10 * TOTP_PERIOD;

const lastStepKey = (userId: string): string => `totp:last:${userId}`;

export interface TotpEnrollment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** Решение anti-replay: принимать только шаги строго после последнего принятого. */
export function isReplay(timeStep: number, lastAcceptedStep: number | null): boolean {
  return lastAcceptedStep !== null && timeStep <= lastAcceptedStep;
}

@Injectable()
export class TotpService {
  private readonly log = new Logger(TotpService.name);

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async enroll(login: string): Promise<TotpEnrollment> {
    const secret = generateSecret();
    const otpauthUrl = generateURI({
      issuer: TOTP_ISSUER,
      label: login,
      secret,
      algorithm: 'sha1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
    });
    const svg = await QRCode.toString(otpauthUrl, { type: 'svg', margin: 1 });
    const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    return { secret, otpauthUrl, qrDataUrl };
  }

  /**
   * Проверяет код с окном ±1 шаг и защитой от повтора: принятый шаг запоминается
   * в Valkey, любой код с шагом <= последнего отклоняется (даже если он «правильный»).
   */
  async verify(userId: string, secret: string, code: string): Promise<boolean> {
    const lastRaw = await this.valkey.get(lastStepKey(userId));
    const last = lastRaw === null ? null : Number(lastRaw);
    let result: Awaited<ReturnType<typeof verify>>;
    try {
      result = await verify({
        secret,
        token: code,
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD,
        epochTolerance: EPOCH_TOLERANCE_SECONDS,
        ...(last !== null ? { afterTimeStep: last } : {}),
      });
    } catch (err) {
      // otplib бросает OTPError (например AfterTimeStepRangeExceededError, TokenFormatError) —
      // для нас это просто «код не подошёл», а не 500.
      this.log.warn(
        `TOTP verify отклонён с ошибкой: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      return false;
    }
    if (!result.valid) return false;
    const step = 'timeStep' in result ? result.timeStep : null;
    if (step === null || isReplay(step, last)) return false;
    await this.valkey.set(lastStepKey(userId), String(step), 'EX', LAST_STEP_TTL_SECONDS);
    return true;
  }

  async forget(userId: string): Promise<void> {
    await this.valkey.del(lastStepKey(userId));
  }

  /** Переносит память о последнем шаге (мастер первого запуска: временный ключ → id пользователя). */
  async adopt(fromKey: string, toKey: string): Promise<void> {
    const raw = await this.valkey.get(lastStepKey(fromKey));
    if (raw === null) return;
    await this.valkey
      .multi()
      .set(lastStepKey(toKey), raw, 'EX', LAST_STEP_TTL_SECONDS)
      .del(lastStepKey(fromKey))
      .exec();
  }

  /** Для тестов/CLI: текущий код по секрету. */
  currentCode(secret: string): Promise<string> {
    return generate({ secret, digits: TOTP_DIGITS, period: TOTP_PERIOD });
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

import type { Env } from '../../config/env.schema.js';

export type CookieKind = 'session' | 'trusted' | 'pending' | 'csrf';

/**
 * Имена и атрибуты cookie. На https — префикс `__Host-` (браузер требует Secure + Path=/ и
 * запрещает Domain), на http в разработке — без префикса, иначе браузер их просто отбросит.
 */
@Injectable()
export class CookiesService {
  readonly secure: boolean;
  readonly names: Record<CookieKind, string>;

  constructor(config: ConfigService<Env, true>) {
    this.secure = config.get('PUBLIC_URL').startsWith('https://');
    const prefix = this.secure ? '__Host-' : '';
    this.names = {
      session: `${prefix}sid`,
      trusted: `${prefix}td`,
      pending: `${prefix}pending`,
      csrf: `${prefix}ns.csrf`,
    };
  }

  options(maxAgeMs?: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: '/',
      ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
    };
  }

  set(res: Response, kind: CookieKind, value: string, maxAgeMs?: number): void {
    res.cookie(this.names[kind], value, this.options(maxAgeMs));
  }

  clear(res: Response, kind: CookieKind): void {
    res.clearCookie(this.names[kind], this.options());
  }

  read(req: Request, kind: CookieKind): string | undefined {
    const cookies = (req as { cookies?: Record<string, unknown> }).cookies;
    const value = cookies?.[this.names[kind]];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

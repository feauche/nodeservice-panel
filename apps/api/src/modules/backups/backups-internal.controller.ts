import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { Public } from '../auth/auth.decorators.js';
import { BackupsService } from './backups.service.js';

/** Подпись служебного запроса: HMAC от секрета установки — он есть только внутри контейнера api. */
export function internalSignature(appSecret: string, purpose: string): string {
  return createHmac('sha256', appSecret).update(`nodeservice-internal:${purpose}`).digest('hex');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Служебные запросы от `nodeservice update` (update.sh выполняет их командой внутри контейнера api).
 * Снаружи недоступны: только с самого контейнера (адрес сокета, а не X-Forwarded-For — через Caddy адрес
 * другой) и только с подписью из APP_SECRET. Без сессии и CSRF (см. setup-http).
 */
@ApiExcludeController()
@Controller('internal/backups')
export class BackupsInternalController {
  private readonly secret: string;

  constructor(
    private readonly backups: BackupsService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('APP_SECRET');
  }

  @Public()
  @Post('pre-update')
  @HttpCode(200)
  async preUpdate(@Req() req: Request): Promise<{ name: string; size: number; encrypted: boolean }> {
    const from = req.socket.remoteAddress ?? '';
    const sig = String(req.headers['x-nodeservice-internal'] ?? '');
    const want = internalSignature(this.secret, 'backup:pre_update');
    const ok =
      LOOPBACK.has(from) &&
      sig.length === want.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    if (!ok) throw problem(HttpStatus.NOT_FOUND, { detail: 'Не найдено.' });
    const item = await this.backups.runAndWait('pre_update', 'обновление панели');
    return { name: item.name, size: item.size, encrypted: item.encrypted };
  }
}

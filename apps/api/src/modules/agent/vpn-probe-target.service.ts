import { Injectable } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service.js';

const TTL_MS = 60_000;

/** Одноразовые токены публичной загрузки, доступной только во время настоящей VPN-пробы агента. */
@Injectable()
export class VpnProbeTargetService {
  private readonly tokens = new Map<string, number>();

  constructor(private readonly crypto: CryptoService) {}

  issue(): string {
    const now = Date.now();
    for (const [hash, expires] of this.tokens) if (expires <= now) this.tokens.delete(hash);
    const token = this.crypto.randomToken(32);
    this.tokens.set(this.crypto.sha256Hex(token), now + TTL_MS);
    return token;
  }

  consume(token: string): boolean {
    if (token.length < 32 || token.length > 200) return false;
    const hash = this.crypto.sha256Hex(token);
    const expires = this.tokens.get(hash);
    this.tokens.delete(hash);
    return expires !== undefined && expires > Date.now();
  }
}

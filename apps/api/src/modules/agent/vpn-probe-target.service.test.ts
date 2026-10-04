import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { VpnProbeTargetService } from './vpn-probe-target.service.js';

describe('одноразовая цель настоящей VPN-пробы', () => {
  it('принимает выпущенный токен ровно один раз', () => {
    const service = new VpnProbeTargetService({
      randomToken: () => '12345678901234567890123456789012',
      sha256Hex: (value: string) => createHash('sha256').update(value).digest('hex'),
    } as never);
    const token = service.issue();
    expect(service.consume(token)).toBe(true);
    expect(service.consume(token)).toBe(false);
    expect(service.consume('wrong-token-that-is-long-enough-000')).toBe(false);
  });
});

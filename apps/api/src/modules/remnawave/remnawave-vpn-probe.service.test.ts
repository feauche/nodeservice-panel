import { describe, expect, it } from 'vitest';

import { parseRealityRoutes } from './remnawave-vpn-probe.service.js';

const link =
  'vless://11111111-1111-1111-1111-111111111111@203.0.113.7:443?security=reality&type=tcp&sni=cdn.example.com&pbk=key#Казахстан%20-%201';

describe('service VPN subscription', () => {
  it('reads plain and base64 VLESS/REALITY routes', () => {
    expect(parseRealityRoutes(link)).toMatchObject([{ address: '203.0.113.7', name: 'Казахстан - 1' }]);
    expect(parseRealityRoutes(Buffer.from(`${link}\n`).toString('base64'))).toHaveLength(1);
  });

  it('ignores non-Reality and broken links', () => {
    expect(parseRealityRoutes('vless://id@example.com:443?security=tls\nbroken')).toEqual([]);
  });
});

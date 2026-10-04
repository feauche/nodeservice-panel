import { describe, expect, it } from 'vitest';

import {
  normalizeRouteName,
  parseRealityRoutes,
  RemnawaveVpnProbeService,
} from './remnawave-vpn-probe.service.js';

const link =
  'vless://11111111-1111-1111-1111-111111111111@203.0.113.7:443?security=reality&type=tcp&sni=cdn.example.com&pbk=key#Казахстан%20-%201';

describe('service VPN subscription', () => {
  it('reads plain and base64 VLESS/REALITY and Hysteria2 routes', () => {
    expect(parseRealityRoutes(link)).toMatchObject([
      { address: '203.0.113.7', port: 443, name: 'Казахстан - 1' },
    ]);
    expect(parseRealityRoutes(Buffer.from(`${link}\n`).toString('base64'))).toHaveLength(1);
    const hysteria = 'hysteria2://secret@hy.example.com:30443?sni=cdn.example.com#Германия%20-%202%20(hy2)';
    expect(parseRealityRoutes(hysteria)).toMatchObject([
      { address: 'hy.example.com', name: 'Германия - 2 (hy2)', protocol: 'hysteria2' },
    ]);
    expect(parseRealityRoutes(Buffer.from(`${hysteria}\n`).toString('base64'))).toHaveLength(1);
  });

  it('ignores non-Reality and broken links', () => {
    expect(parseRealityRoutes('vless://id@example.com:443?security=tls\nbroken')).toEqual([]);
  });

  it('сопоставляет имя ноды с подписью, где есть флаг и название протокола', () => {
    expect(normalizeRouteName('🇺🇸  США - 1 · VLESS TCP REALITY')).toBe('сша 1');
    expect(normalizeRouteName('🇩🇪 Германия - 2 (hy2)')).toBe('германия 2');
  });

  it('находит VLESS/REALITY по IP или очищенному имени с точным портом', async () => {
    const decorated =
      'vless://22222222-2222-2222-2222-222222222222@198.51.100.20:8443?security=reality&type=tcp&sni=cdn.example.com&pbk=key#%F0%9F%87%BA%F0%9F%87%B8%20%D0%A1%D0%A8%D0%90%20-%201%20%C2%B7%20VLESS%20TCP%20REALITY';
    const routes = parseRealityRoutes(`${link}\n${decorated}`);
    const store = {
      vpnProbe: async () => ({ url: 'https://subscription.example/probe', routes: 2, routeDetails: [] }),
    };
    const service = new RemnawaveVpnProbeService(store as never, {} as never);
    Object.assign(service as unknown as Record<string, unknown>, {
      cache: { url: 'https://subscription.example/probe', routes, until: Date.now() + 60_000 },
    });

    await expect(service.routeFor('другое имя', '203.0.113.7', 'vless-reality', 443)).resolves.toBe(link);
    await expect(service.routeFor('США - 1', '192.0.2.200', 'vless-reality', 8443)).resolves.toBe(decorated);
  });

  it('не путает номер ноды с началом другого номера', async () => {
    const usa10 =
      'vless://33333333-3333-3333-3333-333333333333@198.51.100.30:443?security=reality&type=tcp&sni=cdn.example.com&pbk=key#%D0%A1%D0%A8%D0%90%20-%2010';
    const routes = parseRealityRoutes(usa10);
    const service = new RemnawaveVpnProbeService(
      {
        vpnProbe: async () => ({ url: 'https://subscription.example/probe', routes: 1, routeDetails: [] }),
      } as never,
      {} as never,
    );
    Object.assign(service as unknown as Record<string, unknown>, {
      cache: { url: 'https://subscription.example/probe', routes, until: Date.now() + 60_000 },
    });
    await expect(service.routeFor('США - 1', '192.0.2.200', 'vless-reality', 443)).resolves.toBeNull();
  });
});

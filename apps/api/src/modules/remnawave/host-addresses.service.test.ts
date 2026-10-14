import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAddressesService, type HostResolver } from './host-addresses.service.js';

/** DNS, который отвечает по заранее заданному порядку: каждый вызов берёт следующий ответ, последний повторяется. */
function scripted(...answers: string[][]): HostResolver & { calls: number } {
  const resolver = {
    calls: 0,
    resolve: async () => {
      const answer = answers[Math.min(resolver.calls, answers.length - 1)] ?? [];
      resolver.calls += 1;
      return answer;
    },
  };
  return resolver;
}

afterEach(() => vi.useRealTimers());

describe('адреса Host из DNS', () => {
  it('IP-адрес в DNS не отправляется, домен разрешается', async () => {
    const dns = scripted(['203.0.113.7']);
    const addresses = new HostAddressesService(dns);
    const map = await addresses.resolveAddresses(['198.51.100.1', 'tusa.example.org']);
    expect(map.get('198.51.100.1')).toEqual(['198.51.100.1']);
    expect(map.get('tusa.example.org')).toEqual(['203.0.113.7']);
    expect(dns.calls).toBe(1);
  });

  it('удачный ответ переживает сбой DNS: связь Host с нодой не рвётся', async () => {
    vi.useFakeTimers();
    const dns = scripted(['203.0.113.7'], []);
    const addresses = new HostAddressesService(dns);
    await addresses.resolveAddresses(['tusa.example.org']);
    // Ответ состарился (10 минут), DNS не отвечает — держимся за прежний.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const map = await addresses.resolveAddresses(['tusa.example.org']);
    expect(map.get('tusa.example.org')).toEqual(['203.0.113.7']);
    expect(dns.calls).toBe(2);
  });

  it('неудачный ответ обычное чтение не повторяет сразу, принудительное — спрашивает заново', async () => {
    vi.useFakeTimers();
    const dns = scripted([], ['203.0.113.7']);
    const addresses = new HostAddressesService(dns);
    expect((await addresses.resolveAddresses(['tusa.example.org'])).get('tusa.example.org')).toEqual([]);
    // Сразу же обычное чтение: DNS не дёргаем, помним неудачу.
    expect((await addresses.resolveAddresses(['tusa.example.org'])).get('tusa.example.org')).toEqual([]);
    expect(dns.calls).toBe(1);
    // Сценарий читает принудительно: помнить неудачу нельзя — иначе сбой в момент падения ноды держится всю минуту
    // ожидания сценария, и тот «не видит» Host.
    const forced = await addresses.resolveAddresses(['tusa.example.org'], { retryFailed: true });
    expect(forced.get('tusa.example.org')).toEqual(['203.0.113.7']);
    expect(dns.calls).toBe(2);
  });

  it('неудача забывается быстро — через 15 секунд обычное чтение спрашивает DNS снова', async () => {
    vi.useFakeTimers();
    const dns = scripted([], ['203.0.113.7']);
    const addresses = new HostAddressesService(dns);
    await addresses.resolveAddresses(['tusa.example.org']);
    vi.setSystemTime(Date.now() + 16_000);
    expect((await addresses.resolveAddresses(['tusa.example.org'])).get('tusa.example.org')).toEqual([
      '203.0.113.7',
    ]);
  });
});

import { BadRequestException, HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Db } from '../../infra/db/db.module.js';
import { IntegrationsService } from './integrations.service.js';

describe('integrations · real provider contracts and secret handling', () => {
  const fetchMock = vi.fn();
  const saved = vi.fn();
  const encrypt = vi.fn(() => 'encrypted');
  const db = {
    insert: vi.fn(() => ({ values: (value: unknown) => ({ onConflictDoUpdate: async () => saved(value) }) })),
  };
  let service: IntegrationsService;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    service = new IntegrationsService(db as unknown as Db, { encrypt } as unknown as CryptoService);
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it('encrypts successful credentials; only balance and status reach the browser', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { balance: '12.50', token: 'provider-private' } }));
    const result = await service.connect('dpi', { apiKey: 'sensitive-test-token' });
    expect(result.balance).toBe('12.50');
    expect(result.connected).toBe(true);
    expect(encrypt).toHaveBeenCalledWith(JSON.stringify({ apiKey: 'sensitive-test-token' }));
    expect(JSON.stringify(saved.mock.calls)).not.toContain('sensitive-test-token');
    expect(JSON.stringify(result)).not.toContain('provider-private');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { 'X-API-Key': 'sensitive-test-token' },
    });
  });
  it('does not replace working credentials on failure or expose provider errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'sensitive-test-token' }, 401));
    await expect(service.connect('dpi', { apiKey: 'sensitive-test-token' })).rejects.toThrow(HttpException);
    expect(saved).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
  });
  it('rejects malformed successful responses', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(service.connect('dpi', { apiKey: 'test-token' })).rejects.toThrow(HttpException);
    expect(saved).not.toHaveBeenCalled();
  });
  it('loads all Cloudflare pages, without limiting domains to the first 50', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ success: true, result: [{ name: 'one.example' }], result_info: { total_pages: 2 } }),
      )
      .mockResolvedValueOnce(
        json({ success: true, result: [{ name: 'two.example' }], result_info: { total_pages: 2 } }),
      );
    const result = await service.connect('cloudflare', { apiKey: 'test-token' });
    expect(result.domains).toEqual(['one.example', 'two.example']);
    expect(fetchMock.mock.calls[1][0]).toContain('page=2');
  });
  it('passes REG.RU credentials only in the POST body and reads domain services', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ result: 'success', answer: { services: [{ dname: 'example.test' }] } }),
    );
    expect(
      (await service.connect('regru', { username: 'test-login', password: 'test-password' })).domains,
    ).toEqual(['example.test']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.reg.ru/api/regru2/service/get_list');
    expect(fetchMock.mock.calls[0][1].body.get('password')).toBe('test-password');
    expect(JSON.stringify(saved.mock.calls)).not.toContain('test-password');
  });
  it('missing credentials do not make requests', async () => {
    await expect(service.connect('regru', {})).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

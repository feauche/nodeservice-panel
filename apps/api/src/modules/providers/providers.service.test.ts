import { describe, expect, it, vi } from 'vitest';

import { ProvidersService } from './providers.service.js';

const provider = (archivedAt: Date | null = null) => ({
  id: '0199a4be-d35a-7000-8000-000000000001',
  name: 'Time Web',
  siteUrl: 'https://timeweb.cloud',
  note: null,
  iconType: null,
  iconData: null,
  iconVersion: 0,
  iconUrl: null,
  iconSourceUrl: null,
  iconPending: false,
  archivedAt,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  serversCount: 2,
});

function make() {
  const repo = {
    findById: vi.fn(async () => provider()),
    findByName: vi.fn(async () => undefined),
    archive: vi.fn(async () => true),
    update: vi.fn(async () => provider()),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new ProvidersService(repo as never, {} as never, audit as never, {} as never);
  vi.spyOn(service as unknown as { startIconJob(id: string): void }, 'startIconJob').mockImplementation(
    () => undefined,
  );
  return { service, repo, audit };
}

describe('ProvidersService: безопасное архивирование', () => {
  it('архивирует провайдера и сохраняет факт сохранения платёжной истории в Журнале', async () => {
    const { service, repo, audit } = make();

    await service.delete(provider().id);

    expect(repo.archive).toHaveBeenCalledWith(provider().id);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provider.archived',
        metadata: { serversDetached: 2, billingHistoryPreserved: true },
      }),
    );
  });

  it('при повторном создании восстанавливает прежнюю запись с её историей', async () => {
    const { service, repo, audit } = make();
    repo.findByName.mockResolvedValue(provider(new Date('2026-10-04T00:00:00.000Z')));

    const result = await service.create({ name: 'Time Web', siteUrl: 'https://timeweb.cloud' });

    expect(repo.update).toHaveBeenCalledWith(
      provider().id,
      expect.objectContaining({ archivedAt: null, siteUrl: 'https://timeweb.cloud' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'provider.restored', metadata: { billingHistoryPreserved: true } }),
    );
    expect(result.name).toBe('Time Web');
  });
});

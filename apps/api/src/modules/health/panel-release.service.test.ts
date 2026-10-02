import { ConfigService } from '@nestjs/config';
import type { PanelRelease } from '@nodeservice/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env.schema.js';
import { PanelReleaseService } from './panel-release.service.js';

const config = new ConfigService<Env, true>({ PANEL_REPO: 'feauche/nodeservice-panel' });

describe('PanelReleaseService', () => {
  let service: PanelReleaseService;

  beforeEach(() => {
    service = new PanelReleaseService(config);
    service.now = () => Date.parse('2026-10-02T10:00:00.000Z');
  });

  it('новый релиз: нормализует v, дату и показывает обновление', async () => {
    service.fetchImpl = vi.fn(async () =>
      Response.json({
        tag_name: 'v99.1.0',
        name: 'NodeService Panel v99.1.0',
        html_url: 'https://github.com/feauche/nodeservice-panel/releases/tag/v99.1.0',
        published_at: '2026-10-02T09:00:00Z',
        body: '  Новый релиз.  ',
      }),
    ) as typeof fetch;

    await expect(service.latest()).resolves.toMatchObject({
      latestVersion: '99.1.0',
      status: 'available',
      checkedAt: '2026-10-02T10:00:00.000Z',
      release: { publishedAt: '2026-10-02T09:00:00.000Z', notes: 'Новый релиз.' },
    } satisfies Partial<PanelRelease>);
  });

  it('один сетевой запрос на параллельные вызовы и кеш', async () => {
    const fetcher = vi.fn(async () => Response.json({ tag_name: 'v0.1.0' }));
    service.fetchImpl = fetcher as typeof fetch;
    const [a, b] = await Promise.all([service.latest(), service.latest()]);
    expect(a.status).toBe('current');
    expect(b).toEqual(a);
    await service.latest();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('ошибка GitHub не выдаёт выдуманную версию', async () => {
    service.fetchImpl = vi.fn(async () => new Response('{}', { status: 403 })) as typeof fetch;
    await expect(service.latest()).resolves.toMatchObject({
      latestVersion: null,
      status: 'unavailable',
      release: null,
    });
  });

  it('не отдаёт ссылку на чужой сайт из ответа GitHub', async () => {
    service.fetchImpl = vi.fn(async () =>
      Response.json({ tag_name: 'v99.1.0', html_url: 'https://evil.example/release' }),
    ) as typeof fetch;
    const result = await service.latest();
    expect(result.release?.url).toBe('https://github.com/feauche/nodeservice-panel/releases/latest');
  });
});

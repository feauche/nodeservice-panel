import { type Provider, providerSiteHost } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockServers } from './servers-mock';

/** Мок справочника провайдеров: состояние в памяти, иконка «находится» у сайтов с известным хостом. */
export const mockProviders: { items: Provider[]; iconHosts: Set<string> } = {
  items: [],
  iconHosts: new Set(['aeza.net', 'hetzner.com', 'timeweb.cloud']),
};

let seq = 0;
const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
/** Автопоиск «находит» иконку у известных хостов; ручная ссылка — если в ней есть favicon или icon. */
const autoSource = (siteUrl: string) =>
  mockProviders.iconHosts.has(providerSiteHost(siteUrl))
    ? `${withScheme(siteUrl).replace(/\/$/, '')}/favicon.ico`
    : null;
const manualSource = (iconUrl: string) => (/favicon|icon/i.test(iconUrl) ? withScheme(iconUrl) : null);
const resolveIcon = (siteUrl: string, iconUrl: string | null) =>
  iconUrl ? manualSource(iconUrl) : autoSource(siteUrl);

function make(
  name: string,
  siteUrl: string,
  note: string | null = null,
  iconUrl: string | null = null,
): Provider {
  seq += 1;
  const host = providerSiteHost(siteUrl);
  const source = resolveIcon(siteUrl, iconUrl);
  return {
    id: `0192c000-1111-7000-8000-${String(seq).padStart(12, '0')}`,
    name,
    siteUrl,
    siteHost: host,
    hasIcon: source !== null,
    iconUrl,
    iconSourceUrl: source,
    iconVersion: 1,
    note,
    serversCount: 0,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
  };
}

export function seedProviders(): void {
  seq = 0;
  mockProviders.items = [
    make('Aéza', 'https://aeza.net', 'аккаунт lumax@…, оплата до 5 октября'),
    make('Hetzner', 'https://hetzner.com'),
    make('Timeweb', 'https://timeweb.cloud'),
  ];
}

const withCounts = (): Provider[] =>
  mockProviders.items.map((p) => ({
    ...p,
    serversCount: mockServers.items.filter((s) => s.providerId === p.id).length,
  }));

const problem = (status: number, type: string, detail: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json(
    { type, title: detail, status, detail, ...extra },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** 1×1 PNG для <img> иконок. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const providersHandlers = [
  http.get('/api/providers', () => HttpResponse.json({ items: withCounts() })),
  http.post('/api/providers', async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      siteUrl: string;
      note?: string;
      iconUrl?: string | null;
    };
    const name = body.name?.trim();
    if (!name)
      return problem(422, 'about:blank', 'Проверьте поля', {
        errors: [{ path: 'name', message: 'Введите название' }],
      });
    if (mockProviders.items.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return problem(
        409,
        'urn:nodeservice:problem:provider-name-taken',
        `Провайдер «${name}» уже есть в справочнике.`,
        {
          errors: [{ path: 'name', message: 'Название уже занято' }],
        },
      );
    const p = make(
      name,
      withScheme(body.siteUrl),
      body.note?.trim() || null,
      body.iconUrl ? withScheme(body.iconUrl) : null,
    );
    mockProviders.items.push(p);
    return HttpResponse.json(p, { status: 201 });
  }),
  http.post('/api/providers/icon-preview', async ({ request }) => {
    const body = (await request.json()) as { siteUrl: string; iconUrl?: string | null };
    const source = resolveIcon(withScheme(body.siteUrl), body.iconUrl ? withScheme(body.iconUrl) : null);
    return HttpResponse.json({ iconDataUrl: source ? PNG_DATA_URL : null, sourceUrl: source });
  }),
  http.patch('/api/providers/:id', async ({ params, request }) => {
    const p = mockProviders.items.find((x) => x.id === params.id);
    if (!p) return problem(404, 'urn:nodeservice:problem:provider-not-found', 'Провайдер не найден');
    const body = (await request.json()) as {
      name?: string;
      siteUrl?: string;
      note?: string | null;
      iconUrl?: string | null;
    };
    if (body.name !== undefined) p.name = body.name.trim();
    if (body.siteUrl !== undefined) {
      p.siteUrl = withScheme(body.siteUrl);
      p.siteHost = providerSiteHost(p.siteUrl);
    }
    if (body.iconUrl !== undefined) p.iconUrl = body.iconUrl ? withScheme(body.iconUrl) : null;
    if (body.siteUrl !== undefined || body.iconUrl !== undefined) {
      p.iconSourceUrl = resolveIcon(p.siteUrl, p.iconUrl);
      p.hasIcon = p.iconSourceUrl !== null;
      p.iconVersion += 1;
    }
    if (body.note !== undefined) p.note = body.note?.trim() || null;
    p.updatedAt = new Date().toISOString();
    return HttpResponse.json(withCounts().find((x) => x.id === p.id));
  }),
  http.delete('/api/providers/:id', ({ params }) => {
    const i = mockProviders.items.findIndex((x) => x.id === params.id);
    if (i < 0) return problem(404, 'urn:nodeservice:problem:provider-not-found', 'Провайдер не найден');
    mockProviders.items.splice(i, 1);
    for (const s of mockServers.items) if (s.providerId === params.id) s.providerId = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/providers/:id/icon/refresh', ({ params }) => {
    const p = mockProviders.items.find((x) => x.id === params.id);
    if (!p) return problem(404, 'urn:nodeservice:problem:provider-not-found', 'Провайдер не найден');
    p.iconSourceUrl = resolveIcon(p.siteUrl, p.iconUrl);
    p.hasIcon = p.iconSourceUrl !== null;
    p.iconVersion += 1;
    return HttpResponse.json(withCounts().find((x) => x.id === p.id));
  }),
  http.get('/api/providers/:id/servers', ({ params }) =>
    HttpResponse.json(
      mockServers.items.filter((s) => s.providerId === params.id).map((s) => ({ id: s.id, name: s.name })),
    ),
  ),
  http.get('/api/providers/:id/icon', ({ params }) => {
    const p = mockProviders.items.find((x) => x.id === params.id);
    if (!p?.hasIcon) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } });
  }),
];

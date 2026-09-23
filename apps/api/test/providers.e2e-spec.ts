import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, providerSchema, providersResponseSchema, serverSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { extractIconLinks, isPrivateHost, sanitizeSvg } from '../src/modules/providers/icon-fetch.service.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';
/** 1×1 PNG — «иконка сайта». */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Запасной кэш иконок (аналог Google): включается только в своём тесте. */
let fallbackOn = false;

/** Сайт хостера: HTML с <link rel="icon">, сама иконка, и второй сайт без иконок вовсе. */
function fakeSite(): Promise<{ server: HttpServer; url: string; bare: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/fallback/')) {
      // как Google: картинка для известного хоста, 404 для неизвестного
      if (fallbackOn && req.url === '/fallback/127.0.0.1') {
        res.setHeader('content-type', 'image/png');
        res.end(PNG);
      } else {
        res.statusCode = 404;
        res.end();
      }
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><head><link rel="apple-touch-icon" href="/big.png"><link rel="icon" sizes="32x32" href="/i/fav.png"></head><body>Hoster</body></html>',
      );
    } else if (req.url === '/i/fav.png') {
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
    } else if (req.url === '/bare/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>no icons</body></html>');
    } else if (req.url === '/redir/') {
      // Редирект на главную: иконку берём уже с конечного адреса.
      res.statusCode = 302;
      res.setHeader('location', '/');
      res.end();
    } else if (req.url === '/loop/') {
      res.statusCode = 302;
      res.setHeader('location', '/loop/');
      res.end();
    } else if (req.url === '/svg/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><link rel="icon" href="/icon.svg"></head><body>svg only</body></html>');
    } else if (req.url === '/icon.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><circle r="4" fill="#09f"/></svg>',
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, bare: `http://127.0.0.1:${port}/bare/` });
    }),
  );
}

describe('providers e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  let site: Awaited<ReturnType<typeof fakeSite>>;
  let providerId = '';

  beforeAll(async () => {
    site = await fakeSite();
    process.env.PROVIDER_ICON_FALLBACK_URL = `${site.url}fallback/{host}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, providers cascade`,
    );
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: LOGIN, password: PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => site.server.close(() => r()));
  });

  it('разбор <link rel=icon>: маленькая иконка раньше apple-touch, data: пропускается', () => {
    const links = extractIconLinks(
      '<link rel="apple-touch-icon" href="/a.png"><link rel="shortcut icon" href="/f.ico"><link rel="icon" href="data:x"><link rel="icon" sizes="32x32" href="/32.png">',
    );
    expect(links).toEqual(['/32.png', '/f.ico', '/a.png']);
  });

  it('создание: сайт без схемы дополняется https, иконка берётся с сайта, запись в Журнале', async () => {
    const res = await agent
      .post('/api/providers')
      .set(CSRF_HEADER, csrf)
      .send({ name: 'Aéza', siteUrl: site.url.replace('http://', ''), note: 'аккаунт lumax' })
      .expect(201);
    const p = providerSchema.parse(res.body);
    providerId = p.id;
    // «127.0.0.1:port/» без схемы → https://…, иконку с https не найти; ниже — явный http.
    expect(p.siteUrl.startsWith('https://')).toBe(true);
    const fixed = providerSchema.parse(
      (
        await agent
          .patch(`/api/providers/${p.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ siteUrl: site.url })
          .expect(200)
      ).body,
    );
    expect(fixed).toMatchObject({
      name: 'Aéza',
      siteHost: '127.0.0.1',
      hasIcon: true,
      note: 'аккаунт lumax',
      serversCount: 0,
    });
    const icon = await agent.get(`/api/providers/${p.id}/icon`).expect(200);
    expect(icon.headers['content-type']).toContain('image/png');
    expect(Buffer.from(icon.body as Buffer).equals(PNG)).toBe(true);
    const audit = (await agent.get('/api/audit?category=server').expect(200)).body as {
      items: Array<{ action: string }>;
    };
    expect(audit.items.some((e) => e.action === 'provider.created')).toBe(true);
    expect(audit.items.some((e) => e.action === 'provider.updated')).toBe(true);
  });

  it('дубль названия без учёта регистра — 409 с ошибкой у поля; превью иконки до сохранения', async () => {
    const dup = await agent
      .post('/api/providers')
      .set(CSRF_HEADER, csrf)
      .send({ name: 'AÉZA', siteUrl: site.url })
      .expect(409);
    expect(dup.body.errors?.[0]?.path).toBe('name');
    const prev = await agent
      .post('/api/providers/icon-preview')
      .set(CSRF_HEADER, csrf)
      .send({ siteUrl: site.url })
      .expect(200);
    expect(prev.body.iconDataUrl).toMatch(/^data:image\/png;base64,/);
    const none = await agent
      .post('/api/providers/icon-preview')
      .set(CSRF_HEADER, csrf)
      .send({ siteUrl: site.bare })
      .expect(200);
    expect(none.body.iconDataUrl).toBeNull();
  });

  it('иконка: редирект по одному шагу доходит до цели, петля обрывается, SVG чистится от скриптов', async () => {
    const preview = async (path: string, iconUrl?: string) =>
      (
        await agent
          .post('/api/providers/icon-preview')
          .set(CSRF_HEADER, csrf)
          .send({ siteUrl: `${site.url}${path}`, ...(iconUrl ? { iconUrl } : {}) })
          .expect(200)
      ).body as { iconDataUrl: string | null; sourceUrl: string | null };
    expect((await preview('redir/')).iconDataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await preview('redir/')).sourceUrl).toBe(`${site.url}i/fav.png`);
    expect((await preview('loop/')).iconDataUrl).toBeNull();
    const svg = await preview('svg/');
    expect(svg.iconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const body = Buffer.from(svg.iconDataUrl?.split(',')[1] ?? '', 'base64').toString('utf8');
    expect(body).toContain('<circle');
    expect(body).not.toMatch(/script|onload/i);
    // ручная ссылка: сайт без иконок, но картинка задана явно
    const manual = await preview('bare/', `${site.url}i/fav.png`);
    expect(manual.iconDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(manual.sourceUrl).toBe(`${site.url}i/fav.png`);
    expect((await preview('bare/', `${site.url}nope.png`)).iconDataUrl).toBeNull();
  });

  it('запасной кэш иконок: сайт без иконки получает её оттуда, источник — адрес кэша', async () => {
    fallbackOn = true;
    try {
      const prev = await agent
        .post('/api/providers/icon-preview')
        .set(CSRF_HEADER, csrf)
        .send({ siteUrl: site.bare })
        .expect(200);
      expect(prev.body.iconDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(prev.body.sourceUrl).toBe(`${site.url}fallback/127.0.0.1`);
    } finally {
      fallbackOn = false;
    }
  });

  it('ручная ссылка на иконку сохраняется, сброс в null возвращает автопоиск', async () => {
    const created = providerSchema.parse(
      (
        await agent
          .post('/api/providers')
          .set(CSRF_HEADER, csrf)
          .send({ name: 'Manual', siteUrl: site.bare, iconUrl: `${site.url}i/fav.png` })
          .expect(201)
      ).body,
    );
    expect(created).toMatchObject({
      hasIcon: true,
      iconUrl: `${site.url}i/fav.png`,
      iconSourceUrl: `${site.url}i/fav.png`,
    });
    const auto = providerSchema.parse(
      (
        await agent
          .patch(`/api/providers/${created.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ iconUrl: null })
          .expect(200)
      ).body,
    );
    expect(auto).toMatchObject({ hasIcon: false, iconUrl: null, iconSourceUrl: null });
    await agent.delete(`/api/providers/${created.id}`).set(CSRF_HEADER, csrf).expect(204);
  });

  it('sanitizeSvg: скрипты, обработчики и внешние ссылки вырезаются, обычный SVG остаётся', () => {
    expect(
      sanitizeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><path d="M0 0" onclick="x()"/></svg>',
      ),
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    expect(
      sanitizeSvg('<svg><use xlink:href="https://evil/x.svg#a"/><image href="data:text/html,x"/></svg>'),
    ).toBe('<svg><use/><image/></svg>');
    expect(sanitizeSvg('<html>nope</html>')).toBeNull();
  });

  it('внутренние адреса не считаются публичными (в т.ч. IPv4 внутри IPv6 и localhost-домены)', () => {
    for (const h of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      '::ffff:10.0.0.1',
      'fd00::1',
      'localhost',
      'db.internal',
      'nas.local',
    ])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ['8.8.8.8', '172.32.0.1', 'hetzner.com', '2606:4700::1111'])
      expect(isPrivateHost(h), h).toBe(false);
  });

  it('иконка отдаётся с защитными заголовками', async () => {
    const icon = await agent.get(`/api/providers/${providerId}/icon`).expect(200);
    expect(icon.headers['x-content-type-options']).toBe('nosniff');
    expect(icon.headers['content-security-policy']).toContain('sandbox');
  });

  it('сервер с провайдером: создание, смена, счётчик; несуществующий провайдер — 422', async () => {
    const created = await agent
      .post('/api/servers')
      .set(CSRF_HEADER, csrf)
      .send({
        name: 'prov-host',
        host: '203.0.113.9',
        port: 22,
        sshUser: 'root',
        auth: { method: 'panel-key' },
        verify: false,
        providerId,
      })
      .expect(201);
    const srv = serverSchema.parse(created.body);
    expect(srv.providerId).toBe(providerId);
    const list = providersResponseSchema.parse((await agent.get('/api/providers').expect(200)).body);
    expect(list.items.find((p) => p.id === providerId)?.serversCount).toBe(1);
    const servers = (await agent.get(`/api/providers/${providerId}/servers`).expect(200)).body as Array<{
      name: string;
    }>;
    expect(servers.map((s) => s.name)).toEqual(['prov-host']);
    const bad = await agent
      .patch(`/api/servers/${srv.id}`)
      .set(CSRF_HEADER, csrf)
      .send({ providerId: '00000000-0000-4000-8000-000000000000' })
      .expect(422);
    expect(bad.body.errors?.[0]?.path).toBe('providerId');
    const cleared = serverSchema.parse(
      (
        await agent
          .patch(`/api/servers/${srv.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ providerId: null })
          .expect(200)
      ).body,
    );
    expect(cleared.providerId).toBeNull();
    await agent.patch(`/api/servers/${srv.id}`).set(CSRF_HEADER, csrf).send({ providerId }).expect(200);
  });

  it('удаление провайдера: у сервера провайдер сбрасывается, иконка 404, Журнал', async () => {
    await agent.delete(`/api/providers/${providerId}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.get(`/api/providers/${providerId}/icon`).expect(404);
    const servers = (await agent.get('/api/servers').expect(200)).body as {
      items: Array<{ name: string; providerId: string | null }>;
    };
    expect(servers.items.find((s) => s.name === 'prov-host')?.providerId).toBeNull();
    const audit = (await agent.get('/api/audit?category=server').expect(200)).body as {
      items: Array<{ action: string; metadata: Record<string, unknown> }>;
    };
    expect(audit.items.find((e) => e.action === 'provider.deleted')?.metadata).toMatchObject({
      serversDetached: 1,
    });
  });
});

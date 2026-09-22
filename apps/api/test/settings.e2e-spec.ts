import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  APPEARANCE_DEFAULTS,
  AUTH_PROBLEM,
  CSRF_HEADER,
  TERMINAL_SNIPPETS_DEFAULTS,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

describe('settings e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(sql`delete from app_meta where key like 'settings.%'`);
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/settings/appearance открыт и отдаёт значения по умолчанию', async () => {
    const res = await agent.get('/api/settings/appearance').expect(200);
    expect(res.body).toEqual(APPEARANCE_DEFAULTS);
  });

  it('PUT без сессии → 401 unauthenticated', async () => {
    const res = await agent
      .put('/api/settings/appearance')
      .set(CSRF_HEADER, csrf)
      .send({ logoUrl: 'https://example.com/logo.svg' })
      .expect(401);
    expect(res.body.type).toBe(AUTH_PROBLEM.unauthenticated);
  });

  it('сервис: сохраняет и читает логотип, отклоняет не-http ссылку', async () => {
    const svc = app.get(SettingsService);
    expect(await svc.updateAppearance({ logoUrl: 'https://example.com/logo.svg' })).toEqual({
      ...APPEARANCE_DEFAULTS,
      logoUrl: 'https://example.com/logo.svg',
    });
    expect((await svc.getAppearance()).logoUrl).toBe('https://example.com/logo.svg');
    await expect(svc.updateAppearance({ logoUrl: 'javascript:alert(1)' })).rejects.toThrow();
    // название с цветами — хранится как есть, в БД (app_meta)
    expect((await svc.updateAppearance({ brandName: '[#ff6b6b]My[#accent]Panel' })).brandName).toBe(
      '[#ff6b6b]My[#accent]Panel',
    );
    await expect(svc.updateAppearance({ brandName: '[#accent]' })).rejects.toThrow();
    expect(await svc.updateAppearance({ logoUrl: null, brandName: APPEARANCE_DEFAULTS.brandName })).toEqual(
      APPEARANCE_DEFAULTS,
    );
  });

  it('сниппеты терминала: пусто по умолчанию, сохраняются целиком, многострочная команда отклоняется', async () => {
    const svc = app.get(SettingsService);
    expect(await svc.getSnippets()).toEqual(TERMINAL_SNIPPETS_DEFAULTS);
    const id = '11111111-1111-4111-8111-111111111111';
    const saved = await svc.updateSnippets({ items: [{ id, name: 'Соединения', command: 'ss -s' }] });
    expect(saved.items).toHaveLength(1);
    expect((await svc.getSnippets()).items[0]?.command).toBe('ss -s');
    await expect(
      svc.updateSnippets({ items: [{ id, name: 'x', command: 'ls\nrm -rf /' }] }),
    ).rejects.toThrow();
    expect(await svc.updateSnippets({ items: [] })).toEqual(TERMINAL_SNIPPETS_DEFAULTS);
  });

  it('GET /api/settings/snippets без сессии → 401', async () => {
    const res = await agent.get('/api/settings/snippets').expect(401);
    expect(res.body.type).toBe(AUTH_PROBLEM.unauthenticated);
  });
});

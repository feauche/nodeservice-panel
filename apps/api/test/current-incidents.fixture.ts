import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, type IncidentKind } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { LLM_PROVIDER } from '../src/modules/assistant/llm.provider.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { IncidentsRepository } from '../src/modules/incidents/incidents.repository.js';

export async function currentIncidentApp() {
  if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test')) throw new Error('Только nodeservice_test');
  const llm = { run: vi.fn() };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_PROVIDER)
    .useValue(llm)
    .compile();
  const app: INestApplication = module.createNestApplication<NestExpressApplication>({ logger: false });
  setupHttp(app as NestExpressApplication);
  const db = app.get<Db>(DB);
  await runMigrations(db);
  await db.execute(
    sql`truncate users, recovery_codes, trusted_devices, setup_tokens, incidents, servers cascade`,
  );
  await db.execute(sql`delete from app_meta where key like 'settings.%' or key like 'monitor.%'`);
  await app.get<Redis>(VALKEY).flushdb();
  await app.init();
  const agent = request.agent(app.getHttpServer());
  const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token;
  const start = await agent
    .post('/api/auth/setup/start')
    .set(CSRF_HEADER, csrf)
    .send({
      setupToken: await app.get(SetupService).issueToken(),
      login: 'admin',
      password: 'correct horse battery staple',
    })
    .expect(200);
  await agent
    .post('/api/auth/setup/confirm')
    .set(CSRF_HEADER, csrf)
    .send({ code: await generate({ secret: start.body.totpSecret }) })
    .expect(200);
  const repo = app.get(IncidentsRepository);
  const seed = async (kind: IncidentKind = 'node_down', nodeUuid = crypto.randomUUID()) => {
    const row = await repo.open({
      nodeUuid,
      serverId: null,
      serverName: 'Нода Remnawave',
      kind,
      severity: 'crit',
      title: 'Сбой ноды',
      detail: 'История наблюдения',
      timeline: [
        { at: new Date().toISOString(), by: 'auto', action: 'Обнаружено Remnawave', result: 'detect' },
      ],
    });
    if (!row) throw new Error('Не удалось создать fixture');
    return row;
  };
  return { app, db, agent, csrf, repo, seed, llm };
}

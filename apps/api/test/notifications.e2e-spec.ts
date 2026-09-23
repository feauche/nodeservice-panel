import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, notificationSchema, notificationsResponseSchema } from '@nodeservice/shared';
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
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';

const LOGIN = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('notifications e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, notifications cascade`,
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
  });

  it('серверное push + всплывашка клиента; непрочитанные; прочитать все; удалить одно; очистить', async () => {
    await app.get(NotificationsService).push({
      severity: 'warn',
      title: 'Инцидент: ждёт подтверждения',
      body: 'Перезапустить контейнер ноды',
      link: { to: '/incidents?open=x', label: 'Открыть инцидент' },
    });
    const created = notificationSchema.parse(
      (
        await agent
          .post('/api/notifications')
          .set(CSRF_HEADER, csrf)
          .send({ severity: 'ok', title: 'Провайдер «4VPS» добавлен' })
          .expect(201)
      ).body,
    );
    expect(created.readAt).toBeNull();
    // без заголовка — 400
    await agent
      .post('/api/notifications')
      .set(CSRF_HEADER, csrf)
      .send({ severity: 'ok', title: '' })
      .expect(400);

    const list = notificationsResponseSchema.parse((await agent.get('/api/notifications').expect(200)).body);
    expect(list.unread).toBe(2);
    expect(list.total).toBe(2);
    expect(list.items[0]?.title).toBe('Провайдер «4VPS» добавлен');
    expect(list.items[1]?.link).toEqual({ to: '/incidents?open=x', label: 'Открыть инцидент' });
    // время — ISO в UTC
    expect(list.items[0]?.createdAt.endsWith('Z')).toBe(true);

    expect((await agent.post('/api/notifications/read-all').set(CSRF_HEADER, csrf).expect(200)).body).toEqual(
      { unread: 0 },
    );
    const read = notificationsResponseSchema.parse((await agent.get('/api/notifications').expect(200)).body);
    expect(read.unread).toBe(0);
    expect(read.items.every((n) => n.readAt !== null)).toBe(true);

    await agent.delete(`/api/notifications/${created.id}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.delete(`/api/notifications/${created.id}`).set(CSRF_HEADER, csrf).expect(404);
    expect(
      notificationsResponseSchema.parse((await agent.get('/api/notifications').expect(200)).body).total,
    ).toBe(1);

    await agent.delete('/api/notifications').set(CSRF_HEADER, csrf).expect(204);
    expect(
      notificationsResponseSchema.parse((await agent.get('/api/notifications').expect(200)).body).total,
    ).toBe(0);
  });
});

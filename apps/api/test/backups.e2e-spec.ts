import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  backupInspectSchema,
  backupSettingsSchema,
  backupsResponseSchema,
  CSRF_HEADER,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupHttp } from '../src/common/http/setup-http.js';
import { DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { BACKUP_TOOLS, type BackupTools } from '../src/modules/backups/backup-tools.js';
import { BackupsService } from '../src/modules/backups/backups.service.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const PASSWORD = 'correct horse battery staple';

/** Вместо pg_dump/pg_restore: «дамп» — файл с подписью PGDMP, восстановление — только запоминаем. */
class FakeTools implements BackupTools {
  restored: string[] = [];
  async check() {
    return { ok: true, reason: null };
  }
  async dump(out: string) {
    writeFileSync(out, 'PGDMP fake dump TABLE users');
  }
  async verify(dump: string) {
    return existsSync(dump);
  }
  async restore(dump: string) {
    this.restored.push(dump);
  }
  async packPaths(_paths: string[], _root: string, out: string) {
    const d = mkdtempSync(join(tmpdir(), 'ns-extra-'));
    writeFileSync(join(d, 'a.txt'), 'x');
    execFileSync('tar', ['-czf', out, '-C', d, 'a.txt']);
  }
  async probePath(path: string) {
    return path === '/nope'
      ? { state: 'missing' as const, size: null }
      : { state: 'dir' as const, size: 4096 };
  }
}

class FakeTelegram {
  files: Array<Record<string, string>> = [];
  texts: string[] = [];
  async call<T>(_t: string, method: string, body: Record<string, unknown>): Promise<TelegramCall<T>> {
    if (method === 'sendMessage') this.texts.push(String(body.text));
    if (method === 'getMe') return { ok: true, result: { username: 'bot' } as T };
    if (method === 'getChat') return { ok: true, result: { title: 'чат', type: 'private' } as T };
    return { ok: true, result: { message_id: 1 } as T };
  }
  async sendFile<T>(_t: string, fields: Record<string, string>): Promise<TelegramCall<T>> {
    this.files.push(fields);
    return { ok: true, result: { message_id: 2 } as T };
  }
}

describe('резервные копии e2e', () => {
  let app: INestApplication;
  let agent: InstanceType<typeof TestAgent>;
  let csrf: string;
  const tools = new FakeTools();
  const tg = new FakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'ns-backups-'));

  beforeAll(async () => {
    const envFile = join(dir, 'install.env');
    process.env.BACKUPS_DIR = join(dir, 'store');
    process.env.INSTALL_ENV_PATH = envFile;
    // Конфиг читается при импорте модуля — поэтому импорт после настройки окружения.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BACKUP_TOOLS)
      .useValue(tools)
      .overrideProvider(TELEGRAM_CLIENT)
      .useValue(tg)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: false, logger: false });
    setupHttp(app as NestExpressApplication);
    // .env установки читается только при копии — пишем с ключами, которые реально у панели.
    const config = app.get(ConfigService);
    writeFileSync(
      envFile,
      ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_VERSION', 'APP_SECRET', 'PASSWORD_PEPPER', 'PANEL_DOMAIN']
        .map((k) => `${k}=${k === 'PANEL_DOMAIN' ? 'panel.example.com' : String(config.get(k) ?? '')}`)
        .join('\n'),
    );
    const db = app.get<Db>(DB);
    await runMigrations(db);
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents cascade`,
    );
    await db.execute(sql`delete from app_meta where key like 'settings.%' or key like 'telegram.%'`);
    await app.get<Redis>(VALKEY).flushdb();
    await app.init();
    agent = request.agent(app.getHttpServer());
    csrf = (await agent.get('/api/auth/csrf').expect(200)).body.token as string;
    const setupToken = await app.get(SetupService).issueToken();
    const start = await agent
      .post('/api/auth/setup/start')
      .set(CSRF_HEADER, csrf)
      .send({ setupToken, login: 'admin', password: PASSWORD })
      .expect(200);
    await agent
      .post('/api/auth/setup/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await generate({ secret: start.body.totpSecret as string }) })
      .expect(200);
    await agent
      .put('/api/settings/telegram')
      .set(CSRF_HEADER, csrf)
      .send({ destinations: [{ url: `tgram://${TOKEN}/12345` }] })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const waitIdle = async () => {
    for (let i = 0; i < 100; i += 1) {
      const r = backupsResponseSchema.parse((await agent.get('/api/backups').expect(200)).body);
      if (!r.run.stage) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('копия не закончилась');
  };

  it('настройки по умолчанию; пароль, Telegram и пути сохраняются, пароль наружу не отдаётся', async () => {
    const s0 = backupSettingsSchema.parse((await agent.get('/api/backups/settings').expect(200)).body);
    expect(s0).toMatchObject({ auto: true, frequency: 'day', time: '04:00', keep: 7, passwordSet: false });
    const tgs = (await agent.get('/api/settings/telegram').expect(200)).body as {
      destinations: Array<{ id: string }>;
    };
    const s1 = backupSettingsSchema.parse(
      (
        await agent
          .put('/api/backups/settings')
          .set(CSRF_HEADER, csrf)
          .send({
            keep: 2,
            password: 'секрет',
            telegram: {
              enabled: true,
              target: 'notifications',
              destinationId: tgs.destinations[0]?.id,
              ownUrl: null,
              notifyFailure: true,
            },
            extra: { enabled: true, paths: ['/etc/nginx'] },
          })
          .expect(200)
      ).body,
    );
    expect(s1.passwordSet).toBe(true);
    expect(JSON.stringify(s1)).not.toContain('секрет');
    await agent
      .put('/api/backups/settings')
      .set(CSRF_HEADER, csrf)
      .send({ extra: { enabled: true, paths: ['etc'] } })
      .expect(400);
    const chk = (
      await agent
        .post('/api/backups/check-paths')
        .set(CSRF_HEADER, csrf)
        .send({ paths: ['/etc/nginx', '/nope'] })
        .expect(200)
    ).body;
    expect(chk.items.map((i: { state: string }) => i.state)).toEqual(['dir', 'missing']);
  });

  it('копия вручную: зашифрована, проверена, отправлена файлом в Telegram; хранятся последние 2', async () => {
    for (let i = 0; i < 3; i += 1) {
      await agent.post('/api/backups/run').set(CSRF_HEADER, csrf).send({}).expect(202);
      await waitIdle();
      await new Promise((r) => setTimeout(r, 1100)); // имя файла — до секунды
    }
    const r = await waitIdle();
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      kind: 'manual',
      encrypted: true,
      verified: true,
      telegram: { ok: true },
    });
    expect(r.items[0]?.contents).toEqual({ db: true, env: true, metrics: false, paths: 1 });
    expect(tg.files).toHaveLength(3);
    expect(tg.files[0]?.caption).toContain('Резервная копия NodeService');
    expect(tg.files[0]?.caption).toContain('с паролем');
    expect(readdirSync(join(dir, 'store')).filter((f) => f.endsWith('.enc'))).toHaveLength(2);
  });

  it('проверка и восстановление: без пароля — просит пароль; с паролем — видно содержимое, дамп разворачивается', async () => {
    const r = await waitIdle();
    const name = r.items[0]?.name ?? '';
    const noPass = backupInspectSchema.parse(
      (await agent.post(`/api/backups/${name}/inspect`).set(CSRF_HEADER, csrf).send({}).expect(200)).body,
    );
    expect(noPass.needsPassword).toBe(true);
    const ok = backupInspectSchema.parse(
      (
        await agent
          .post(`/api/backups/${name}/inspect`)
          .set(CSRF_HEADER, csrf)
          .send({ password: 'секрет' })
          .expect(200)
      ).body,
    );
    expect(ok).toMatchObject({
      compatible: true,
      sameKeys: true,
      domain: 'panel.example.com',
      contents: { env: true, paths: 1 },
    });
    await agent
      .post(`/api/backups/${name}/restore`)
      .set(CSRF_HEADER, csrf)
      .send({ password: 'секрет', confirm: 'да' })
      .expect(400);
    await agent
      .post(`/api/backups/${name}/restore`)
      .set(CSRF_HEADER, csrf)
      .send({ password: 'секрет', confirm: 'ВОССТАНОВИТЬ' })
      .expect(202);
    expect(tools.restored).toHaveLength(1);
    // Перед восстановлением сделана копия текущего состояния.
    const after = await waitIdle();
    expect(after.items.some((i) => i.kind === 'pre_restore')).toBe(true);
    // Копия «перед восстановлением» не вытесняет ту, из которой восстанавливали (хранится 2).
    expect(after.items.some((i) => i.name === name)).toBe(true);
    expect(after.items.filter((i) => i.kind === 'manual')).toHaveLength(2);
  });

  it('загрузка файла с компьютера и удаление; чужое имя — 404', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ns-up-'));
    writeFileSync(join(d, 'db.dump'), 'PGDMP x TABLE');
    writeFileSync(join(d, 'meta'), 'format=2\npanel=0.1.0\n');
    execFileSync('tar', ['-czf', join(d, 'a.tar.gz'), '-C', d, 'db.dump', 'meta']);
    const { readFileSync } = await import('node:fs');
    const up = await agent
      .post('/api/backups/upload')
      .set(CSRF_HEADER, csrf)
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', 'my.tar.gz')
      .send(readFileSync(join(d, 'a.tar.gz')))
      .expect(201);
    expect(up.body.kind).toBe('uploaded');
    const insp = backupInspectSchema.parse(
      (await agent.post(`/api/backups/${up.body.name}/inspect`).set(CSRF_HEADER, csrf).send({}).expect(200))
        .body,
    );
    expect(insp.compatible).toBe(true);
    await agent.delete(`/api/backups/${up.body.name}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.delete('/api/backups/..%2Fetc%2Fpasswd').set(CSRF_HEADER, csrf).expect(404);
  });

  it('копия не получилась — колокольчик и сообщение в чат копий', async () => {
    const orig = tools.dump;
    tools.dump = async () => {
      throw new Error('pg_dump: нет связи с базой');
    };
    const svc = app.get(BackupsService);
    svc.start('manual');
    await waitIdle();
    tools.dump = orig;
    for (let i = 0; i < 20 && !tg.texts.some((t) => t.includes('не получилась')); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    expect(tg.texts.some((t) => t.includes('Резервная копия не получилась'))).toBe(true);
    const r = backupsResponseSchema.parse((await agent.get('/api/backups').expect(200)).body);
    expect(r.run.lastError).toContain('нет связи с базой');
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  auditListQuerySchema,
  BACKUP_PROBLEM,
  backupInspectSchema,
  backupSettingsSchema,
  backupsResponseSchema,
  CSRF_HEADER,
} from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { generate } from 'otplib';
import pg from 'pg';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setupHttp } from '../src/common/http/setup-http.js';
import { createPool, DB, type Db } from '../src/infra/db/db.module.js';
import { runMigrations } from '../src/infra/db/migrate.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { AuditRepository } from '../src/modules/audit/audit.repository.js';
import { SetupService } from '../src/modules/auth/setup.service.js';
import { decryptFile } from '../src/modules/backups/backup-crypto.js';
import { BackupToolError } from '../src/modules/backups/backup-errors.js';
import {
  BACKUP_TOOLS,
  type BackupTools,
  PgBackupTools,
  swapDatabases,
} from '../src/modules/backups/backup-tools.js';
import { envValues, parseMeta } from '../src/modules/backups/backups.logic.js';
import { BackupsService } from '../src/modules/backups/backups.service.js';
import { internalSignature } from '../src/modules/backups/backups-internal.controller.js';
import { PANEL_LIFE_KEY, PanelLifecycleService } from '../src/modules/health/panel-lifecycle.service.js';
import { TELEGRAM_CLIENT, type TelegramCall } from '../src/modules/notifications/telegram/telegram.client.js';

if (!process.env.DATABASE_URL?.endsWith('/nodeservice_test'))
  throw new Error('e2e: DATABASE_URL должен указывать на nodeservice_test');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const PASSWORD = 'correct horse battery staple';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** От root права на файлы не действуют: сценарии «нет доступа» при таком запуске не воспроизвести. */
const asRoot = process.getuid?.() === 0;

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
  rich: Array<Record<string, unknown>> = [];
  async call<T>(_t: string, method: string, body: Record<string, unknown>): Promise<TelegramCall<T>> {
    if (method === 'sendMessage') this.texts.push(String(body.text));
    if (method === 'sendRichMessage') this.rich.push(body);
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
  let destinationId: string;
  const tools = new FakeTools();
  const tg = new FakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'ns-backups-'));
  const store = join(dir, 'store');

  beforeAll(async () => {
    process.env.BACKUPS_DIR = store;
    // Файла .env установки у панели нет, как и на настоящем сервере (там он закрыт от её пользователя):
    // ключи для копии она берёт из собственных настроек, домен и почту — из переменных установки.
    process.env.PANEL_DOMAIN = 'panel.example.com';
    process.env.ACME_EMAIL = 'admin@example.com';
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
    const db = app.get<Db>(DB);
    await runMigrations(db);
    // Колокольчик тоже с чистого листа: тесты считают уведомления о сбое, а список отдаётся с ограничением
    // по числу — без чистки от прогона к прогону он заполнился бы и счёт перестал бы расти.
    await db.execute(
      sql`truncate users, recovery_codes, trusted_devices, setup_tokens, servers, incidents, notifications cascade`,
    );
    await db.execute(
      sql`delete from app_meta where key like 'settings.%' or key like 'telegram.%' or key like 'backups.%'`,
    );
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

  const list = async () => backupsResponseSchema.parse((await agent.get('/api/backups').expect(200)).body);
  const waitIdle = async () => {
    for (let i = 0; i < 100; i += 1) {
      const r = await list();
      if (!r.run.stage) return r;
      await sleep(50);
    }
    throw new Error('копия не закончилась');
  };
  const putSettings = (body: Record<string, unknown>) =>
    agent.put('/api/backups/settings').set(CSRF_HEADER, csrf).send(body);
  const inspect = async (name: string, password?: string) =>
    backupInspectSchema.parse(
      (
        await agent
          .post(`/api/backups/${name}/inspect`)
          .set(CSRF_HEADER, csrf)
          .send(password ? { password } : {})
          .expect(200)
      ).body,
    );
  const restore = (name: string, password = 'секрет') =>
    agent
      .post(`/api/backups/${name}/restore`)
      .set(CSRF_HEADER, csrf)
      .send({ password, confirm: 'ВОССТАНОВИТЬ' });
  /** Собрать архив из файлов и загрузить его через «Восстановить из файла»; вернуть имя копии. */
  const uploadArchive = async (files: Record<string, string>): Promise<string> => {
    const d = mkdtempSync(join(tmpdir(), 'ns-up-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
    execFileSync('tar', ['-czf', join(d, 'a.tar.gz'), '-C', d, ...Object.keys(files)]);
    // Имя копии — до секунды: две загрузки подряд не должны получить одно имя.
    await sleep(1100);
    const up = await agent
      .post('/api/backups/upload')
      .set(CSRF_HEADER, csrf)
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', 'my.tar.gz')
      .send(readFileSync(join(d, 'a.tar.gz')))
      .expect(201);
    expect(up.body.kind).toBe('uploaded');
    return up.body.name as string;
  };
  /** Сколько раз про неудачную копию написали в Telegram и сколько — в колокольчик. */
  const failuresInTelegram = () => tg.texts.filter((t) => t.includes('Резервная копия не получилась'));
  const failuresInBell = async () =>
    (
      (await agent.get('/api/notifications').expect(200)).body.items as Array<{ title: string; body: string }>
    ).filter((n) => n.title === 'Резервная копия не получилась');
  const keyPrint = () =>
    createHash('sha256')
      .update(String(app.get(ConfigService).get('ENCRYPTION_KEY')).toLowerCase())
      .digest('hex');

  it('настройки по умолчанию; пароль, Telegram и пути сохраняются, пароль наружу не отдаётся', async () => {
    const s0 = backupSettingsSchema.parse((await agent.get('/api/backups/settings').expect(200)).body);
    expect(s0).toMatchObject({ auto: true, frequency: 'day', time: '04:00', keep: 7, passwordSet: false });
    const tgs = (await agent.get('/api/settings/telegram').expect(200)).body as {
      destinations: Array<{ id: string }>;
    };
    destinationId = tgs.destinations[0]?.id ?? '';
    const s1 = backupSettingsSchema.parse(
      (
        await putSettings({
          keep: 2,
          password: 'секрет',
          telegram: {
            enabled: true,
            target: 'notifications',
            destinationId,
            ownUrl: null,
            notifyFailure: true,
          },
          extra: { enabled: true, paths: ['/etc/nginx'] },
        }).expect(200)
      ).body,
    );
    expect(s1.passwordSet).toBe(true);
    expect(JSON.stringify(s1)).not.toContain('секрет');
    await putSettings({ extra: { enabled: true, paths: ['etc'] } }).expect(400);
    const chk = (
      await agent
        .post('/api/backups/check-paths')
        .set(CSRF_HEADER, csrf)
        .send({ paths: ['/etc/nginx', '/nope'] })
        .expect(200)
    ).body;
    expect(chk.items.map((i: { state: string }) => i.state)).toEqual(['dir', 'missing']);
  });

  it('путь, похожий на параметр программы упаковки, не сохраняется; в Журнале — сами пути', async () => {
    for (const bad of ['/--checkpoint=1', '/--checkpoint-action=exec=sh -c "id"', '/etc/-x']) {
      await putSettings({ extra: { enabled: true, paths: [bad] } }).expect(400);
      await agent
        .post('/api/backups/check-paths')
        .set(CSRF_HEADER, csrf)
        .send({ paths: [bad] })
        .expect(400);
    }
    const s = backupSettingsSchema.parse((await agent.get('/api/backups/settings').expect(200)).body);
    expect(s.extra.paths).toEqual(['/etc/nginx']);
    const page = await app.get(AuditRepository).list(auditListQuerySchema.parse({ pageSize: 50 }));
    const saved = page.items.find(
      (e) => e.action === 'settings.backups.updated' && e.result === 'ok' && e.changes?.extra,
    );
    expect(saved?.changes?.extra).toEqual({ before: 'выключено: путей нет', after: '/etc/nginx' });
  });

  it('копия вручную: зашифрована, проверена, отправлена файлом в Telegram; хранятся последние 2', async () => {
    const telegram = (await agent.get('/api/settings/telegram').expect(200)).body as {
      destinations: Array<{ id: string }>;
    };
    destinationId = telegram.destinations[0]?.id ?? '';
    await putSettings({
      keep: 2,
      password: 'секрет',
      telegram: {
        enabled: true,
        target: 'notifications',
        destinationId,
        ownUrl: null,
        notifyFailure: true,
      },
      extra: { enabled: true, paths: ['/etc/nginx'] },
    }).expect(200);
    await agent
      .put('/api/settings/telegram')
      .set(CSRF_HEADER, csrf)
      .send({
        delivery: { groupPerServer: true, silentWarnings: true, remindHours: 2, rich: true },
      })
      .expect(200);
    for (let i = 0; i < 3; i += 1) {
      await agent.post('/api/backups/run').set(CSRF_HEADER, csrf).send({}).expect(202);
      await waitIdle();
      await sleep(1100); // имя файла — до секунды
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
    expect(tg.rich).toHaveLength(3);
    const blocks =
      (tg.rich[0]?.rich_message as { blocks?: Array<Record<string, unknown>> } | undefined)?.blocks ?? [];
    expect(blocks[0]).toMatchObject({ type: 'heading', text: '🗄 Резервная копия NodeService' });
    expect(blocks.some((block) => block.type === 'table')).toBe(true);
    expect(tg.files[0]?.caption).toContain('Архив резервной копии');
    expect(tg.files[0]?.reply_parameters).toContain('message_id');
    expect(readdirSync(store).filter((f) => f.endsWith('.enc'))).toHaveLength(2);
  });

  it('в архиве — ключи установки в том виде, как их читает консольное восстановление, и отпечаток ключа', async () => {
    const config = app.get(ConfigService);
    const name = (await waitIdle()).items[0]?.name ?? '';
    const work = mkdtempSync(join(tmpdir(), 'ns-look-'));
    await decryptFile(join(store, name), join(work, 'plain.tar.gz'), 'секрет');
    // Ровно так архив открывает install.sh --restore: нет env или meta — «это не бэкап панели».
    execFileSync('tar', ['-C', work, '-xzf', join(work, 'plain.tar.gz'), 'env', 'meta']);
    const env = envValues(readFileSync(join(work, 'env'), 'utf8'));
    expect(env).toMatchObject({
      PANEL_DOMAIN: 'panel.example.com',
      ACME_EMAIL: 'admin@example.com',
      // Пароля базы отдельной переменной в тестах нет — он взят из адреса базы.
      POSTGRES_PASSWORD: decodeURIComponent(new URL(String(config.get('DATABASE_URL'))).password),
      APP_SECRET: config.get('APP_SECRET'),
      ENCRYPTION_KEY: config.get('ENCRYPTION_KEY'),
      ENCRYPTION_KEY_VERSION: String(config.get('ENCRYPTION_KEY_VERSION')),
    });
    // install.sh требует эти три: без любого из них «.env в архиве неполный».
    for (const k of ['POSTGRES_PASSWORD', 'APP_SECRET', 'ENCRYPTION_KEY']) expect(env[k]).toBeTruthy();
    const meta = parseMeta(readFileSync(join(work, 'meta'), 'utf8'));
    expect(meta).toMatchObject({ format: '2', domain: 'panel.example.com', kind: 'manual' });
    expect(meta.keys_sha256).toBe(keyPrint());
    expect(readFileSync(join(work, 'meta'), 'utf8')).not.toContain(String(config.get('ENCRYPTION_KEY')));
  });

  it('копия без пароля несёт ключи в открытом виде — файл закрыт от других пользователей сервера', async () => {
    // «Хранить последних» на одну больше: эта копия не должна вытеснить две прежние.
    await putSettings({ password: null, keep: 3 }).expect(200);
    try {
      await sleep(1100);
      await agent.post('/api/backups/run').set(CSRF_HEADER, csrf).send({ sendTelegram: false }).expect(202);
      const item = (await waitIdle()).items[0];
      expect(item).toMatchObject({ kind: 'manual', encrypted: false, contents: { env: true } });
      // Как у консольной копии (chmod 600): читать архив может только пользователь панели.
      expect(statSync(join(store, item?.name ?? '')).mode & 0o777).toBe(0o600);
      await agent.delete(`/api/backups/${item?.name}`).set(CSRF_HEADER, csrf).expect(204);
    } finally {
      await putSettings({ password: 'секрет', keep: 2 }).expect(200);
    }
  });

  it('ключи не попали в копию — копия не считается удачной', async () => {
    const svc = app.get(BackupsService) as unknown as { installEnv: Record<string, string> };
    const real = svc.installEnv;
    const before = await waitIdle();
    const { ENCRYPTION_KEY: _key, ...withoutKey } = real;
    svc.installEnv = withoutKey;
    try {
      await sleep(1100);
      await agent.post('/api/backups/run').set(CSRF_HEADER, csrf).send({}).expect(202);
      const after = await waitIdle();
      expect(after.run.lastError).toContain('В копию не попали ключи установки (ключ шифрования)');
      expect(after.items.map((i) => i.name)).toEqual(before.items.map((i) => i.name));
    } finally {
      svc.installEnv = real;
    }
  });

  it('проверка и восстановление: без пароля — просит пароль; с паролем — видно содержимое, дамп разворачивается', async () => {
    const r = await waitIdle();
    const name = r.items[0]?.name ?? '';
    const noPass = await inspect(name);
    expect(noPass.needsPassword).toBe(true);
    const ok = await inspect(name, 'секрет');
    expect(ok).toMatchObject({
      compatible: true,
      sameKeys: true,
      domain: 'panel.example.com',
      contents: { env: true, paths: 1 },
    });
    expect(ok.warning ?? null).toBeNull();
    await agent
      .post(`/api/backups/${name}/restore`)
      .set(CSRF_HEADER, csrf)
      .send({ password: 'секрет', confirm: 'да' })
      .expect(400);
    await sleep(1100);
    await restore(name).expect(202);
    expect(tools.restored).toHaveLength(1);
    // Перед восстановлением сделана копия текущего состояния.
    const after = await waitIdle();
    expect(after.items.some((i) => i.kind === 'pre_restore')).toBe(true);
    // Копия «перед восстановлением» не вытесняет ту, из которой восстанавливали (хранится 2).
    expect(after.items.some((i) => i.name === name)).toBe(true);
    expect(after.items.filter((i) => i.kind === 'manual')).toHaveLength(2);
  });

  it('восстановление не удаляет копию, из которой восстанавливают', async () => {
    const names = async (kind: string) =>
      (await waitIdle()).items.filter((i) => i.kind === kind).map((i) => i.name);
    const [a, b] = await names('manual');
    // Вернуться к состоянию «до»: восстановили A, потом B, потом — копию, сделанную перед восстановлением A.
    await sleep(1100);
    await restore(a ?? '').expect(202);
    const p1 = (await names('pre_restore'))[0] ?? '';
    await sleep(1100);
    await restore(b ?? '').expect(202);
    expect(await names('pre_restore')).toContain(p1);
    await sleep(1100);
    // Очередь «перед восстановлением» — две копии; третья вытеснила бы P1 прямо перед распаковкой.
    await restore(p1).expect(202);
    expect(await names('pre_restore')).toContain(p1);

    // «Хранить последних» уменьшили: самая старая обычная копия — лишняя, но восстановиться из неё можно.
    await putSettings({ keep: 1 }).expect(200);
    const oldest = (await names('manual')).at(-1) ?? '';
    await sleep(1100);
    await restore(oldest).expect(202);
    expect(await names('manual')).toContain(oldest);
    await putSettings({ keep: 20 }).expect(200);
  });

  it('неудачное восстановление: своя ошибка с причиной по-русски, текущая база не тронута', async () => {
    const name = (await waitIdle()).items.find((i) => i.kind === 'manual')?.name ?? '';
    const orig = tools.restore;
    tools.restore = async () => {
      throw new BackupToolError('swap', '55006 database "nodeservice_test" is being accessed by other users');
    };
    try {
      await sleep(1100);
      const res = await restore(name).expect(500);
      expect(res.body.type).toBe(BACKUP_PROBLEM.restoreFailed);
      expect(res.body.detail).toContain('Восстановление не удалось, текущая база не тронута: ');
      expect(res.body.detail).toContain('База данных занята');
      expect(res.body.detail).not.toContain('accessed');
      const after = await list();
      expect(after.run.stage).toBeNull();
      expect(after.run.lastError).toContain('База данных занята');
    } finally {
      tools.restore = orig;
    }
  });

  it('после восстановления панель перезапускается сама — с отметкой штатной остановки, а не «после сбоя»', async () => {
    // Как main.ts при запуске: отметка запуска, штатной остановки ещё нет.
    await app.get(PanelLifecycleService).started();
    const valkey = app.get<Redis>(VALKEY);
    const mark = async () =>
      JSON.parse((await valkey.get(PANEL_LIFE_KEY)) ?? '{}') as { stoppedAt?: unknown };
    expect((await mark()).stoppedAt).toBeNull();
    await sleep(1100);
    await agent.post('/api/backups/run').set(CSRF_HEADER, csrf).send({ sendTelegram: false }).expect(202);
    const name = (await waitIdle()).items.find((i) => i.kind === 'manual')?.name ?? '';
    await sleep(1100);
    await restore(name).expect(202);
    expect((await mark()).stoppedAt).toEqual(expect.any(String));
  });

  it('загрузка файла с компьютера и удаление; чужое имя — 404', async () => {
    // Копия прежних версий панели: в архиве нет ни ключей, ни их отпечатка.
    const name = await uploadArchive({ 'db.dump': 'PGDMP x TABLE', meta: 'format=2\npanel=0.1.0\n' });
    const insp = await inspect(name);
    // Восстановить можно (на этой же установке она подойдёт), но панель честно говорит, что сверить не с чем.
    expect(insp).toMatchObject({ compatible: true, sameKeys: null, problem: null, contents: { env: false } });
    expect(insp.warning).toContain('Ключей шифрования в этой копии нет');
    await agent.delete(`/api/backups/${name}`).set(CSRF_HEADER, csrf).expect(204);
    await agent.delete('/api/backups/..%2Fetc%2Fpasswd').set(CSRF_HEADER, csrf).expect(404);
  });

  it('от этой ли установки копия: сверка по ключам в архиве и по отпечатку', async () => {
    const dump = { 'db.dump': 'PGDMP x TABLE' };
    const same = await uploadArchive({ ...dump, meta: `format=2\npanel=0.1.0\nkeys_sha256=${keyPrint()}\n` });
    expect(await inspect(same)).toMatchObject({ compatible: true, sameKeys: true, problem: null });
    expect((await inspect(same)).warning ?? null).toBeNull();

    const other = await uploadArchive({
      ...dump,
      meta: `format=2\npanel=0.1.0\nkeys_sha256=${'0'.repeat(64)}\n`,
    });
    const otherInfo = await inspect(other);
    expect(otherInfo).toMatchObject({ compatible: false, sameKeys: false });
    expect(otherInfo.problem).toContain('самих ключей в ней нет');

    const foreign = await uploadArchive({
      ...dump,
      meta: 'format=1\n',
      env: `ENCRYPTION_KEY=${'12'.repeat(32)}\nAPP_SECRET=${'34'.repeat(32)}\nPASSWORD_PEPPER=${'56'.repeat(32)}\n`,
    });
    const foreignInfo = await inspect(foreign);
    expect(foreignInfo).toMatchObject({ compatible: false, sameKeys: false, contents: { env: true } });
    expect(foreignInfo.problem).toContain('Копия от другой установки');
    await restore(foreign).expect(409);
    for (const n of [same, other, foreign])
      await agent.delete(`/api/backups/${n}`).set(CSRF_HEADER, csrf).expect(204);
  });

  it('копия не получилась — колокольчик и сообщение в чат копий, причина по-русски', async () => {
    const orig = tools.dump;
    tools.dump = async () => {
      throw new BackupToolError(
        'dump',
        'pg_dump: error: connection to server at "postgres" (172.18.0.3), port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?',
      );
    };
    const before = failuresInTelegram().length;
    const svc = app.get(BackupsService);
    svc.start('manual');
    await waitIdle();
    tools.dump = orig;
    for (let i = 0; i < 20 && failuresInTelegram().length === before; i += 1) await sleep(50);
    const sent = failuresInTelegram().at(-1) ?? '';
    expect(failuresInTelegram()).toHaveLength(before + 1);
    expect(sent).toContain('Нет связи с базой данных');
    expect(sent).not.toContain('Connection refused');
    const r = await list();
    expect(r.run.lastError).toContain('Нет связи с базой данных');
    expect(r.run.lastError).not.toMatch(/[A-Za-z]/);
    expect((await failuresInBell())[0]?.body).toContain('Нет связи с базой данных');
  });

  it('копия перед обновлением: служебный запрос с подписью — копия по настройкам панели; без подписи — 404', async () => {
    const secret = app.get(ConfigService).get('APP_SECRET') as string;
    await request(app.getHttpServer()).post('/api/internal/backups/pre-update').expect(404);
    await request(app.getHttpServer())
      .post('/api/internal/backups/pre-update')
      .set('x-nodeservice-internal', internalSignature(secret, 'другое'))
      .expect(404);
    await sleep(1100);
    const r = await request(app.getHttpServer())
      .post('/api/internal/backups/pre-update')
      .set('x-nodeservice-internal', internalSignature(secret, 'backup:pre_update'))
      .expect(200);
    expect(r.body).toMatchObject({ encrypted: true });
    const l = await list();
    expect(l.items.find((i) => i.name === r.body.name)).toMatchObject({
      kind: 'pre_update',
      verified: true,
    });
  });

  it('свой чат для копий сохранён — остальные настройки сохраняются как обычно', async () => {
    const chat = { enabled: true, target: 'own', destinationId: null, notifyFailure: true };
    const s1 = backupSettingsSchema.parse(
      (await putSettings({ telegram: { ...chat, ownUrl: `tgram://${TOKEN}/-1002233445566:12` } }).expect(200))
        .body,
    );
    const mask = s1.telegram.ownUrl;
    expect(mask).toBe('tgram://***/-1002233445566:12');
    expect(JSON.stringify(s1)).not.toContain(TOKEN);

    // Интерфейс чат не трогал и поле не передал.
    const s2 = backupSettingsSchema.parse(
      (await putSettings({ keep: 10, time: '05:30', telegram: chat }).expect(200)).body,
    );
    expect(s2).toMatchObject({ keep: 10, time: '05:30', telegram: { target: 'own', ownUrl: mask } });
    // Прежний интерфейс (вкладка, открытая до обновления) возвращал маску как есть — это тоже «не менять».
    const s3 = backupSettingsSchema.parse(
      (await putSettings({ keep: 11, telegram: { ...chat, ownUrl: mask } }).expect(200)).body,
    );
    expect(s3).toMatchObject({ keep: 11, telegram: { ownUrl: mask } });
    // Чат на месте вместе с токеном: тест уходит и по сохранённому чату, и по его маске.
    for (const url of [null, mask]) {
      const t = await agent.post('/api/backups/test-chat').set(CSRF_HEADER, csrf).send({ url }).expect(200);
      expect(t.body).toMatchObject({ ok: true });
    }
    // Сменить чат правкой маски нельзя — токена в ней нет; настройки при этом не портятся.
    await putSettings({ keep: 12, telegram: { ...chat, ownUrl: 'tgram://***/-100999:1' } }).expect(400);
    const s4 = backupSettingsSchema.parse((await agent.get('/api/backups/settings').expect(200)).body);
    expect(s4).toMatchObject({ keep: 11, telegram: { ownUrl: mask } });

    const s5 = backupSettingsSchema.parse(
      (
        await putSettings({
          keep: 20,
          time: '04:00',
          telegram: { ...chat, target: 'notifications', destinationId, ownUrl: null },
        }).expect(200)
      ).body,
    );
    expect(s5.telegram).toMatchObject({ target: 'notifications', ownUrl: null });
  });

  it('скачивание: удалённая или нечитаемая копия — ошибка в ответе, а не падение панели', async () => {
    const item = (await waitIdle()).items[0];
    const name = item?.name ?? '';
    const ok = await agent.get(`/api/backups/${name}/download`).responseType('blob').expect(200);
    expect((ok.body as Buffer).length).toBe(item?.size);
    expect(ok.headers['content-disposition']).toContain(name);

    // Файл есть, но прочитать его панель не может (положен в папку копий другим пользователем).
    if (!asRoot) {
      chmodSync(join(store, name), 0o000);
      try {
        const denied = await agent.get(`/api/backups/${name}/download`).expect(500);
        expect(denied.body.type).toBe(BACKUP_PROBLEM.unreadable);
        expect(denied.body.detail).toContain('не может прочитать файл этой копии');
      } finally {
        chmodSync(join(store, name), 0o600);
      }
    }
    // Копию удалили, пока список был открыт.
    const gone = await agent
      .get('/api/backups/nodeservice-backup-20200101-000000.tar.gz/download')
      .expect(404);
    expect(gone.body.type).toBe(BACKUP_PROBLEM.notFound);

    // Сбой чтения посреди отдачи: ответ обрывается, процесс живёт.
    const svc = app.get(BackupsService);
    const broken = new Readable({
      read() {
        this.destroy(new Error('EIO: i/o error, read'));
      },
    });
    const spy = vi.spyOn(svc, 'download').mockResolvedValueOnce({ stream: broken, size: 1000 });
    await expect(agent.get(`/api/backups/${name}/download`)).rejects.toThrow();
    spy.mockRestore();
    await agent.get('/api/backups').expect(200);
  });

  it('копия по расписанию не получилась — не повторяется каждую минуту; одно сообщение, повтор через час', async () => {
    const svc = app.get(BackupsService);
    const db = app.get<Db>(DB);
    await db.execute(sql`delete from app_meta where key = 'backups.schedule'`);
    const tz = (await waitIdle()).timeZone;
    // Момент расписания — три часа назад: удачная копия (она получит настоящее время) его закроет.
    const slot = new Date(Math.floor((Date.now() - 3 * 3_600_000) / 60_000) * 60_000);
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(slot);
    await putSettings({ auto: true, frequency: 'day', time }).expect(200);
    const at = (min: number) => new Date(slot.getTime() + min * 60_000);
    const tgBefore = failuresInTelegram().length;
    const bellBefore = (await failuresInBell()).length;
    const orig = tools.dump;
    tools.dump = async () => {
      throw new BackupToolError(
        'dump',
        'pg_dump: error: could not write to output file: No space left on device',
      );
    };
    try {
      expect(await svc.tick(at(0.2))).toBe(true);
      await waitIdle();
      for (let i = 0; i < 20 && failuresInTelegram().length === tgBefore; i += 1) await sleep(50);
      expect(failuresInTelegram()).toHaveLength(tgBefore + 1);
      expect(failuresInTelegram().at(-1)).toContain('закончилось место');
      expect(failuresInTelegram().at(-1)).toContain('попробует ещё раз через час');
      // Через минуту и через 59 минут — тишина: попытка для этого момента уже была.
      expect(await svc.tick(at(1))).toBe(false);
      expect(await svc.tick(at(59))).toBe(false);
      // Через час — повтор; он тоже не вышел, но второго сообщения нет.
      expect(await svc.tick(at(61))).toBe(true);
      await waitIdle();
      await sleep(300);
      expect(failuresInTelegram()).toHaveLength(tgBefore + 1);
      expect(await failuresInBell()).toHaveLength(bellBefore + 1);
      expect((await list()).run.lastError).toContain('закончилось место');
      // Время попытки лежит в базе рядом с настройками: перезапуск панели отсчёт не сбрасывает.
      const row = await db.execute<{ value: string }>(
        sql`select value from app_meta where key = 'backups.schedule'`,
      );
      expect(JSON.parse(row.rows[0]?.value ?? '{}')).toMatchObject({
        attemptAt: at(61).toISOString(),
        noticeSlot: slot.toISOString(),
      });
    } finally {
      tools.dump = orig;
    }
    // Причину устранили — следующая попытка через час удаётся, и на этом всё.
    await sleep(1100);
    expect(await svc.tick(at(125))).toBe(true);
    const done = await waitIdle();
    expect(done.items[0]?.kind).toBe('auto');
    expect(done.run.lastError).toBeNull();
    expect(await svc.tick(at(130))).toBe(false);
  });

  it.skipIf(asRoot)(
    'папка копий недоступна с запуска панели — расписание не молчит: перепроверка в момент копии, одно сообщение',
    async () => {
      const svc = app.get(BackupsService);
      const db = app.get<Db>(DB);
      await db.execute(sql`delete from app_meta where key = 'backups.schedule'`);
      await putSettings({ auto: true, frequency: 'day', time: '04:00' }).expect(200);
      // Момент расписания — завтра в 04:00 по поясу панели: сегодняшние копии его не закрывают.
      const nextAt = (await list()).nextAt ?? '';
      const base = new Date(new Date(nextAt).getTime() + 24 * 3_600_000);
      const at = (min: number) => new Date(base.getTime() + min * 60_000);
      // Папка копий закрыта на запись — как после переноса, когда она досталась другому пользователю.
      chmodSync(store, 0o500);
      try {
        await (svc as unknown as { refreshState(): Promise<void> }).refreshState();
        expect((await list()).available).toBe(false);
        const bellBefore = (await failuresInBell()).length;
        const tgBefore = failuresInTelegram().length;
        expect(await svc.tick(at(0.2))).toBe(false);
        const bell = await failuresInBell();
        expect(bell).toHaveLength(bellBefore + 1);
        expect(bell[0]?.body).toContain('Копия по расписанию не сделана');
        expect(bell[0]?.body).toContain('не хватает прав на папку копий');
        for (let i = 0; i < 20 && failuresInTelegram().length === tgBefore; i += 1) await sleep(50);
        expect(failuresInTelegram()).toHaveLength(tgBefore + 1);
        // Дальше — раз в час и молча: второе сообщение о том же моменте не нужно.
        expect(await svc.tick(at(1))).toBe(false);
        expect(await svc.tick(at(61))).toBe(false);
        await sleep(200);
        expect(await failuresInBell()).toHaveLength(bellBefore + 1);
        expect(failuresInTelegram()).toHaveLength(tgBefore + 1);
      } finally {
        chmodSync(store, 0o700);
      }
      // Права вернули, страницу копий никто не открывал: в следующую попытку панель проверяет сама и делает копию.
      await sleep(1100);
      expect(await svc.tick(at(122))).toBe(true);
      const done = await waitIdle();
      expect(done.available).toBe(true);
      expect(done.items[0]?.kind).toBe('auto');
    },
  );
});

describe('подмена базы при восстановлении (настоящий Postgres, свои базы)', () => {
  const base = new URL(process.env.DATABASE_URL as string);
  const cur = `${decodeURIComponent(base.pathname.slice(1))}_swap`;
  const urlOf = (db: string) => {
    const u = new URL(base.toString());
    u.pathname = `/${db}`;
    return u.toString();
  };
  const adminUrl = urlOf('postgres');
  const withClient = async <T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: urlOf(db) });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const databases = () =>
    withClient('postgres', async (c) =>
      (await c.query<{ datname: string }>('select datname from pg_database order by datname')).rows
        .map((r) => r.datname)
        .filter((n) => n === cur || n.startsWith(`${cur}_`)),
    );
  const dropAll = async () => {
    for (const n of await databases())
      await withClient('postgres', (c) => c.query(`drop database if exists "${n}" with (force)`));
  };
  /** База с отметкой: по ней видно, какая из баз сейчас носит рабочее имя. */
  const create = async (db: string, mark: string) => {
    await withClient('postgres', (c) => c.query(`create database "${db}"`));
    await withClient(db, async (c) => {
      await c.query('create table marker (v text)');
      await c.query('insert into marker values ($1)', [mark]);
    });
  };
  const markOf = (db: string) =>
    withClient(db, async (c) => (await c.query<{ v: string }>('select v from marker')).rows[0]?.v);

  beforeAll(dropAll);
  afterAll(dropAll);

  it('пока панель пишет в базу и переподключается, подмена проходит; прежняя база остаётся под своим именем', async () => {
    const temp = `${cur}_restore_20260101000000`;
    const keep = `${cur}_pre_restore_20260101000000`;
    await create(cur, 'прежняя');
    await create(temp, 'из копии');
    // «Панель»: пул, который не перестаёт обращаться к базе, как при сигналах агентов.
    const pool = new pg.Pool({ connectionString: urlOf(cur), max: 3 });
    pool.on('error', () => undefined);
    let stop = false;
    const load = Array.from({ length: 3 }, async () => {
      while (!stop) {
        await pool.query('select v from marker').catch(() => undefined);
        await sleep(5);
      }
    });
    await sleep(200);
    try {
      await swapDatabases(adminUrl, { current: cur, temp, keep });
      await sleep(200);
    } finally {
      stop = true;
      await Promise.all(load);
      await pool.end();
    }
    expect(await databases()).toEqual([cur, keep]);
    expect(await markOf(cur)).toBe('из копии');
    expect(await markOf(keep)).toBe('прежняя');
  });

  it('сессия панели, занятая транзакцией в момент подмены, обрывается ошибкой запроса, а не падением процесса', async () => {
    await dropAll();
    const temp = `${cur}_restore_20260101000002`;
    const keep = `${cur}_pre_restore_20260101000002`;
    await create(cur, 'прежняя');
    await create(temp, 'из копии');
    // Пул — тот же, что у панели. Соединение взято из него и простаивает внутри транзакции (так работают
    // транзакции панели между двумя запросами): подмена завершает эту сессию.
    const pool = createPool(urlOf(cur));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('select v from marker');
      await swapDatabases(adminUrl, { current: cur, temp, keep });
      await sleep(300);
      await expect(client.query('select 1')).rejects.toThrow();
    } finally {
      client.release(true);
      await pool.end();
    }
    expect(await markOf(cur)).toBe('из копии');
  });

  it('сбой между двумя переименованиями не оставляет панель без базы', async () => {
    await dropAll();
    await create(cur, 'прежняя');
    // Временной базы нет: первое переименование проходит, второе срывается.
    await expect(
      swapDatabases(adminUrl, {
        current: cur,
        temp: `${cur}_restore_20260101000001`,
        keep: `${cur}_pre_restore_20260101000001`,
      }),
    ).rejects.toBeInstanceOf(BackupToolError);
    expect(await databases()).toEqual([cur]);
    expect(await markOf(cur)).toBe('прежняя');
  });

  it('восстановление сорвалось — временная база удалена, как и оставшиеся от прошлых попыток', async () => {
    await dropAll();
    await create(cur, 'прежняя');
    await create(`${cur}_restore_20200101000000`, 'осталась после сбоя');
    // Файла дампа нет (а на машине без инструментов базы нет и самой программы) — восстановление срывается.
    await expect(new PgBackupTools(urlOf(cur)).restore(join(tmpdir(), 'нет-такого.dump'))).rejects.toThrow();
    expect(await databases()).toEqual([cur]);
    expect(await markOf(cur)).toBe('прежняя');
  });
});

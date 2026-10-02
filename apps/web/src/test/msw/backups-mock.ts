import {
  AUTH_PROBLEM,
  BACKUP_RESTORE_CONFIRM,
  BACKUP_SETTINGS_DEFAULT,
  BACKUP_STAGES,
  type BackupInspect,
  type BackupItem,
  type BackupRun,
  type BackupSettings,
  type BackupSettingsUpdate,
  maskTelegramUrl,
  parseTelegramUrl,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockSecurity } from './security-mock';

/**
 * Мок резервных копий: список в памяти, копия идёт по стадиям на таймере (`speedMs`), пароль архивов —
 * «секрет-пароль». Восстановление только отвечает 202 (перезапуск панели в моке не изображаем).
 */
export const MOCK_BACKUP_PASSWORD = 'секрет-пароль';
const MB = 1024 * 1024;

export const mockBackups = {
  items: [] as BackupItem[],
  settings: structuredClone(BACKUP_SETTINGS_DEFAULT) as BackupSettings,
  /** Тело последнего сохранения настроек: что именно отправил интерфейс. */
  lastUpdate: null as BackupSettingsUpdate | null,
  run: { stage: null, startedAt: null, mode: null, lastError: null } as BackupRun,
  speedMs: 700,
  failNext: false,
  restored: [] as string[],
  timers: [] as ReturnType<typeof setTimeout>[],
  /** Часы «сервера» относительно часов браузера, мс: итог копии не должен зависеть от сбитых часов. */
  clockSkewMs: 0,
  /** Восстановление не удаётся: сервер отвечает своей ошибкой со словами «текущая база не тронута». */
  restoreFails: false,
};
// Режим VITE_MOCK=1: управление из скриншот-сценариев.
if (typeof window !== 'undefined')
  (window as unknown as { __nsMockBackups: typeof mockBackups }).__nsMockBackups = mockBackups;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function nameAt(at: Date, enc: boolean, suffix = ''): string {
  const ts = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `nodeservice-backup-${ts}${suffix}.tar.gz${enc ? '.enc' : ''}`;
}

function item(at: Date, kind: BackupItem['kind'], size: number, extra: Partial<BackupItem> = {}): BackupItem {
  const encrypted = extra.encrypted ?? true;
  return {
    name: nameAt(at, encrypted, kind === 'pre_restore' ? '-pre-restore' : ''),
    createdAt: at.toISOString(),
    size: Math.round(size),
    kind,
    encrypted,
    verified: true,
    telegram: kind === 'auto' ? { ok: true, note: null } : null,
    contents: { db: true, env: true, metrics: false, paths: 2 },
    version: '0.38.1',
    ...extra,
    offsite: extra.offsite ?? null,
  };
}

export function seedBackups(): void {
  for (const t of mockBackups.timers) clearTimeout(t);
  mockBackups.timers = [];
  mockBackups.lastUpdate = null;
  const today4 = new Date();
  today4.setHours(4, 0, 0, 0);
  const base = today4.getTime() > Date.now() ? today4.getTime() - DAY : today4.getTime();
  mockBackups.items = [
    item(new Date(base), 'auto', 42.3 * MB),
    item(new Date(base - 10.3 * HOUR), 'manual', 42.1 * MB, { telegram: null }),
    item(new Date(base - DAY), 'auto', 41.8 * MB),
    item(new Date(base - 1.2 * DAY), 'pre_restore', 41.6 * MB),
    item(new Date(base - 8 * DAY), 'auto', 39.9 * MB),
    item(new Date(base - 15 * DAY), 'auto', 51.2 * MB, {
      telegram: { ok: false, note: 'Файл больше 50 МБ — бот Telegram такой не пришлёт.' },
    }),
    item(new Date(base - 22 * DAY), 'pre_update', 35 * MB, { version: '0.35.0', telegram: null }),
  ];
  mockBackups.settings = {
    ...structuredClone(BACKUP_SETTINGS_DEFAULT),
    keep: 7,
    passwordSet: true,
    telegram: {
      enabled: true,
      target: 'own',
      destinationId: null,
      // Маска — та же, что отдаёт сервер: вместо токена три звёздочки.
      ownUrl: maskTelegramUrl('-1002233445566', 12),
      notifyFailure: true,
    },
    extra: { enabled: true, paths: ['/etc/nginx/sites-enabled', '/root/scripts/remnanode-installer'] },
  };
  mockBackups.run = { stage: null, startedAt: null, mode: null, lastError: null };
  mockBackups.failNext = false;
  mockBackups.restored = [];
  mockBackups.clockSkewMs = 0;
  mockBackups.restoreFails = false;
}

const problem = (status: number, type: string, detail: string) =>
  HttpResponse.json(
    { type, title: detail, status, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
const requireStepUp = () =>
  mockSecurity.stepUpFresh ? null : problem(403, AUTH_PROBLEM.stepUp, 'Подтвердите пароль, чтобы продолжить');

function nextAt(): string | null {
  const s = mockBackups.settings;
  if (!s.auto) return null;
  const [h, m] = s.time.split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 4, m ?? 0, 0, 0);
  for (let i = 0; i < 8; i += 1) {
    const wd = ((d.getDay() + 6) % 7) + 1;
    if (d.getTime() > Date.now() && (s.frequency === 'day' || wd === s.weekday)) return d.toISOString();
    d.setDate(d.getDate() + 1);
  }
  return null;
}

function retain(): void {
  const keep = mockBackups.settings.keep;
  const regular = mockBackups.items.filter((i) => i.kind !== 'pre_restore' && i.kind !== 'uploaded');
  const drop = new Set(regular.slice(keep).map((i) => i.name));
  mockBackups.items = mockBackups.items.filter((i) => !drop.has(i.name));
}

function startRun(sendTelegram: boolean): void {
  const stages = BACKUP_STAGES.filter(
    (s) =>
      (s !== 'metrics' || mockBackups.settings.includeMetrics) &&
      (s !== 'files' || mockBackups.settings.extra.enabled) &&
      (s !== 'encrypt' || mockBackups.settings.passwordSet) &&
      (s !== 'telegram' || sendTelegram),
  );
  const fail = mockBackups.failNext;
  mockBackups.failNext = false;
  mockBackups.run = {
    stage: stages[0] ?? 'db',
    startedAt: new Date(Date.now() + mockBackups.clockSkewMs).toISOString(),
    mode: 'backup',
    lastError: null,
  };
  stages.forEach((st, i) => {
    mockBackups.timers.push(
      setTimeout(() => {
        mockBackups.run = { ...mockBackups.run, stage: st };
      }, i * mockBackups.speedMs),
    );
  });
  mockBackups.timers.push(
    setTimeout(() => {
      if (fail) {
        mockBackups.run = {
          stage: null,
          startedAt: null,
          mode: null,
          lastError: 'pg_dump: нет связи с базой данных',
        };
        return;
      }
      const it = item(new Date(Date.now() + mockBackups.clockSkewMs), 'manual', 42.6 * MB, {
        encrypted: mockBackups.settings.passwordSet,
        telegram: sendTelegram ? { ok: true, note: null } : null,
        contents: {
          db: true,
          env: true,
          metrics: mockBackups.settings.includeMetrics,
          paths: mockBackups.settings.extra.enabled ? mockBackups.settings.extra.paths.length : 0,
        },
      });
      mockBackups.items = [it, ...mockBackups.items];
      retain();
      mockBackups.run = { stage: null, startedAt: null, mode: null, lastError: null };
    }, stages.length * mockBackups.speedMs),
  );
}

function inspect(it: BackupItem, password?: string): BackupInspect {
  const needsPassword = it.encrypted && password !== MOCK_BACKUP_PASSWORD;
  return {
    name: it.name,
    createdAt: it.createdAt,
    version: it.version,
    domain: 'panel.example.com',
    encrypted: it.encrypted,
    needsPassword,
    contents: needsPassword
      ? null
      : {
          dbBytes: Math.round(it.size * 0.9),
          env: true,
          metrics: it.contents?.metrics ?? false,
          paths: it.contents?.paths ?? 0,
        },
    sameKeys: needsPassword ? null : true,
    compatible: !needsPassword,
    problem: needsPassword
      ? password
        ? 'Пароль не подошёл.'
        : 'Копия защищена паролем — введите его.'
      : null,
  };
}

const find = (name: string) => mockBackups.items.find((i) => i.name === name);

export const backupsHandlers = [
  http.get('/api/backups', () =>
    HttpResponse.json({
      items: mockBackups.items,
      localLocation: '/var/lib/nodeservice/backups',
      run: mockBackups.run,
      nextAt: nextAt(),
      timeZone: 'Asia/Omsk',
      totalSize: mockBackups.items.reduce((a, i) => a + i.size, 0),
      freeBytes: 41 * 1024 * MB,
      available: true,
      unavailableReason: null,
    }),
  ),
  http.get('/api/backups/settings', () => HttpResponse.json(mockBackups.settings)),
  http.put('/api/backups/settings', async ({ request }) => {
    const b = (await request.json()) as BackupSettingsUpdate;
    mockBackups.lastUpdate = b;
    const { password, telegram, offsite, ...rest } = b;
    const s = {
      ...mockBackups.settings,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
    };
    if (telegram) {
      // Как на сервере: не передан или вернулась текущая маска — чат не меняли; null — убрать; иначе это
      // новая ссылка, и маска (в ней нет токена) за ссылку не сойдёт.
      const { ownUrl, ...tg } = telegram;
      let own = mockBackups.settings.telegram.ownUrl;
      if (ownUrl === null || ownUrl === '') own = null;
      else if (ownUrl !== undefined && ownUrl !== own) {
        const t = parseTelegramUrl(ownUrl);
        if (!t)
          return problem(
            400,
            'about:blank',
            'Свой чат — строкой вида tgram://токен_бота/id_чата (для темы — :номер_темы в конце).',
          );
        own = maskTelegramUrl(t.chatId, t.topic);
      }
      s.telegram = { ...tg, ownUrl: own };
    }
    if (offsite) {
      const changed = Boolean(offsite.accessKeyId && offsite.secretAccessKey);
      s.offsite = {
        enabled: offsite.enabled,
        endpoint: offsite.endpoint,
        region: offsite.region,
        bucket: offsite.bucket,
        prefix: offsite.prefix,
        credentialsSet: changed || mockBackups.settings.offsite.credentialsSet,
      };
    }
    if (password !== undefined) s.passwordSet = Boolean(password);
    mockBackups.settings = s as BackupSettings;
    return HttpResponse.json(mockBackups.settings);
  }),
  http.post('/api/backups/run', async ({ request }) => {
    if (mockBackups.run.stage) return problem(409, 'urn:nodeservice:problem:backup-busy', 'Копия уже идёт.');
    const b = (await request.json()) as { sendTelegram?: boolean };
    startRun(Boolean(b.sendTelegram));
    return HttpResponse.json({ ok: true }, { status: 202 });
  }),
  http.post('/api/backups/check-paths', async ({ request }) => {
    const b = (await request.json()) as { paths: string[] };
    return HttpResponse.json({
      items: b.paths.map((p) =>
        p.includes('nope') || p.endsWith('.ssh/config')
          ? { path: p, state: 'missing', size: null }
          : { path: p, state: 'dir', size: p.includes('scripts') ? Math.round(4.1 * MB) : 12 * 1024 },
      ),
    });
  }),
  http.post('/api/backups/test-chat', () => HttpResponse.json({ ok: true, detail: 'Сообщение отправлено.' })),
  http.post('/api/backups/upload', async ({ request }) => {
    const raw = decodeURIComponent(request.headers.get('x-file-name') ?? 'backup.tar.gz');
    const body = await request.arrayBuffer();
    const it = item(new Date(), 'uploaded', body.byteLength || 40 * MB, {
      encrypted: raw.endsWith('.enc'),
      telegram: null,
      verified: null,
    });
    mockBackups.items = [it, ...mockBackups.items];
    return HttpResponse.json(it, { status: 201 });
  }),
  http.get('/api/backups/:name/download', ({ params }) => {
    const it = find(String(params.name));
    if (!it) return problem(404, 'urn:nodeservice:problem:backup-not-found', 'Такой копии нет.');
    return new HttpResponse(new Blob(['mock']), {
      headers: { 'content-disposition': `attachment; filename="${it.name}"` },
    });
  }),
  http.post('/api/backups/:name/inspect', async ({ params, request }) => {
    const it = find(String(params.name));
    if (!it) return problem(404, 'urn:nodeservice:problem:backup-not-found', 'Такой копии нет.');
    const b = (await request.json().catch(() => ({}))) as { password?: string };
    return HttpResponse.json(inspect(it, b.password));
  }),
  http.post('/api/backups/:name/restore', async ({ params, request }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    const it = find(String(params.name));
    if (!it) return problem(404, 'urn:nodeservice:problem:backup-not-found', 'Такой копии нет.');
    const b = (await request.json()) as { password?: string; confirm?: string };
    if (b.confirm !== BACKUP_RESTORE_CONFIRM)
      return problem(400, 'about:blank', `Для подтверждения введите «${BACKUP_RESTORE_CONFIRM}»`);
    if (inspect(it, b.password).needsPassword)
      return problem(400, 'urn:nodeservice:problem:backup-password', 'Пароль не подошёл.');
    if (mockBackups.restoreFails)
      return problem(
        500,
        'urn:nodeservice:problem:backup-restore-failed',
        'Восстановление не удалось, текущая база не тронута: pg_restore: неожиданный конец архива',
      );
    mockBackups.restored.push(it.name);
    return HttpResponse.json({ ok: true }, { status: 202 });
  }),
  http.delete('/api/backups/:name', ({ params }) => {
    const stepUp = requireStepUp();
    if (stepUp) return stepUp;
    const it = find(String(params.name));
    if (!it) return problem(404, 'urn:nodeservice:problem:backup-not-found', 'Такой копии нет.');
    mockBackups.items = mockBackups.items.filter((i) => i.name !== it.name);
    return new HttpResponse(null, { status: 204 });
  }),
];

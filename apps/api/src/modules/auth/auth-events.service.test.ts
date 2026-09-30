import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditRecordInput, AuditService } from '../audit/audit.service.js';
import type { NotificationsService, PushInput } from '../notifications/notifications.service.js';
import type { AnonAuditLimiter } from './anon-audit.limiter.js';
import { type AuthEventContext, AuthEventsService } from './auth-events.service.js';
import type { FailOutcome, ThrottleScope, ThrottleService } from './throttle.service.js';

const ctx: AuthEventContext = {
  ip: '203.0.113.7',
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
  requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  login: 'admin',
};
const started = (seconds: number, ...kinds: ThrottleScope['kind'][]): FailOutcome => ({
  retryAfterSeconds: seconds,
  started: kinds.map((kind) => ({ scope: { kind, value: 'x' }, seconds, series: 1 })),
});

describe('AuthEventsService: серии неудач, уведомления и сводки', () => {
  let written: AuditRecordInput[];
  let limited: AuditRecordInput[];
  let pushed: PushInput[];
  let claim: { rejected: number } | null;
  let rejectedCount: number;
  let claimFails: boolean;
  let claimedAsReal: boolean[];
  let svc: AuthEventsService;

  beforeEach(() => {
    written = [];
    limited = [];
    pushed = [];
    claim = { rejected: 0 };
    rejectedCount = 0;
    claimFails = false;
    claimedAsReal = [];
    const logger = { setContext: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as PinoLogger;
    const audit = {
      record: async (input: AuditRecordInput) => {
        written.push(input);
        return null;
      },
    } as unknown as AuditService;
    const limiter = {
      record: async (_kind: string, _ip: string, input: AuditRecordInput) => {
        limited.push(input);
      },
    } as unknown as AnonAuditLimiter;
    const throttle = {
      claimNotification: async (_kind: string, _ip: string, _login: string, loginExists: boolean) => {
        if (claimFails) throw new Error('Valkey недоступен');
        claimedAsReal.push(loginExists);
        return claim;
      },
      takeRejected: async () => rejectedCount,
    } as unknown as ThrottleService;
    const notifications = {
      push: async (input: PushInput) => {
        pushed.push(input);
      },
    } as unknown as NotificationsService;
    svc = new AuthEventsService(logger, audit, limiter, throttle, notifications);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('пауза по логину и адресу: запись в Журнал и сообщение называют ровно то, что приостановлено', async () => {
    await svc.pauseStarted(ctx, 'password', started(30, 'ip', 'login'));
    // гость (пароль не подтверждён) — запись идёт через предел записей без входа
    expect(written).toHaveLength(0);
    expect(limited[0]).toMatchObject({
      action: 'auth.login.throttled',
      result: 'denied',
      actor: { type: 'anonymous', display: 'admin' },
      metadata: {
        login: 'admin',
        note: 'Пароль не подошёл. Вход по этому логину и с этого адреса приостановлен на 30 с.',
      },
    });
    expect(pushed).toEqual([
      {
        severity: 'info',
        title: 'Серия неудачных попыток входа',
        body: 'Логин «admin»: пароль не подошёл, неудачных попыток подряд — 5. Вход по этому логину и с этого адреса приостановлен на 30 с. С запомненных устройств войти можно — только не с этого адреса. Адрес 203.0.113.7, Chrome на macOS. Если это не вы — пароль не подобран; панель сама сдерживает перебор, пауза растёт с каждой серией.',
        link: { to: '/settings/security', label: 'Открыть безопасность' },
        telegram: { event: 'login' },
      },
    ]);
  });

  it('настоящий и выдуманный логин: записи в Журнал идут одинаково, различается только интервал сообщений', async () => {
    // Логин есть в базе (пароль ещё не подтверждён) и логина нет: в Журнал оба — через один предел записей
    // (будь разница, по времени ответа можно было бы узнавать, существует ли логин).
    await svc.record('auth.login.failed', { ...ctx, loginExists: true, meta: { reason: 'credentials' } });
    await svc.pauseStarted({ ...ctx, loginExists: true }, 'password', started(30, 'ip', 'login'));
    await svc.record('auth.login.failed', { ...ctx, login: 'root', meta: { reason: 'credentials' } });
    await svc.pauseStarted({ ...ctx, login: 'root' }, 'password', started(30, 'ip', 'login'));
    expect(written).toHaveLength(0);
    expect(limited.map((w) => w.action)).toEqual([
      'auth.login.failed',
      'auth.login.throttled',
      'auth.login.failed',
      'auth.login.throttled',
    ]);
    expect(limited[0]).toMatchObject({ actor: { type: 'anonymous', display: 'admin' } });
    expect(limited[0]?.metadata).toEqual({ login: 'admin', reason: 'credentials' });
    // Сообщения: у настоящего логина свой интервал, серия по выдуманному его не занимает.
    expect(claimedAsReal).toEqual([true, false]);
    // Пароль подтверждён (шаг кода, экран блокировки) — это всегда настоящий логин, запись идёт напрямую.
    await svc.pauseStarted({ ...ctx, userId: 'u-1' }, 'unlock', started(30, 'ip', 'known'));
    expect(claimedAsReal).toEqual([true, false, true]);
    expect(written.map((w) => w.action)).toEqual(['auth.login.throttled']);
  });

  it('пауза только по адресу или только по логину — без лишних слов; длинная пауза — в минутах', async () => {
    await svc.pauseStarted(ctx, 'password', started(300, 'ip'));
    expect(pushed[0]?.body).toContain('Вход с этого адреса приостановлен на 5 мин. Адрес');
    expect(pushed[0]?.body).not.toContain('запомненных');
    await svc.pauseStarted(ctx, 'password', started(900, 'login'));
    expect(pushed[1]?.body).toContain(
      'Вход по этому логину приостановлен на 15 мин. С запомненных устройств войти можно.',
    );
  });

  it('кулдаун: запись в Журнале есть, сообщения нет; после него — с числом отклонённых попыток', async () => {
    claim = null;
    await svc.pauseStarted(ctx, 'password', started(60, 'ip', 'login'));
    expect(limited).toHaveLength(1);
    expect(pushed).toHaveLength(0);
    claim = { rejected: 1234 };
    await svc.pauseStarted(ctx, 'password', started(300, 'ip', 'login'));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.body).toContain(' С прошлого сообщения отклонено попыток: 1234. Если это не вы');
  });

  it('сообщение не получилось отправить — сам отказ от этого не ломается', async () => {
    claimFails = true;
    await expect(svc.pauseStarted(ctx, 'password', started(30, 'ip', 'login'))).resolves.toBeUndefined();
    expect(limited).toHaveLength(1);
    expect(pushed).toHaveLength(0);
  });

  it('неверный код после верного пароля: без паузы молчим до пятого за сутки; про блокировку — только когда она есть', async () => {
    const user = { ...ctx, userId: 'u-1' };
    const none: FailOutcome = { retryAfterSeconds: 0, started: [] };
    await svc.secondStepFailed(user, 'code', none, { count: 1, closedSeconds: 0 }, true);
    await svc.secondStepFailed(user, 'code', none, { count: 4, closedSeconds: 0 }, true);
    expect(pushed).toHaveLength(0);
    expect(written).toHaveLength(0);

    await svc.secondStepFailed(user, 'recovery', none, { count: 5, closedSeconds: 0 }, true);
    expect(pushed[0]).toMatchObject({ severity: 'warn', title: 'Пароль введён верно, но код не подошёл' });
    expect(pushed[0]?.body).toBe(
      'Логин «admin»: пароль введён верно, но код восстановления не подошёл. За сутки так было уже 5 раз. Адрес 203.0.113.7, Chrome на macOS. Если это не вы — смените пароль в «Настройки → Безопасность»: он известен постороннему.',
    );
    expect(pushed[0]?.body).not.toMatch(/приостановлен|заблокирован/);

    await svc.secondStepFailed(
      user,
      'code',
      started(30, 'ip', 'login'),
      { count: 9, closedSeconds: 0 },
      true,
    );
    expect(pushed[1]?.body).toContain(
      'пароль введён верно, но код из приложения не подошёл. Неудачных попыток подряд — 5. Вход по этому логину и с этого адреса приостановлен на 30 с. С запомненных устройств войти можно — только не с этого адреса. Адрес',
    );
    // пароль подтверждён — запись идёт в Журнал напрямую, от имени администратора
    expect(written[0]).toMatchObject({
      action: 'auth.login.throttled',
      actor: { type: 'admin', id: 'u-1', display: 'admin' },
      metadata: {
        note: 'Пароль введён верно, код из приложения не подошёл. Вход по этому логину и с этого адреса приостановлен на 30 с.',
      },
    });
  });

  it('суточный лимит: своя запись и сообщение без кулдауна, с остатком времени', async () => {
    claim = null; // кулдаун серий на это сообщение не действует
    const user = { ...ctx, userId: 'u-1' };
    await svc.secondStepFailed(
      user,
      'code',
      { retryAfterSeconds: 0, started: [] },
      { count: 20, closedSeconds: 23 * 3600 + 40 * 60 },
      true,
    );
    expect(written[0]).toMatchObject({
      action: 'auth.totp.limit',
      result: 'denied',
      metadata: { note: 'Неверных кодов за сутки: 20. Вход по коду из приложения закрыт на 23 ч 40 мин.' },
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ severity: 'warn', title: 'Вход по коду из приложения закрыт' });
    expect(pushed[0]?.body).toBe(
      'Логин «admin»: за сутки пароль 20 раз был введён верно, а код не подошёл. Вход по коду из приложения закрыт на 23 ч 40 мин. С запомненных устройств и по коду восстановления войти можно. Адрес 203.0.113.7, Chrome на macOS. Если это не вы — смените пароль в «Настройки → Безопасность»: он известен постороннему.',
    );

    // Политика «всегда спрашивать код»: запомненное устройство без кода не войдёт — его и не обещаем.
    await svc.secondStepFailed(
      user,
      'code',
      { retryAfterSeconds: 0, started: [] },
      { count: 20, closedSeconds: 3600 },
      false,
    );
    expect(pushed[1]?.body).toContain('закрыт на 1 ч. По коду восстановления войти можно. Адрес');
    expect(pushed[1]?.body).not.toContain('запомненных');
  });

  it('вход по коду восстановления: сообщение с остатком кодов, важность «предупреждение» (колокольчик)', async () => {
    await svc.record('auth.recovery.used', {
      ...ctx,
      userId: 'u-1',
      amr: ['pwd', 'recovery'],
      meta: { recoveryCodesLeft: 7, sessionsRevoked: 2 },
    });
    expect(pushed).toEqual([
      {
        severity: 'warn',
        title: 'Вход по коду восстановления',
        body: 'Вошёл «admin»: вместо кода из приложения введён код восстановления. Адрес 203.0.113.7, Chrome на macOS. Остальные сессии завершены, запомненные устройства забыты. Кодов восстановления осталось: 7. Если это не вы — смените пароль и перевыпустите 2FA в «Настройки → Безопасность».',
        link: { to: '/settings/security', label: 'Открыть безопасность' },
        telegram: { event: 'login' },
      },
    ]);
    // обычный вход с запомненного устройства — по-прежнему без сообщения
    await svc.record('auth.login.success', { ...ctx, userId: 'u-1', amr: ['pwd', 'trusted'] });
    expect(pushed).toHaveLength(1);
  });

  it('отказы во время паузы: ни записи, ни сообщения на каждый — одна сводка, когда пауза кончилась', async () => {
    vi.useFakeTimers();
    const scope: ThrottleScope = { kind: 'login', value: 'admin' };
    // адрес на паузе ещё 15 минут, логин — 30 секунд: сводка по логину ждёт конца именно его паузы
    const paused = {
      allowed: false,
      reason: 'paused',
      retryAfterSeconds: 900,
      scope,
      scopeSeconds: 30,
      rejected: 1,
    } as const;
    for (let i = 0; i < 50; i++) svc.rejected(ctx, paused);
    expect(limited).toHaveLength(0);
    expect(pushed).toHaveLength(0);

    rejectedCount = 50;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(limited).toHaveLength(0); // пауза ещё идёт
    await vi.advanceTimersByTimeAsync(1_500);
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      action: 'auth.login.rejected',
      result: 'denied',
      source: 'auto',
      actor: { type: 'anonymous', display: 'admin' },
      // пауза по логину — отказы шли с разных адресов, одного адреса у сводки нет
      ip: '',
      metadata: { login: 'admin', note: 'Отклонено попыток: 50' },
    });
    // сводка одна: таймер снят, повторный вызов ничего не пишет
    await svc.flushRejected();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(limited).toHaveLength(1);
  });

  it('сводка по паузе адреса хранит адрес; остановка панели дописывает сводки сразу', async () => {
    const scope: ThrottleScope = { kind: 'ip', value: '203.0.113.7' };
    svc.rejected(ctx, {
      allowed: false,
      reason: 'paused',
      retryAfterSeconds: 900,
      scope,
      scopeSeconds: 900,
      rejected: 1,
    });
    rejectedCount = 3;
    await svc.onModuleDestroy();
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ ip: '203.0.113.7', actor: { display: '—' } });
    expect(limited[0]?.metadata).toEqual({ note: 'Отклонено попыток: 3' });
  });
});

import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import {
  type AuditResult,
  type AuditSeverity,
  type AuditSource,
  type Me,
  THROTTLE_FREE_ATTEMPTS,
} from '@nodeservice/shared';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../audit/audit.service.js';
import { NotificationsService, type PushInput } from '../notifications/notifications.service.js';
import { AnonAuditLimiter } from './anon-audit.limiter.js';
import { formatWait } from './auth.problems.js';
import {
  type AttemptKind,
  type FailOutcome,
  type Reservation,
  SECOND_FACTOR_LIMIT,
  type ThrottleScope,
  ThrottleService,
} from './throttle.service.js';

export type AuthEvent =
  | 'auth.setup.completed'
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.login.throttled'
  | 'auth.login.rejected'
  | 'auth.totp.failed'
  | 'auth.totp.limit'
  | 'auth.recovery.used'
  | 'auth.logout'
  | 'auth.lock'
  | 'auth.unlock'
  | 'auth.trusted_device.added';

export interface AuthEventContext {
  userId?: string;
  login?: string;
  /**
   * Логин принадлежит настоящему пользователю (пароль при этом ещё не подтверждён). Влияет только на то,
   * как часто владельцу приходят сообщения о сериях; в ответе клиенту и в записи Журнала разницы нет —
   * иначе по ней можно было бы узнавать, существует ли логин.
   */
  loginExists?: boolean;
  ip: string;
  ua: string;
  requestId: string;
  amr?: Me['amr'];
  /** Небольшие безопасные детали (без секретов): например, причина или остаток кодов. */
  meta?: Record<string, string | number | boolean>;
}

/** На каком шаге входа случилась неудача: от этого зависят и счёт, и честный текст для владельца. */
export type AttemptStage = 'password' | 'unlock' | 'code' | 'recovery';

/**
 * На каком неверном коде за сутки владелец получает сообщение, даже если паузы не было: медленный
 * перебор кода (по паре попыток в час) иначе остался бы незамеченным.
 */
export const SECOND_FACTOR_NOTIFY_AT = 5;

const OUTCOME: Record<AuthEvent, { result: AuditResult; severity: AuditSeverity; source?: AuditSource }> = {
  'auth.setup.completed': { result: 'ok', severity: 'info' },
  'auth.login.success': { result: 'ok', severity: 'info' },
  'auth.login.failed': { result: 'failed', severity: 'warn' },
  'auth.login.throttled': { result: 'denied', severity: 'warn' },
  // Сводку пишет сама панель, когда пауза кончилась, — не запрос.
  'auth.login.rejected': { result: 'denied', severity: 'warn', source: 'auto' },
  'auth.totp.failed': { result: 'failed', severity: 'warn' },
  'auth.totp.limit': { result: 'denied', severity: 'warn' },
  'auth.recovery.used': { result: 'ok', severity: 'warn' },
  'auth.logout': { result: 'ok', severity: 'info' },
  'auth.lock': { result: 'ok', severity: 'info' },
  'auth.unlock': { result: 'ok', severity: 'info' },
  'auth.trusted_device.added': { result: 'ok', severity: 'info' },
};

const STAGE_NOTE: Record<AttemptStage, string> = {
  password: 'Пароль не подошёл.',
  unlock: 'Экран блокировки: пароль не подошёл.',
  code: 'Пароль введён верно, код из приложения не подошёл.',
  recovery: 'Пароль введён верно, код восстановления не подошёл.',
};

const SECURITY_LINK = { to: '/settings/security', label: 'Открыть безопасность' };
const CHANGE_PASSWORD =
  'Если это не вы — смените пароль в «Настройки → Безопасность»: он известен постороннему.';

/** Отказы одной паузы, которые ждут сводной записи. */
interface PendingSummary {
  timer: NodeJS.Timeout;
  scope: ThrottleScope;
  ctx: Pick<AuthEventContext, 'userId' | 'login' | 'ip'>;
}

/**
 * События входа → Журнал (audit_log) + структурированная строка pino.
 * Никаких паролей, кодов и токенов в контексте быть не должно — только факт и причина.
 * Актор задаётся явно: на этих путях сессии в CLS ещё нет (гость) или она только что создана.
 */
@Injectable()
export class AuthEventsService implements OnModuleDestroy {
  /** Паузы, во время которых были отказы: область → таймер сводной записи. */
  private readonly summaries = new Map<string, PendingSummary>();

  constructor(
    private readonly logger: PinoLogger,
    private readonly audit: AuditService,
    private readonly limiter: AnonAuditLimiter,
    private readonly throttle: ThrottleService,
    // Нет в консольной утилите панели (rescue CLI): там вход только пишется в Журнал.
    @Optional() private readonly notifications?: NotificationsService,
  ) {
    this.logger.setContext('AuthEvents');
  }

  async record(event: AuthEvent, ctx: AuthEventContext): Promise<void> {
    const payload = {
      event,
      userId: ctx.userId,
      login: ctx.login,
      ip: ctx.ip,
      ua: ctx.ua.slice(0, 256),
      requestId: ctx.requestId,
      amr: ctx.amr,
      ...(ctx.meta ?? {}),
    };
    if (event.endsWith('.failed') || event.endsWith('.throttled')) this.logger.warn(payload, event);
    else this.logger.info(payload, event);

    const { result, severity, source } = OUTCOME[event];
    const entry = {
      action: event,
      result,
      severity,
      source: source ?? 'manual',
      actor: ctx.userId
        ? ({ type: 'admin', id: ctx.userId, display: ctx.login ?? 'admin' } as const)
        : ({ type: 'anonymous', id: null, display: ctx.login ?? '—' } as const),
      ip: ctx.ip,
      userAgent: ctx.ua,
      requestId: ctx.requestId,
      metadata: {
        ...(ctx.login ? { login: ctx.login } : {}),
        ...(ctx.amr ? { amr: ctx.amr } : {}),
        ...(ctx.meta ?? {}),
      },
    };
    // Записи от гостя (пароль не подтверждён) может создавать кто угодно — у них предел в минуту. Предел
    // один для настоящих и выдуманных логинов: по разнице во времени ответа нельзя узнать, есть ли логин.
    if (ctx.userId) await this.audit.record(entry);
    else await this.limiter.record('login', ctx.ip, entry);

    // Telegram «Вход в панель»: вход без доверенного устройства (значит, новое). Вход с доверенного
    // устройства — обычная жизнь, не шумим. Серии неудач — отдельно и не чаще кулдауна (pauseStarted).
    if (event === 'auth.login.success' && !(ctx.amr ?? []).includes('trusted'))
      await this.notify({
        severity: 'info',
        title: 'Вход в панель с нового устройства',
        body: `Вошёл «${ctx.login ?? 'admin'}». IP ${ctx.ip}, ${deviceOf(ctx.ua)}. Если это не вы — смените пароль в «Настройки → Безопасность».`,
      });
    // Вход по коду восстановления — обход второго фактора, и он выкидывает остальные сессии: владелец
    // должен узнать об этом сразу, в том числе в колокольчике (важность «предупреждение»).
    if (event === 'auth.recovery.used')
      await this.notify({
        severity: 'warn',
        title: 'Вход по коду восстановления',
        body: `Вошёл «${ctx.login ?? 'admin'}»: вместо кода из приложения введён код восстановления. ${where(ctx)} Остальные сессии завершены, запомненные устройства забыты. Кодов восстановления осталось: ${ctx.meta?.recoveryCodesLeft ?? 0}. Если это не вы — смените пароль и перевыпустите 2FA в «Настройки → Безопасность».`,
      });
  }

  /**
   * Неудача на шаге пароля (вход или экран блокировки) включила паузу: одна запись в Журнал на серию и
   * одно сообщение — если этой паре адрес/логин и вообще о таких сериях недавно не писали.
   */
  async pauseStarted(
    ctx: AuthEventContext,
    stage: 'password' | 'unlock',
    outcome: FailOutcome,
  ): Promise<void> {
    const paused = pausedSentence(stage, outcome);
    await this.record('auth.login.throttled', { ...ctx, meta: { note: `${STAGE_NOTE[stage]} ${paused}` } });
    const login = ctx.login ?? '—';
    await this.notifySeries('password', ctx, (rejected) => ({
      severity: 'info',
      title: 'Серия неудачных попыток входа',
      body:
        stage === 'unlock'
          ? `Логин «${login}»: на экране блокировки пароль не подошёл, неудачных попыток подряд — ${THROTTLE_FREE_ATTEMPTS}. ${paused} ${where(ctx)}${rejected} Если это не вы — завершите эту сессию в «Настройки → Безопасность».`
          : `Логин «${login}»: пароль не подошёл, неудачных попыток подряд — ${THROTTLE_FREE_ATTEMPTS}. ${paused}${rememberedHint(outcome)} ${where(ctx)}${rejected} Если это не вы — пароль не подобран; панель сама сдерживает перебор, пауза растёт с каждой серией.`,
    }));
  }

  /**
   * Неверный код после верного пароля. Это серьёзнее неверного пароля: пароль кому-то известен.
   * Сообщение приходит, когда включилась пауза, когда за сутки набралось SECOND_FACTOR_NOTIFY_AT неверных
   * кодов и когда суточный лимит закрыл вход по коду. Про блокировку говорится, только если она есть.
   */
  async secondStepFailed(
    ctx: AuthEventContext,
    stage: 'code' | 'recovery',
    outcome: FailOutcome,
    day: { count: number; closedSeconds: number },
    /** Запомненные устройства входят без кода (политика «всегда спрашивать код» выключена). */
    rememberedWorks: boolean,
  ): Promise<void> {
    const login = ctx.login ?? '—';
    const started = outcome.started.length > 0;
    const paused = started ? pausedSentence(stage, outcome) : '';
    if (started)
      await this.record('auth.login.throttled', { ...ctx, meta: { note: `${STAGE_NOTE[stage]} ${paused}` } });

    if (day.closedSeconds > 0) {
      const closed = `Вход по коду из приложения закрыт на ${formatWait(day.closedSeconds)}.`;
      await this.record('auth.totp.limit', {
        ...ctx,
        meta: { note: `Неверных кодов за сутки: ${SECOND_FACTOR_LIMIT}. ${closed}` },
      });
      // Без кулдауна: лимит достигается один раз за окно, и это самое важное сообщение из всех.
      await this.notify({
        severity: 'warn',
        title: 'Вход по коду из приложения закрыт',
        body: `Логин «${login}»: за сутки пароль ${SECOND_FACTOR_LIMIT} раз был введён верно, а код не подошёл. ${closed} ${rememberedWorks ? 'С запомненных устройств и по коду восстановления' : 'По коду восстановления'} войти можно. ${where(ctx)} ${CHANGE_PASSWORD}`,
      });
      return;
    }
    if (!started && day.count !== SECOND_FACTOR_NOTIFY_AT) return;
    const what = stage === 'code' ? 'код из приложения' : 'код восстановления';
    const detail = started
      ? `Неудачных попыток подряд — ${THROTTLE_FREE_ATTEMPTS}. ${paused}${rememberedHint(outcome)}`
      : `За сутки так было уже ${day.count} раз.`;
    await this.notifySeries('code', ctx, (rejected) => ({
      severity: 'warn',
      title: 'Пароль введён верно, но код не подошёл',
      body: `Логин «${login}»: пароль введён верно, но ${what} не подошёл. ${detail} ${where(ctx)}${rejected} ${CHANGE_PASSWORD}`,
    }));
  }

  /**
   * Запрос отклонён во время паузы. Ни записи в Журнал, ни сообщения на каждый такой запрос: они только
   * считаются в Valkey, а когда пауза кончится, в Журнал пойдёт одна сводная запись с их числом.
   */
  rejected(ctx: AuthEventContext, reservation: Extract<Reservation, { reason: 'paused' }>): void {
    const { scope } = reservation;
    const key = `${scope.kind}:${scope.value}`;
    if (this.summaries.has(key)) return;
    const timer = setTimeout(
      () => void this.writeSummary(key).catch(() => undefined),
      reservation.scopeSeconds * 1000 + 1_000,
    );
    timer.unref();
    this.summaries.set(key, {
      timer,
      scope,
      // Пауза по адресу — отказы с него при любых логинах; по логину — с любых адресов.
      ctx:
        scope.kind === 'ip'
          ? { ip: ctx.ip }
          : {
              ip: '',
              ...(ctx.login ? { login: ctx.login } : {}),
              ...(ctx.userId ? { userId: ctx.userId } : {}),
            },
    });
  }

  /** Записать сводки по всем паузам, не дожидаясь их конца (остановка панели, тесты). */
  async flushRejected(): Promise<void> {
    for (const key of [...this.summaries.keys()]) await this.writeSummary(key);
  }

  async onModuleDestroy(): Promise<void> {
    await this.flushRejected().catch(() => undefined);
  }

  private async writeSummary(key: string): Promise<void> {
    const pending = this.summaries.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.summaries.delete(key);
    const count = await this.throttle.takeRejected(pending.scope);
    if (count === 0) return;
    await this.record('auth.login.rejected', {
      ...pending.ctx,
      ua: '',
      requestId: '',
      meta: { note: `Отклонено попыток: ${count}` },
    });
  }

  /** Сообщение о серии — не чаще кулдауна; в текст идёт число попыток, отклонённых с прошлого сообщения. */
  private async notifySeries(
    kind: AttemptKind,
    ctx: AuthEventContext,
    build: (rejected: string) => Pick<PushInput, 'severity' | 'title' | 'body'>,
  ): Promise<void> {
    if (!this.notifications) return;
    try {
      const claim = await this.throttle.claimNotification(kind, ctx.ip, ctx.login ?? '', isRealLogin(ctx));
      if (!claim) return;
      await this.notify(
        build(claim.rejected > 0 ? ` С прошлого сообщения отклонено попыток: ${claim.rejected}.` : ''),
      );
    } catch (err) {
      // Сообщение не должно ронять сам вход: отказ и пауза уже случились и записаны.
      this.logger.warn({ err: (err as Error).message }, 'уведомление о серии неудач не отправлено');
    }
  }

  private async notify(input: Pick<PushInput, 'severity' | 'title' | 'body'>): Promise<void> {
    await this.notifications?.push({ ...input, link: SECURITY_LINK, telegram: { event: 'login' } });
  }
}

/** Событие о настоящем логине: пароль уже подтверждён (известен пользователь) или логин найден в базе. */
function isRealLogin(ctx: Pick<AuthEventContext, 'userId' | 'loginExists'>): boolean {
  return Boolean(ctx.userId) || ctx.loginExists === true;
}

/** «Адрес 203.0.113.7, Chrome на macOS.» */
function where(ctx: Pick<AuthEventContext, 'ip' | 'ua'>): string {
  return `Адрес ${ctx.ip}, ${deviceOf(ctx.ua)}.`;
}

/**
 * Что именно встало на паузу и на сколько: «Вход по этому логину и с этого адреса приостановлен на 30 с.»
 * Называем только то, что действительно приостановлено этой неудачей.
 */
function pausedSentence(stage: AttemptStage, outcome: FailOutcome): string {
  const kinds = new Set(outcome.started.map((s) => s.scope.kind));
  const unlock = stage === 'unlock';
  const places = [
    ...(kinds.has('login') ? ['по этому логину'] : []),
    ...(kinds.has('known') ? [unlock ? 'в этой сессии' : 'с этого устройства'] : []),
    ...(kinds.has('ip') ? ['с этого адреса'] : []),
  ].join(' и ');
  const wait = formatWait(Math.max(0, ...outcome.started.map((s) => s.seconds)));
  return unlock
    ? `Разблокировка ${places} приостановлена на ${wait}.`
    : `Вход ${places} приостановлен на ${wait}.`;
}

/**
 * Пауза по логину держит только новые устройства — владельцу стоит знать, что с запомненных он войдёт.
 * Если той же неудачей приостановлен и адрес, с него не войти ни с какого устройства — так и говорим.
 */
function rememberedHint(outcome: FailOutcome): string {
  const kinds = new Set(outcome.started.map((s) => s.scope.kind));
  if (!kinds.has('login')) return '';
  return kinds.has('ip')
    ? ' С запомненных устройств войти можно — только не с этого адреса.'
    : ' С запомненных устройств войти можно.';
}

/** «Chrome на macOS» из User-Agent — достаточно, чтобы узнать своё устройство. */
function deviceOf(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /YaBrowser/.test(ua)
      ? 'Яндекс Браузер'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'браузер';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'неизвестной системе';
  return `${browser} на ${os}`;
}

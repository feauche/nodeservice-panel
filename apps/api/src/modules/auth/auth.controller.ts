import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AuthStatus,
  CsrfResponse,
  LoginResponse,
  Me,
  SessionResponse,
  SetupConfirmResponse,
  SetupStartResponse,
} from '@nodeservice/shared';
import type { Request, Response } from 'express';

import { CookiesService } from '../../common/http/cookies.service.js';
import { CsrfService } from '../../common/http/csrf.service.js';
import { CurrentSession, CurrentUser, type CurrentUserPayload, Public } from './auth.decorators.js';
import {
  AuthStatusDto,
  CsrfTokenDto,
  LoginRequestDto,
  LoginResponseDto,
  MeDto,
  RecoveryLoginRequestDto,
  SessionResponseDto,
  SetupConfirmRequestDto,
  SetupConfirmResponseDto,
  SetupStartRequestDto,
  SetupStartResponseDto,
  TotpLoginRequestDto,
  UnlockRequestDto,
} from './auth.dto.js';
import {
  type AuthResult,
  AuthService,
  type CookieActions,
  cookieActionsOf,
  TRUSTED_DEVICE_TTL_MS,
} from './auth.service.js';
import { type AuthenticatedRequest, requestContext } from './request-context.js';
import type { SessionRecord } from './session.store.js';
import { SetupService } from './setup.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly setup: SetupService,
    private readonly cookies: CookiesService,
    private readonly csrf: CsrfService,
  ) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Нужен ли первый запуск и есть ли сессия' })
  @ApiOkResponse({ type: AuthStatusDto })
  async status(@Req() req: AuthenticatedRequest): Promise<AuthStatus> {
    return {
      setupRequired: await this.setup.isSetupRequired(),
      authenticated: Boolean(req.session),
      locked: Boolean(req.session?.lockedAt),
    };
  }

  @Public()
  @Get('csrf')
  @ApiOperation({ summary: 'CSRF-токен для мутирующих запросов (заголовок x-csrf-token)' })
  @ApiOkResponse({ type: CsrfTokenDto })
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response): CsrfResponse {
    return { token: this.csrf.issueToken(req, res) };
  }

  /* ---------- первый запуск ---------- */

  @Public()
  @Post('setup/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Первый запуск: токен + логин + пароль → секрет TOTP' })
  @ApiOkResponse({ type: SetupStartResponseDto })
  async setupStart(
    @Body() body: SetupStartRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SetupStartResponse> {
    const result = await this.auth.setupStart(body, requestContext(req));
    this.applyCookies(res, result.cookies);
    return result.body;
  }

  @Public()
  @Post('setup/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Первый запуск: код из приложения → коды восстановления + сессия' })
  @ApiOkResponse({ type: SetupConfirmResponseDto })
  async setupConfirm(
    @Body() body: SetupConfirmRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SetupConfirmResponse> {
    return this.run(res, () =>
      this.auth.setupConfirm(this.cookies.read(req, 'pending'), body.code, requestContext(req)),
    );
  }

  /* ---------- вход ---------- */

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вход: логин + пароль → сессия (доверенное устройство) или шаг TOTP' })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(
    @Body() body: LoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body, this.cookies.read(req, 'trusted'), requestContext(req));
    this.applyCookies(res, result.cookies);
    return result.body;
  }

  @Public()
  @Post('login/totp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вход: код TOTP (и «запомнить устройство»)' })
  @ApiOkResponse({ type: SessionResponseDto })
  async loginTotp(
    @Body() body: TotpLoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return this.run(res, () =>
      this.auth.loginTotp(this.cookies.read(req, 'pending'), body, requestContext(req)),
    );
  }

  @Public()
  @Post('login/recovery')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вход: код восстановления вместо TOTP' })
  @ApiOkResponse({ type: SessionResponseDto })
  async loginRecovery(
    @Body() body: RecoveryLoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return this.run(res, () =>
      this.auth.loginRecovery(this.cookies.read(req, 'pending'), body.code, requestContext(req)),
    );
  }

  /* ---------- в сессии ---------- */

  @Post('lock')
  @HttpCode(204)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Заблокировать экран: сессия живёт, но до /unlock остальные запросы получают 403',
  })
  async lock(
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.lock(user, session, requestContext(req));
  }

  @Post('unlock')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Экран блокировки: пароль ещё раз (step-up)' })
  @ApiOkResponse({ type: SessionResponseDto })
  unlock(
    @Body() body: UnlockRequestDto,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
    @Req() req: Request,
  ): Promise<SessionResponse> {
    return this.auth.unlock(user, session, body.password, requestContext(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Выход: сессия удаляется, cookie очищаются (идемпотентно, всегда 204)' })
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.session, requestContext(req));
    this.applyCookies(res, { clearSession: true, clearPending: true });
  }

  @Get('me')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Текущий пользователь и сессия' })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUser() user: CurrentUserPayload, @CurrentSession() session: SessionRecord): Promise<Me> {
    return this.auth.me(user, session);
  }

  /** Cookie применяются и на успехе, и на ошибке, к которой сервис приложил действия (withCookies). */
  private async run<T>(res: Response, fn: () => Promise<AuthResult<T>>): Promise<T> {
    try {
      const result = await fn();
      this.applyCookies(res, result.cookies);
      return result.body;
    } catch (err) {
      const actions = cookieActionsOf(err);
      if (actions) this.applyCookies(res, actions);
      throw err;
    }
  }

  private applyCookies(res: Response, actions: CookieActions): void {
    if (actions.clearSession) this.cookies.clear(res, 'session');
    if (actions.setSession) this.cookies.set(res, 'session', actions.setSession);
    if (actions.clearPending) this.cookies.clear(res, 'pending');
    if (actions.setPending) this.cookies.set(res, 'pending', actions.setPending, actions.setPendingTtlMs);
    if (actions.clearTrusted) this.cookies.clear(res, 'trusted');
    if (actions.setTrusted) this.cookies.set(res, 'trusted', actions.setTrusted, TRUSTED_DEVICE_TTL_MS);
  }
}

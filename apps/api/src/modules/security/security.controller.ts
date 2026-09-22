import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RevokeResult } from '@nodeservice/shared';
import type { Request, Response } from 'express';
import { problem } from '../../common/filters/problem-details.filter.js';
import { CookiesService } from '../../common/http/cookies.service.js';
import { CurrentSession, CurrentUser, type CurrentUserPayload } from '../auth/auth.decorators.js';
import { requestContext } from '../auth/request-context.js';
import type { SessionRecord } from '../auth/session.store.js';
import {
  ChangePasswordRequestDto,
  ChangePasswordResponseDto,
  RecoveryCodesViewDto,
  RecoveryRegenerateResponseDto,
  RevokeResultDto,
  SecurityOverviewDto,
  SecurityPolicyDto,
  SecurityPolicyUpdateDto,
  SessionsResponseDto,
  TotpConfirmRequestDto,
  TotpConfirmResponseDto,
  TotpReissueResponseDto,
  TrustedDevicesResponseDto,
} from './security.dto.js';
import { SecurityService } from './security.service.js';
import { StepUpGuard } from './step-up.guard.js';

const PUBLIC_SESSION_ID = /^[a-f0-9]{16}$/;

@ApiTags('security')
@ApiCookieAuth()
@Controller('security')
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly cookies: CookiesService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Безопасность: сводка (пароль, 2FA, коды, сессии, устройства, политика)' })
  @ApiOkResponse({ type: SecurityOverviewDto })
  overview(@CurrentUser() user: CurrentUserPayload): Promise<SecurityOverviewDto> {
    return this.security.overview(user);
  }

  /* ---------- пароль ---------- */

  @Post('password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Сменить пароль (текущий пароль = подтверждение); остальные сессии завершаются' })
  @ApiOkResponse({ type: ChangePasswordResponseDto })
  changePassword(
    @Body() body: ChangePasswordRequestDto,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
    @Req() req: Request,
  ): Promise<ChangePasswordResponseDto> {
    return this.security.changePassword(user, session, body, requestContext(req));
  }

  /* ---------- 2FA ---------- */

  @Post('totp/reissue')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Перевыпуск 2FA: новый секрет и QR (step-up); старый работает до подтверждения' })
  @ApiOkResponse({ type: TotpReissueResponseDto })
  totpReissue(@CurrentUser() user: CurrentUserPayload): Promise<TotpReissueResponseDto> {
    return this.security.totpReissueStart(user);
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Подтвердить новый секрет кодом: устройства и другие сессии сбрасываются' })
  @ApiOkResponse({ type: TotpConfirmResponseDto })
  async totpConfirm(
    @Body() body: TotpConfirmRequestDto,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpConfirmResponseDto> {
    const result = await this.security.totpReissueConfirm(user, session, body.code);
    this.cookies.clear(res, 'trusted');
    return result;
  }

  /* ---------- коды восстановления ---------- */

  @Get('recovery-codes')
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Показать коды восстановления ещё раз (step-up; просмотр пишется в Журнал)' })
  @ApiOkResponse({ type: RecoveryCodesViewDto })
  viewRecoveryCodes(@CurrentUser() user: CurrentUserPayload): Promise<RecoveryCodesViewDto> {
    return this.security.viewRecoveryCodes(user);
  }

  @Post('recovery-codes')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Выпустить новые коды восстановления (step-up); старые перестают работать' })
  @ApiOkResponse({ type: RecoveryRegenerateResponseDto })
  regenerateRecoveryCodes(@CurrentUser() user: CurrentUserPayload): Promise<RecoveryRegenerateResponseDto> {
    return this.security.regenerateRecoveryCodes(user);
  }

  /* ---------- сессии ---------- */

  @Get('sessions')
  @ApiOperation({ summary: 'Активные сессии' })
  @ApiOkResponse({ type: SessionsResponseDto })
  sessions(
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
  ): Promise<SessionsResponseDto> {
    return this.security.listSessions(user, session);
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Завершить сессию (не текущую)' })
  @ApiOkResponse({ type: RevokeResultDto })
  revokeSession(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
  ): Promise<RevokeResult> {
    if (!PUBLIC_SESSION_ID.test(id)) throw problem(400, { detail: 'Некорректный идентификатор сессии' });
    return this.security.revokeSession(user, session, id);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({ summary: 'Завершить все сессии, кроме текущей' })
  @ApiOkResponse({ type: RevokeResultDto })
  revokeOthers(
    @CurrentUser() user: CurrentUserPayload,
    @CurrentSession() session: SessionRecord,
  ): Promise<RevokeResult> {
    return this.security.revokeOtherSessions(user, session);
  }

  /* ---------- запомненные устройства ---------- */

  @Get('trusted-devices')
  @ApiOperation({ summary: 'Запомненные устройства («не спрашивать 2FA 30 дней»)' })
  @ApiOkResponse({ type: TrustedDevicesResponseDto })
  trustedDevices(
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TrustedDevicesResponseDto> {
    return this.security.listTrustedDevices(user, this.cookies.read(req, 'trusted'));
  }

  @Delete('trusted-devices/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Забыть устройство' })
  @ApiOkResponse({ type: RevokeResultDto })
  async removeTrustedDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevokeResult> {
    const { revoked, current } = await this.security.removeTrustedDevice(
      user,
      id,
      this.cookies.read(req, 'trusted'),
    );
    if (current) this.cookies.clear(res, 'trusted');
    return { revoked };
  }

  @Post('trusted-devices/clear')
  @HttpCode(200)
  @ApiOperation({ summary: 'Забыть все устройства' })
  @ApiOkResponse({ type: RevokeResultDto })
  async clearTrustedDevices(
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevokeResult> {
    const result = await this.security.clearTrustedDevices(user);
    this.cookies.clear(res, 'trusted');
    return result;
  }

  /* ---------- политика ---------- */

  @Get('policy')
  @ApiOperation({ summary: 'Политика безопасности' })
  @ApiOkResponse({ type: SecurityPolicyDto })
  policy(): Promise<SecurityPolicyDto> {
    return this.security.getPolicy();
  }

  @Put('policy')
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Изменить политику безопасности (step-up)' })
  @ApiOkResponse({ type: SecurityPolicyDto })
  updatePolicy(@Body() body: SecurityPolicyUpdateDto): Promise<SecurityPolicyDto> {
    return this.security.updatePolicy(body);
  }
}

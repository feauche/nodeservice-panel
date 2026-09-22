import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  recoveryCodesViewSchema,
  recoveryRegenerateResponseSchema,
  revokeResultSchema,
  securityOverviewSchema,
  securityPolicySchema,
  securityPolicyUpdateSchema,
  sessionsResponseSchema,
  totpConfirmRequestSchema,
  totpConfirmResponseSchema,
  totpReissueResponseSchema,
  trustedDevicesResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class SecurityOverviewDto extends createZodDto(securityOverviewSchema) {}
export class ChangePasswordRequestDto extends createZodDto(changePasswordRequestSchema) {}
export class ChangePasswordResponseDto extends createZodDto(changePasswordResponseSchema) {}
export class TotpReissueResponseDto extends createZodDto(totpReissueResponseSchema) {}
export class TotpConfirmRequestDto extends createZodDto(totpConfirmRequestSchema) {}
export class TotpConfirmResponseDto extends createZodDto(totpConfirmResponseSchema) {}
export class RecoveryRegenerateResponseDto extends createZodDto(recoveryRegenerateResponseSchema) {}
export class RecoveryCodesViewDto extends createZodDto(recoveryCodesViewSchema) {}
export class SessionsResponseDto extends createZodDto(sessionsResponseSchema) {}
export class TrustedDevicesResponseDto extends createZodDto(trustedDevicesResponseSchema) {}
export class RevokeResultDto extends createZodDto(revokeResultSchema) {}
export class SecurityPolicyDto extends createZodDto(securityPolicySchema) {}
export class SecurityPolicyUpdateDto extends createZodDto(securityPolicyUpdateSchema) {}

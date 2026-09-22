import {
  authStatusSchema,
  csrfResponseSchema,
  loginRequestSchema,
  meSchema,
  recoveryLoginRequestSchema,
  sessionResponseSchema,
  setupConfirmRequestSchema,
  setupConfirmResponseSchema,
  setupStartRequestSchema,
  setupStartResponseSchema,
  totpLoginRequestSchema,
  unlockRequestSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/* ---------- запросы ---------- */
export class SetupStartRequestDto extends createZodDto(setupStartRequestSchema) {}
export class SetupConfirmRequestDto extends createZodDto(setupConfirmRequestSchema) {}
export class LoginRequestDto extends createZodDto(loginRequestSchema) {}
export class TotpLoginRequestDto extends createZodDto(totpLoginRequestSchema) {}
export class RecoveryLoginRequestDto extends createZodDto(recoveryLoginRequestSchema) {}
export class UnlockRequestDto extends createZodDto(unlockRequestSchema) {}

/* ---------- ответы (для OpenAPI) ---------- */
export class AuthStatusDto extends createZodDto(authStatusSchema) {}
export class SetupStartResponseDto extends createZodDto(setupStartResponseSchema) {}
export class SetupConfirmResponseDto extends createZodDto(setupConfirmResponseSchema) {}
/** В OpenAPI union не раскладывается — плоская форма: next + необязательный me. */
export class LoginResponseDto extends createZodDto(
  z.object({ next: z.enum(['totp', 'done']), me: meSchema.optional() }),
) {}
export class SessionResponseDto extends createZodDto(sessionResponseSchema) {}
export class MeDto extends createZodDto(meSchema) {}
export class CsrfTokenDto extends createZodDto(csrfResponseSchema) {}

import {
  createServerRequestSchema,
  enrollmentTokenResponseSchema,
  panelKeyResponseSchema,
  reorderServersRequestSchema,
  serverSchema,
  serversResponseSchema,
  testConnectionRequestSchema,
  testConnectionResponseSchema,
  trustHostKeyRequestSchema,
  updateServerRequestSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class ServerDto extends createZodDto(serverSchema) {}
export class ServersResponseDto extends createZodDto(serversResponseSchema) {}
export class TestConnectionRequestDto extends createZodDto(testConnectionRequestSchema) {}
export class TestConnectionResponseDto extends createZodDto(testConnectionResponseSchema) {}
export class CreateServerRequestDto extends createZodDto(createServerRequestSchema) {}
export class UpdateServerRequestDto extends createZodDto(updateServerRequestSchema) {}
export class TrustHostKeyRequestDto extends createZodDto(trustHostKeyRequestSchema) {}
export class ReorderServersRequestDto extends createZodDto(reorderServersRequestSchema) {}
export class PanelKeyResponseDto extends createZodDto(panelKeyResponseSchema) {}
export class EnrollmentTokenResponseDto extends createZodDto(enrollmentTokenResponseSchema) {}

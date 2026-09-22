import {
  auditEntrySchema,
  auditExportQuerySchema,
  auditListQuerySchema,
  auditListResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class AuditEntryDto extends createZodDto(auditEntrySchema) {}
export class AuditListQueryDto extends createZodDto(auditListQuerySchema) {}
export class AuditListResponseDto extends createZodDto(auditListResponseSchema) {}
export class AuditExportQueryDto extends createZodDto(auditExportQuerySchema) {}

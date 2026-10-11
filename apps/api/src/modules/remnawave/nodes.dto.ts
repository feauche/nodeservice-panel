import { remnawaveConnectRequestSchema, remnawaveStatusSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
export class NodesConnectRequestDto extends createZodDto(remnawaveConnectRequestSchema) {}
export class NodesStatusDto extends createZodDto(remnawaveStatusSchema) {}

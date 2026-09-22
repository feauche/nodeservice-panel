import {
  overviewMetricsResponseSchema,
  serverMetricsQuerySchema,
  serverMetricsResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class ServerMetricsQueryDto extends createZodDto(serverMetricsQuerySchema) {}
export class ServerMetricsResponseDto extends createZodDto(serverMetricsResponseSchema) {}
export class OverviewMetricsResponseDto extends createZodDto(overviewMetricsResponseSchema) {}

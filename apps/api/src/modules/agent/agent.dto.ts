import { agentEnrollRequestSchema, agentEnrollResponseSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class AgentEnrollRequestDto extends createZodDto(agentEnrollRequestSchema) {}
export class AgentEnrollResponseDto extends createZodDto(agentEnrollResponseSchema) {}

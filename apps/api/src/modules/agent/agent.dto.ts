import {
  agentEnrollRequestSchema,
  agentEnrollResponseSchema,
  agentPulseRequestSchema,
  agentPulseResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class AgentEnrollRequestDto extends createZodDto(agentEnrollRequestSchema) {}
export class AgentEnrollResponseDto extends createZodDto(agentEnrollResponseSchema) {}
export class AgentPulseRequestDto extends createZodDto(agentPulseRequestSchema) {}
export class AgentPulseResponseDto extends createZodDto(agentPulseResponseSchema) {}

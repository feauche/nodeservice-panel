import {
  appearanceSettingsSchema,
  appearanceSettingsUpdateSchema,
  assistantSettingsUpdateSchema,
  assistantStatusSchema,
  customSitesSchema,
  incidentsSettingsSchema,
  incidentsSettingsUpdateSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class AppearanceSettingsDto extends createZodDto(appearanceSettingsSchema) {}
export class CustomSitesDto extends createZodDto(customSitesSchema) {}
export class AppearanceSettingsUpdateDto extends createZodDto(appearanceSettingsUpdateSchema) {}
export class IncidentsSettingsDto extends createZodDto(incidentsSettingsSchema) {}
export class IncidentsSettingsUpdateDto extends createZodDto(incidentsSettingsUpdateSchema) {}
export class AssistantStatusDto extends createZodDto(assistantStatusSchema) {}
export class AssistantSettingsUpdateDto extends createZodDto(assistantSettingsUpdateSchema) {}

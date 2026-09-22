import {
  appearanceSettingsSchema,
  appearanceSettingsUpdateSchema,
  assistantSettingsUpdateSchema,
  assistantStatusSchema,
  autochecksSettingsSchema,
  autochecksSettingsUpdateSchema,
  incidentsSettingsSchema,
  incidentsSettingsUpdateSchema,
  terminalSnippetsSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

export class AppearanceSettingsDto extends createZodDto(appearanceSettingsSchema) {}
export class TerminalSnippetsDto extends createZodDto(terminalSnippetsSchema) {}
export class AppearanceSettingsUpdateDto extends createZodDto(appearanceSettingsUpdateSchema) {}
export class AutochecksSettingsDto extends createZodDto(autochecksSettingsSchema) {}
export class AutochecksSettingsUpdateDto extends createZodDto(autochecksSettingsUpdateSchema) {}
export class IncidentsSettingsDto extends createZodDto(incidentsSettingsSchema) {}
export class IncidentsSettingsUpdateDto extends createZodDto(incidentsSettingsUpdateSchema) {}
export class AssistantStatusDto extends createZodDto(assistantStatusSchema) {}
export class AssistantSettingsUpdateDto extends createZodDto(assistantSettingsUpdateSchema) {}

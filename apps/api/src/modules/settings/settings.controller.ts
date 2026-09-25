import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit } from '../audit/audit.decorator.js';
import { Public } from '../auth/auth.decorators.js';
import {
  AppearanceSettingsDto,
  AppearanceSettingsUpdateDto,
  AssistantSettingsUpdateDto,
  AssistantStatusDto,
  AutochecksSettingsDto,
  AutochecksSettingsUpdateDto,
  IncidentsSettingsDto,
  IncidentsSettingsUpdateDto,
  TerminalSnippetsDto,
} from './settings.dto.js';
import { SettingsService } from './settings.service.js';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Логотип нужен ещё до входа (экран входа), поэтому чтение открыто. Секретов здесь нет. */
  @Public()
  @Get('appearance')
  @ApiOperation({ summary: 'Внешний вид: логотип панели' })
  @ApiOkResponse({ type: AppearanceSettingsDto })
  getAppearance(): Promise<AppearanceSettingsDto> {
    return this.settings.getAppearance();
  }

  /** В Журнал попадает diff полей (см. SettingsService.updateAppearance → audit.extend). */
  @Put('appearance')
  @Audit('settings.appearance.updated', {
    target: { type: 'settings', id: 'appearance', display: 'Внешний вид' },
  })
  @ApiOperation({ summary: 'Изменить внешний вид (только администратор)' })
  @ApiOkResponse({ type: AppearanceSettingsDto })
  updateAppearance(@Body() body: AppearanceSettingsUpdateDto): Promise<AppearanceSettingsDto> {
    return this.settings.updateAppearance(body);
  }

  @Get('snippets')
  @ApiOperation({ summary: 'Сниппеты веб-терминала: именованные команды' })
  @ApiOkResponse({ type: TerminalSnippetsDto })
  getSnippets(): Promise<TerminalSnippetsDto> {
    return this.settings.getSnippets();
  }

  @Put('snippets')
  @Audit('settings.snippets.updated', {
    target: { type: 'settings', id: 'snippets', display: 'Сниппеты терминала' },
  })
  @ApiOperation({ summary: 'Заменить список сниппетов терминала' })
  @ApiOkResponse({ type: TerminalSnippetsDto })
  updateSnippets(@Body() body: TerminalSnippetsDto): Promise<TerminalSnippetsDto> {
    return this.settings.updateSnippets(body);
  }

  @Get('autochecks')
  @ApiOperation({ summary: 'Автопроверки: тумблеры и интервалы фоновых проверок' })
  @ApiOkResponse({ type: AutochecksSettingsDto })
  getAutochecks(): Promise<AutochecksSettingsDto> {
    return this.settings.getAutochecks();
  }

  /** «По умолчанию» на фронте — тот же PUT со значениями AUTOCHECKS_DEFAULTS. Diff — в Журнал. */
  @Put('autochecks')
  @Audit('settings.autochecks.updated', {
    target: { type: 'settings', id: 'autochecks', display: 'Автопроверки' },
  })
  @ApiOperation({ summary: 'Изменить автопроверки' })
  @ApiOkResponse({ type: AutochecksSettingsDto })
  updateAutochecks(@Body() body: AutochecksSettingsUpdateDto): Promise<AutochecksSettingsDto> {
    return this.settings.updateAutochecks(body);
  }

  @Get('incidents')
  @ApiOperation({ summary: 'Настройки инцидентов: пороги, время реакции, автопочинка' })
  @ApiOkResponse({ type: IncidentsSettingsDto })
  getIncidents(): Promise<IncidentsSettingsDto> {
    return this.settings.getIncidents();
  }

  @Put('incidents')
  @Audit('settings.incidents.updated', {
    target: { type: 'settings', id: 'incidents', display: 'Инциденты' },
  })
  @ApiOperation({ summary: 'Изменить настройки инцидентов' })
  @ApiOkResponse({ type: IncidentsSettingsDto })
  updateIncidents(@Body() body: IncidentsSettingsUpdateDto): Promise<IncidentsSettingsDto> {
    return this.settings.updateIncidents(body);
  }

  @Get('assistant')
  @ApiOperation({ summary: 'Статус Джарвиса (задан ли ключ, модель)' })
  @ApiOkResponse({ type: AssistantStatusDto })
  getAssistant(): Promise<AssistantStatusDto> {
    return this.settings.getAssistant();
  }

  @Put('assistant')
  @Audit('settings.assistant.updated', {
    target: { type: 'settings', id: 'assistant', display: 'Джарвис' },
  })
  @ApiOperation({ summary: 'Задать/убрать ключ модели и выбрать модель' })
  @ApiOkResponse({ type: AssistantStatusDto })
  updateAssistant(@Body() body: AssistantSettingsUpdateDto): Promise<AssistantStatusDto> {
    return this.settings.updateAssistant(body);
  }
}

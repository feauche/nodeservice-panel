import { pipeline } from 'node:stream';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type BackupInspect,
  type BackupItem,
  type BackupPathCheck,
  type BackupSettings,
  type BackupsResponse,
  backupInspectRequestSchema,
  backupInspectSchema,
  backupItemSchema,
  backupPathCheckRequestSchema,
  backupPathCheckSchema,
  backupRestoreRequestSchema,
  backupRunRequestSchema,
  backupSettingsSchema,
  backupSettingsUpdateSchema,
  backupsResponseSchema,
} from '@nodeservice/shared';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Audit } from '../audit/audit.decorator.js';
import { StepUpGuard } from '../security/step-up.guard.js';
import { BackupsService } from './backups.service.js';

export class BackupsResponseDto extends createZodDto(backupsResponseSchema) {}
export class BackupSettingsDto extends createZodDto(backupSettingsSchema) {}
export class BackupSettingsUpdateDto extends createZodDto(backupSettingsUpdateSchema) {}
export class BackupRunRequestDto extends createZodDto(backupRunRequestSchema) {}
export class BackupRestoreRequestDto extends createZodDto(backupRestoreRequestSchema) {}
export class BackupInspectRequestDto extends createZodDto(backupInspectRequestSchema) {}
export class BackupInspectDto extends createZodDto(backupInspectSchema) {}
export class BackupItemDto extends createZodDto(backupItemSchema) {}
export class BackupPathCheckRequestDto extends createZodDto(backupPathCheckRequestSchema) {}
export class BackupPathCheckDto extends createZodDto(backupPathCheckSchema) {}
export class BackupTestChatDto extends createZodDto(z.object({ url: z.string().max(300).nullable() })) {}

/** «Настройки → Резервные копии». Восстановление и удаление — с повторным подтверждением входа (step-up). */
@ApiTags('backups')
@ApiCookieAuth()
@Controller('backups')
export class BackupsController {
  private readonly log = new Logger(BackupsController.name);

  constructor(private readonly backups: BackupsService) {}

  @Get()
  @ApiOperation({ summary: 'Копии на сервере, идёт ли копия, следующая по расписанию' })
  @ApiOkResponse({ type: BackupsResponseDto })
  list(): Promise<BackupsResponse> {
    return this.backups.list();
  }

  @Get('settings')
  @ApiOkResponse({ type: BackupSettingsDto })
  settings(): Promise<BackupSettings> {
    return this.backups.getSettings();
  }

  @Put('settings')
  @Audit('settings.backups.updated', {
    target: { type: 'settings', id: 'backups', display: 'Резервные копии' },
  })
  @ApiOperation({ summary: 'Расписание, хранение, Telegram, пароль, что входит' })
  @ApiOkResponse({ type: BackupSettingsDto })
  update(@Body() body: BackupSettingsUpdateDto): Promise<BackupSettings> {
    return this.backups.updateSettings(body);
  }

  @Post('run')
  @HttpCode(202)
  @ApiOperation({ summary: 'Сделать копию сейчас (в фоне; ход — в списке)' })
  @ApiAcceptedResponse()
  runNow(@Body() body: BackupRunRequestDto): { ok: true } {
    this.backups.start('manual', {
      ...(body.sendTelegram !== undefined ? { sendTelegram: body.sendTelegram } : {}),
    });
    return { ok: true };
  }

  @Post('check-paths')
  @HttpCode(200)
  @ApiOperation({ summary: 'Проверить дополнительные пути: есть ли, читаются ли, сколько весят' })
  @ApiOkResponse({ type: BackupPathCheckDto })
  checkPaths(@Body() body: BackupPathCheckRequestDto): Promise<BackupPathCheck> {
    return this.backups.checkPaths(body.paths);
  }

  @Post('test-chat')
  @HttpCode(200)
  @ApiOperation({ summary: 'Тестовое сообщение в свой чат для копий' })
  testChat(@Body() body: BackupTestChatDto): Promise<{ ok: boolean; detail: string }> {
    return this.backups.testOwnChat(body.url);
  }

  @Post('upload')
  @HttpCode(201)
  @ApiOperation({ summary: 'Загрузить архив с компьютера (тело — сам файл, до 2 ГБ)' })
  @ApiOkResponse({ type: BackupItemDto })
  upload(@Req() req: Request): Promise<BackupItem> {
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'backup'));
    return this.backups.upload(req, name);
  }

  @Get(':name/download')
  @ApiOperation({ summary: 'Скачать архив копии' })
  async download(@Param('name') name: string, @Res() res: Response): Promise<void> {
    const f = await this.backups.download(name);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    // Сбой чтения посреди отдачи: у потока без обработчика событие 'error' роняло весь процесс, а ответ
    // повисал. Заголовки уже ушли, поэтому ответ обрывается — браузер покажет несостоявшееся скачивание.
    pipeline(f.stream, res, (err) => {
      // Скачивание отменили в браузере — не сбой.
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE')
        this.log.warn(`Копия ${name} отдана не полностью: ${err.message}`);
    });
  }

  @Post(':name/inspect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Что в архиве, от какой версии, можно ли восстановить из панели' })
  @ApiOkResponse({ type: BackupInspectDto })
  inspect(@Param('name') name: string, @Body() body: BackupInspectRequestDto): Promise<BackupInspect> {
    return this.backups.inspect(name, body.password);
  }

  @Post(':name/restore')
  @HttpCode(202)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Восстановить панель из копии (step-up; панель перезапустится)' })
  async restore(@Param('name') name: string, @Body() body: BackupRestoreRequestDto): Promise<{ ok: true }> {
    await this.backups.restore(name, body.password);
    return { ok: true };
  }

  @Delete(':name')
  @HttpCode(204)
  @UseGuards(StepUpGuard)
  @Audit('backup.deleted', { severity: 'warn' })
  @ApiOperation({ summary: 'Удалить копию (step-up)' })
  remove(@Param('name') name: string): Promise<void> {
    return this.backups.remove(name);
  }
}

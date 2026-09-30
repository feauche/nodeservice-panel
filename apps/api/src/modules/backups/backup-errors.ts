import { HttpException } from '@nestjs/common';

import { errorText } from '../../common/filters/problem-details.filter.js';

/**
 * Причины сбоя копий и восстановления. Программы (pg_dump, pg_restore, tar) и сама база отвечают
 * по-английски — этот текст идёт только в лог. Владельцу — частая причина простыми словами и что делать.
 */

/** Сбой с текстом, уже написанным для владельца. raw — исходная причина для лога, если она есть. */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly raw: string | null = null,
  ) {
    super(message);
  }
}

/** На каком шаге сорвалось: от него зависит текст, когда причина не распознана. */
export type BackupStep = 'dump' | 'prepare' | 'restore' | 'swap' | 'pack' | 'files';

/** Сбой программы или базы: её вывод — в лог, владельцу — перевод (explainBackupError). */
export class BackupToolError extends Error {
  /**
   * Связь с базой оборвалась на самом подтверждении подмены, и проверить итог не удалось: утверждать,
   * что текущая база не тронута, в этом случае нельзя.
   */
  outcomeUnknown = false;

  constructor(
    readonly step: BackupStep,
    readonly raw: string,
  ) {
    super(`${step}: ${oneLine(raw)}`);
  }
}

const oneLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');

/**
 * Частые причины: по тексту программы, коду ошибки Node (ENOSPC…) или коду Postgres (55006…). Порядок важен:
 * обрыв связи с базой тоже выглядит как «неожиданный конец» — он проверяется раньше повреждённого архива.
 */
const CAUSES: Array<[RegExp, string]> = [
  [
    /no space left on device|\bENOSPC\b|disk quota exceeded|\bEDQUOT\b|could not extend file|\b53100\b/i,
    'На диске сервера панели закончилось место. Освободите место — например, удалите старые копии — и повторите.',
  ],
  [
    /out of memory|cannot allocate memory|\bENOMEM\b|\b53200\b/i,
    'Серверу панели не хватило оперативной памяти. Повторите позже, когда нагрузка спадёт.',
  ],
  [
    /password authentication failed|\b28P01\b|no pg_hba\.conf entry/i,
    'База данных не приняла пароль панели. Проверьте, не меняли ли пароль базы вручную.',
  ],
  [
    /server version mismatch|unsupported version \([\d.]+\) in file header/i,
    'Инструменты копирования в панели другой версии, чем база данных или эта копия. Обновите панель и повторите.',
  ],
  [
    /is being accessed by other users|\b55006\b/i,
    'База данных занята: панель не смогла закрыть все подключения к ней. Повторите через минуту.',
  ],
  [
    /could not connect to server|connection to server .*failed|connection refused|\bECONNREFUSED\b|\bECONNRESET\b|could not translate host name|\bENOTFOUND\b|\bEAI_AGAIN\b|timeout expired|\bETIMEDOUT\b|the database system is (starting up|shutting down|in recovery mode)|server closed the connection unexpectedly|terminating connection|connection terminated|\b57P0[123]\b|too many clients|\b53300\b/i,
    'Нет связи с базой данных панели: она не отвечает, перегружена или перезапускается. Повторите через несколько минут.',
  ],
  [
    /does not appear to be a valid archive|input file is too short|unexpected end of file|unexpected EOF|not in gzip format|invalid compressed data|error is not recoverable|could not read from input file|bad decrypt/i,
    'Архив повреждён или это не копия панели: прочитать его не получилось.',
  ],
  [
    /permission denied|\bEACCES\b|\bEPERM\b|operation not permitted|read-only file system|\bEROFS\b/i,
    'Панели не хватило прав на файл или папку на сервере. Если дело в папке копий — обновите панель с сервера: обновление выдаёт права заново.',
  ],
];

const UNKNOWN: Record<BackupStep, string> = {
  dump: 'Не удалось выгрузить базу данных.',
  prepare: 'Не удалось подготовить временную базу для восстановления.',
  restore: 'База из копии не развернулась. Возможно, копия повреждена или сделана другой версией панели.',
  swap: 'Не удалось подменить базу данных восстановленной.',
  pack: 'Не удалось собрать архив.',
  files: 'Не удалось упаковать дополнительные файлы и папки.',
};

/** Исходный текст ошибки одной строкой — для лога. */
export function rawErrorText(err: unknown): string {
  if (err instanceof BackupToolError) return err.message;
  if (err instanceof BackupError) return err.raw ? `${err.message} (${oneLine(err.raw)})` : err.message;
  if (err instanceof HttpException) return errorText(err);
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return `${typeof code === 'string' ? `${code} ` : ''}${oneLine(err.message)}`;
  }
  return String(err);
}

/**
 * Что показать владельцу: свой текст панели — как есть, сбой программы или системы — переводом.
 * unknown — что сказать, когда причина не распознана и шаг неизвестен.
 */
export function explainBackupError(err: unknown, unknown = 'Причина не распознана.'): string {
  if (err instanceof BackupError) return err.message;
  if (err instanceof HttpException) return errorText(err);
  const raw = rawErrorText(err);
  for (const [re, text] of CAUSES) if (re.test(raw)) return text;
  const what = err instanceof BackupToolError ? UNKNOWN[err.step] : unknown;
  return `${what} Подробности — в логах панели.`;
}

import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { problem } from '../../common/filters/problem-details.filter.js';
import { BackupError, BackupToolError, explainBackupError, rawErrorText } from './backup-errors.js';

/** Как у настоящих ошибок Node и Postgres: английский текст и код. */
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
const RU_ONLY = /^[^A-Za-z]*$/;

describe('причина сбоя копии и восстановления — по-русски', () => {
  it('кончилось место на диске', () => {
    const err = new BackupToolError(
      'dump',
      'pg_dump: error: could not write to output file: No space left on device',
    );
    expect(explainBackupError(err)).toContain('закончилось место');
    expect(explainBackupError(coded('ENOSPC: no space left on device, write', 'ENOSPC'))).toContain(
      'закончилось место',
    );
    expect(explainBackupError(coded('could not extend file "base/16384/2619"', '53100'))).toContain(
      'закончилось место',
    );
  });

  it('нет доступа к файлу или папке', () => {
    const text = explainBackupError(
      coded("EACCES: permission denied, rename '/app/backups/a.part' -> '/app/backups/a'", 'EACCES'),
    );
    expect(text).toContain('не хватило прав');
    expect(
      explainBackupError(new BackupToolError('files', 'tar: /host/root: Cannot open: Permission denied')),
    ).toBe(text);
  });

  it('нет связи с базой: важная строка стоит не последней', () => {
    const err = new BackupToolError(
      'dump',
      [
        'pg_dump: error: connection to server at "postgres" (172.18.0.3), port 5432 failed: Connection refused',
        '\tIs the server running on that host and accepting TCP/IP connections?',
      ].join('\n'),
    );
    expect(explainBackupError(err)).toContain('Нет связи с базой данных');
    expect(
      explainBackupError(coded('terminating connection due to administrator command', '57P01')),
    ).toContain('Нет связи с базой данных');
    expect(explainBackupError(coded('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'))).toContain(
      'Нет связи с базой данных',
    );
  });

  it('другая версия инструментов', () => {
    expect(
      explainBackupError(
        new BackupToolError('dump', 'pg_dump: error: aborting because of server version mismatch'),
      ),
    ).toContain('другой версии');
    expect(
      explainBackupError(
        new BackupToolError('restore', 'pg_restore: error: unsupported version (1.16) in file header'),
      ),
    ).toContain('другой версии');
  });

  it('база занята', () => {
    const text = explainBackupError(
      coded('database "nodeservice" is being accessed by other users', '55006'),
    );
    expect(text).toContain('База данных занята');
    expect(text).not.toContain('nodeservice');
  });

  it('обрыв связи посреди выгрузки — это «нет связи с базой», а не «архив повреждён»', () => {
    const err = new BackupToolError(
      'dump',
      [
        'pg_dump: error: Dumping the contents of table "audit_log" failed: PQgetCopyData() failed.',
        'pg_dump: detail: Error message from server: server closed the connection unexpectedly',
        '\tThis probably means the server terminated abnormally before or while processing the request.',
        'pg_dump: detail: Command was: COPY public.audit_log (id, seq) TO stdout;',
        'unexpected EOF on client connection with an open transaction',
      ].join('\n'),
    );
    expect(explainBackupError(err)).toContain('Нет связи с базой данных');
  });

  it('архив повреждён', () => {
    expect(
      explainBackupError(
        new BackupToolError('restore', 'pg_restore: error: input file does not appear to be a valid archive'),
      ),
    ).toContain('повреждён');
    expect(
      explainBackupError(
        new BackupToolError(
          'pack',
          'gzip: stdin: unexpected end of file\ntar: Error is not recoverable: exiting now',
        ),
      ),
    ).toContain('повреждён');
  });

  it('не хватило памяти', () => {
    expect(explainBackupError(new BackupToolError('dump', 'pg_dump: error: out of memory'))).toContain(
      'памяти',
    );
  });

  it('причина не распознана — общий русский текст по инструменту, без сырого текста', () => {
    const dump = explainBackupError(new BackupToolError('dump', 'pg_dump: error: something odd happened'));
    expect(dump).toContain('Не удалось выгрузить базу данных');
    expect(dump).toContain('в логах панели');
    const restore = explainBackupError(
      new BackupToolError('restore', 'pg_restore: error: could not execute query: ERROR: boom'),
    );
    expect(restore).toContain('не развернулась');
    expect(explainBackupError(new Error('Unexpected token < in JSON'))).toContain('в логах панели');
    expect(explainBackupError('строка вместо ошибки')).toContain('в логах панели');
  });

  it('ни один текст для владельца не содержит английских слов', () => {
    const samples: unknown[] = [
      new BackupToolError('dump', 'pg_dump: error: could not write to output file: No space left on device'),
      new BackupToolError('dump', 'pg_dump: error: connection to server failed: Connection refused'),
      new BackupToolError('dump', 'pg_dump: error: password authentication failed for user "nodeservice"'),
      new BackupToolError('dump', 'pg_dump: error: aborting because of server version mismatch'),
      new BackupToolError('restore', 'pg_restore: error: unsupported version (1.16) in file header'),
      new BackupToolError('restore', 'pg_restore: error: input file is too short (read 0, expected 5)'),
      new BackupToolError('restore', 'pg_restore: error: could not execute query: ERROR: boom'),
      new BackupToolError('pack', 'tar: Exiting with failure status due to previous errors'),
      new BackupToolError('swap', 'database "nodeservice" is being accessed by other users'),
      new BackupToolError('dump', 'pg_dump: error: out of memory'),
      coded('EACCES: permission denied, open', 'EACCES'),
      new Error('Totally unknown failure'),
    ];
    for (const s of samples) expect(explainBackupError(s)).toMatch(RU_ONLY);
  });

  it('свой текст панели проходит как есть', () => {
    expect(explainBackupError(new BackupError('Дамп базы не читается — копия не сохранена.'))).toBe(
      'Дамп базы не читается — копия не сохранена.',
    );
    expect(
      explainBackupError(
        problem(HttpStatus.BAD_REQUEST, { detail: 'Архив не распаковывается — файл повреждён.' }),
      ),
    ).toBe('Архив не распаковывается — файл повреждён.');
  });

  it('сырой текст — для лога: инструмент и всё, что он написал', () => {
    const err = new BackupToolError('dump', 'line one\nline two');
    expect(rawErrorText(err)).toBe('dump: line one | line two');
    expect(rawErrorText(coded('boom', 'EIO'))).toBe('EIO boom');
    expect(rawErrorText(new BackupError('Текст для владельца', 'raw cause'))).toBe(
      'Текст для владельца (raw cause)',
    );
  });
});

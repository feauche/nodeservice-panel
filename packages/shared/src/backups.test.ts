import { describe, expect, it } from 'vitest';

import {
  BACKUP_PROBLEM,
  backupInspectSchema,
  backupPathCheckRequestSchema,
  backupSettingsUpdateSchema,
} from './backups.js';

describe('дополнительные пути копии', () => {
  const ok = (p: string) => backupPathCheckRequestSchema.safeParse({ paths: [p] }).success;

  it('обычный путь от корня проходит', () => {
    expect(ok('/etc/nginx')).toBe(true);
    expect(ok('/root/scripts/remnanode-installer')).toBe(true);
    expect(ok('/opt/my-app/config.d')).toBe(true);
  });

  it('часть пути с «-» в начале не проходит: программа упаковки приняла бы её за свой параметр', () => {
    expect(ok('/--checkpoint=1')).toBe(false);
    expect(ok('/--checkpoint-action=exec=sh -c "id"')).toBe(false);
    expect(ok('/-T')).toBe(false);
    expect(ok('/etc/-rf')).toBe(false);
    expect(
      backupSettingsUpdateSchema.safeParse({
        extra: { enabled: true, paths: ['/--use-compress-program=sh'] },
      }).success,
    ).toBe(false);
  });

  it('путь без корня и с «..» не проходит, как раньше', () => {
    expect(ok('etc')).toBe(false);
    expect(ok('/etc/../root')).toBe(false);
  });
});

describe('настройки копий: свой чат', () => {
  const telegram = { enabled: true, target: 'own' as const, destinationId: null, notifyFailure: true };

  it('свой чат можно не передавать — это значит «не менять»', () => {
    const r = backupSettingsUpdateSchema.safeParse({ keep: 10, telegram });
    expect(r.success).toBe(true);
    expect(r.success && r.data.telegram?.ownUrl).toBeUndefined();
  });

  it('null — убрать, строка — заменить', () => {
    expect(
      backupSettingsUpdateSchema.parse({ telegram: { ...telegram, ownUrl: null } }).telegram?.ownUrl,
    ).toBe(null);
    expect(
      backupSettingsUpdateSchema.parse({ telegram: { ...telegram, ownUrl: ' tgram://1/2 ' } }).telegram
        ?.ownUrl,
    ).toBe('tgram://1/2');
  });
});

describe('ошибки и проверка копии', () => {
  it('у неудачного восстановления и у нечитаемого файла — свои типы ошибок', () => {
    expect(BACKUP_PROBLEM.restoreFailed).toBe('urn:nodeservice:problem:backup-restore-failed');
    expect(BACKUP_PROBLEM.unreadable).toBe('urn:nodeservice:problem:backup-unreadable');
  });

  it('проверка архива несёт предупреждение; ответ без него (прежний сервер) тоже разбирается', () => {
    const base = {
      name: 'nodeservice-backup-20260929-040007.tar.gz',
      createdAt: null,
      version: null,
      domain: null,
      encrypted: false,
      needsPassword: false,
      contents: { dbBytes: 10, env: false, metrics: false, paths: 0 },
      sameKeys: null,
      compatible: true,
      problem: null,
    };
    expect(backupInspectSchema.parse(base).warning).toBeUndefined();
    expect(backupInspectSchema.parse({ ...base, warning: 'Ключей в этой копии нет.' }).warning).toBe(
      'Ключей в этой копии нет.',
    );
  });
});

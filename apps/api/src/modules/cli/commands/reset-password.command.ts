import { readFile } from 'node:fs/promises';
import { passwordSchema } from '@nodeservice/shared';
import { Command, CommandRunner, Option } from 'nest-commander';

import { CryptoService } from '../../../common/crypto/crypto.service.js';
import type { AuditActor } from '../../audit/audit.context.js';
import { AuditService } from '../../audit/audit.service.js';
import { SessionStore } from '../../auth/session.store.js';
import { UsersRepository } from '../../auth/users.repository.js';
import { promptHidden } from '../prompt.js';

/** Команды rescue-CLI идут не от сессии, а от оператора у консоли — так и пишем в Журнал. */
const CLI_ACTOR: AuditActor = { type: 'system', id: null, display: 'rescue-CLI' };

interface Options {
  passwordFile?: string;
}

/**
 * Пароль не принимается аргументом командной строки (виден в `ps`, истории shell и логах docker):
 * либо интерактивный ввод, либо файл (`--password-file`, первая строка), либо stdin через пайп.
 */
@Command({
  name: 'reset-password',
  arguments: '<login>',
  description: 'Сменить пароль администратора (все его сессии завершаются)',
})
export class ResetPasswordCommand extends CommandRunner {
  constructor(
    private readonly users: UsersRepository,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionStore,
    private readonly audit: AuditService,
  ) {
    super();
  }

  @Option({
    flags: '--password-file <path>',
    description:
      'Файл с новым паролем (первая строка). Иначе пароль спрашивается в терминале или читается из stdin',
  })
  parsePasswordFile(value: string): string {
    return value;
  }

  async run([login]: string[], options: Options = {}): Promise<void> {
    if (!login) throw new Error('Укажи логин: reset-password <login>');
    const user = await this.users.findByLogin(login);
    if (!user) throw new Error(`Пользователь «${login}» не найден`);

    const interactive = options.passwordFile === undefined && (process.stdin.isTTY ?? false);
    const raw =
      options.passwordFile !== undefined
        ? await readPasswordFile(options.passwordFile)
        : await promptHidden('Новый пароль: ');
    const parsed = passwordSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
    if (interactive) {
      const again = await promptHidden('Ещё раз: ');
      if (again !== raw) throw new Error('Пароли не совпадают');
    }

    await this.users.setPassword(user.id, await this.crypto.hashPassword(parsed.data));
    const revoked = await this.sessions.destroyAllForUser(user.id);
    await this.audit.record({
      action: 'security.cli.password_reset',
      actor: CLI_ACTOR,
      source: 'manual',
      severity: 'warn',
      target: { type: 'user', id: user.id, display: user.login },
      metadata: { sessionsRevoked: revoked },
    });
    console.log(`Пароль для «${user.login}» обновлён. Сессий завершено: ${revoked}.`);
  }
}

async function readPasswordFile(path: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать файл с паролем: ${path}`);
  }
  const [first = ''] = content.split(/\r?\n/);
  if (!first) throw new Error(`Файл ${path} пуст — пароль ожидается в первой строке`);
  return first;
}

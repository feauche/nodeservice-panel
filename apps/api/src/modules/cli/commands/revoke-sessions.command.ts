import { Command, CommandRunner } from 'nest-commander';

import type { AuditActor } from '../../audit/audit.context.js';
import { AuditService } from '../../audit/audit.service.js';
import { SessionStore } from '../../auth/session.store.js';
import { UsersRepository } from '../../auth/users.repository.js';

/** Команды rescue-CLI идут не от сессии, а от оператора у консоли — так и пишем в Журнал. */
const CLI_ACTOR: AuditActor = { type: 'system', id: null, display: 'rescue-CLI' };

@Command({
  name: 'revoke-sessions',
  arguments: '[login]',
  description: 'Завершить все сессии пользователя (без логина — всех пользователей)',
})
export class RevokeSessionsCommand extends CommandRunner {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionStore,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async run([login]: string[]): Promise<void> {
    const targets = login ? [await this.users.findByLogin(login)] : await this.users.listUsers();
    let total = 0;
    for (const user of targets) {
      if (!user) throw new Error(`Пользователь «${login}» не найден`);
      const n = await this.sessions.destroyAllForUser(user.id);
      total += n;
      console.log(`${user.login}: сессий завершено ${n}`);
    }
    await this.audit.record({
      action: 'security.cli.sessions_revoked',
      actor: CLI_ACTOR,
      source: 'manual',
      severity: 'warn',
      ...(login ? { target: { type: 'user', display: login } } : {}),
      metadata: { sessionsRevoked: total, scope: login ? 'user' : 'all' },
    });
    console.log(`Итого: ${total}`);
  }
}

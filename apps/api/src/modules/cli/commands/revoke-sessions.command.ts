import { Command, CommandRunner } from 'nest-commander';

import { SessionStore } from '../../auth/session.store.js';
import { UsersRepository } from '../../auth/users.repository.js';

@Command({
  name: 'revoke-sessions',
  arguments: '[login]',
  description: 'Завершить все сессии пользователя (без логина — всех пользователей)',
})
export class RevokeSessionsCommand extends CommandRunner {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionStore,
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
    console.log(`Итого: ${total}`);
  }
}

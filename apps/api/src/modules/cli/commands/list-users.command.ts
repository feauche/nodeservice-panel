import { Command, CommandRunner } from 'nest-commander';

import { SessionStore } from '../../auth/session.store.js';
import { UsersRepository } from '../../auth/users.repository.js';

@Command({ name: 'list-users', description: 'Список пользователей: логин, 2FA, коды, сессии' })
export class ListUsersCommand extends CommandRunner {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionStore,
  ) {
    super();
  }

  async run(): Promise<void> {
    const rows = await this.users.listUsers();
    if (rows.length === 0) {
      console.log('Пользователей нет — панель ждёт первого запуска (setup-token).');
      return;
    }
    const table = [];
    for (const u of rows) {
      table.push({
        login: u.login,
        id: u.id,
        '2fa': u.totpConfirmedAt ? 'да' : u.totpSecretEnc ? 'не подтверждена' : 'нет',
        'коды восст.': await this.users.countUnusedRecoveryCodes(u.id),
        сессий: (await this.sessions.listForUser(u.id)).length,
        создан: u.createdAt.toISOString(),
      });
    }
    console.table(table);
  }
}

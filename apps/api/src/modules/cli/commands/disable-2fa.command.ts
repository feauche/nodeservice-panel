import { Command, CommandRunner } from 'nest-commander';

import { SessionStore } from '../../auth/session.store.js';
import { TotpService } from '../../auth/totp.service.js';
import { UsersRepository } from '../../auth/users.repository.js';

@Command({
  name: 'disable-2fa',
  arguments: '<login>',
  description: 'Отключить TOTP (удаляются секрет, коды восстановления, доверенные устройства и сессии)',
})
export class DisableTwoFactorCommand extends CommandRunner {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionStore,
    private readonly totp: TotpService,
  ) {
    super();
  }

  async run([login]: string[]): Promise<void> {
    if (!login) throw new Error('Укажи логин: disable-2fa <login>');
    const user = await this.users.findByLogin(login);
    if (!user) throw new Error(`Пользователь «${login}» не найден`);
    await this.users.disableTotp(user.id);
    await this.users.replaceRecoveryCodes(user.id, []);
    await this.users.deleteTrustedDevices(user.id);
    await this.totp.forget(user.id);
    const revoked = await this.sessions.destroyAllForUser(user.id);
    console.log(
      `2FA для «${user.login}» отключена, сессий завершено: ${revoked}. Войди по паролю и настрой 2FA заново в разделе «Безопасность».`,
    );
  }
}

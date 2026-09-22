import { Command, CommandRunner } from 'nest-commander';

import type { AuditActor } from '../../audit/audit.context.js';
import { AuditService } from '../../audit/audit.service.js';
import { SessionStore } from '../../auth/session.store.js';
import { TotpService } from '../../auth/totp.service.js';
import { UsersRepository } from '../../auth/users.repository.js';

/** Команды rescue-CLI идут не от сессии, а от оператора у консоли — так и пишем в Журнал. */
const CLI_ACTOR: AuditActor = { type: 'system', id: null, display: 'rescue-CLI' };

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
    private readonly audit: AuditService,
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
    await this.audit.record({
      action: 'security.cli.totp_disabled',
      actor: CLI_ACTOR,
      source: 'manual',
      severity: 'warn',
      target: { type: 'user', id: user.id, display: user.login },
      metadata: { sessionsRevoked: revoked },
    });
    console.log(
      `2FA для «${user.login}» отключена, сессий завершено: ${revoked}. Войди по паролю и настрой 2FA заново в разделе «Безопасность».`,
    );
  }
}

import { Command, CommandRunner } from 'nest-commander';

import type { AuditActor } from '../../audit/audit.context.js';
import { AuditService } from '../../audit/audit.service.js';
import { SetupService } from '../../auth/setup.service.js';

/** Команды rescue-CLI идут не от сессии, а от оператора у консоли — так и пишем в Журнал. */
const CLI_ACTOR: AuditActor = { type: 'system', id: null, display: 'rescue-CLI' };

@Command({
  name: 'setup-token',
  description: 'Выпустить новый токен первого запуска (старый перестаёт работать)',
})
export class SetupTokenCommand extends CommandRunner {
  constructor(
    private readonly setup: SetupService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async run(): Promise<void> {
    if (!(await this.setup.isSetupRequired())) {
      console.error(
        'Администратор уже создан — токен первого запуска не нужен. Для сброса пароля: reset-password.',
      );
      process.exitCode = 1;
      return;
    }
    const token = await this.setup.issueToken();
    await this.audit.record({ action: 'auth.setup_token.issued', actor: CLI_ACTOR, source: 'manual' });
    console.log(`Открой ${this.setup.setupUrl} и введи токен:\n\n    ${token}\n`);
  }
}

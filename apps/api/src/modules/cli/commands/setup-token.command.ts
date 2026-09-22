import { Command, CommandRunner } from 'nest-commander';

import { SetupService } from '../../auth/setup.service.js';

@Command({
  name: 'setup-token',
  description: 'Выпустить новый токен первого запуска (старый перестаёт работать)',
})
export class SetupTokenCommand extends CommandRunner {
  constructor(private readonly setup: SetupService) {
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
    console.log(`Открой ${this.setup.setupUrl} и введи токен:\n\n    ${token}\n`);
  }
}

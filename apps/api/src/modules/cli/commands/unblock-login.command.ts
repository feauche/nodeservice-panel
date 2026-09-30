import { Command, CommandRunner } from 'nest-commander';

import type { AuditActor } from '../../audit/audit.context.js';
import { AuditService } from '../../audit/audit.service.js';
import { ThrottleService } from '../../auth/throttle.service.js';

/** Команды rescue-CLI идут не от сессии, а от оператора у консоли — так и пишем в Журнал. */
const CLI_ACTOR: AuditActor = { type: 'system', id: null, display: 'rescue-CLI' };

/**
 * Аварийный выход, когда панель не пускает владельца из-за паузы после неудачных попыток (своих или
 * чужих). Снимается всё разом: у консоли не узнать, с какого адреса владелец сейчас войдёт.
 */
@Command({
  name: 'unblock-login',
  description: 'Снять паузы входа после неудачных попыток (по всем адресам и логинам)',
})
export class UnblockLoginCommand extends CommandRunner {
  constructor(
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const { pauses, codeEntryReopened } = await this.throttle.clearAll();
    await this.audit.record({
      action: 'security.cli.login_unblocked',
      actor: CLI_ACTOR,
      source: 'manual',
      severity: 'warn',
      metadata: { note: `Снято пауз: ${pauses}` },
    });
    if (pauses === 0 && codeEntryReopened === 0) {
      console.log('Пауз входа сейчас нет — снимать нечего. Счётчики неудачных попыток обнулены.');
      return;
    }
    console.log(
      `Паузы входа сняты: ${pauses}.${codeEntryReopened > 0 ? ' Вход по коду из приложения снова открыт.' : ''} Можно входить.`,
    );
  }
}

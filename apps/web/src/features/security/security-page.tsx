import { ShieldIcon } from 'lucide-react';
import { SectionHeader } from '@/features/settings/settings-ui';
import { PasswordCard } from './password-card';
import { PolicyCard } from './policy-card';
import { RecoveryCard } from './recovery-card';
import { DevicesCard, SessionsCard } from './sessions-card';
import { TotpCard } from './totp-card';

/**
 * Настройки → Безопасность: одна колонка в общем стиле настроек (витрина `settings-unified-variants.html`,
 * вариант A). Сверху способ входа (пароль, 2FA, коды), ниже — где вошли, в конце политика с единственной
 * кнопкой «Сохранить». Действия с сессиями и устройствами применяются сразу, кнопками в строках.
 * Блокировка экрана и выход живут в меню аватара — здесь не дублируем.
 */
export function SecurityPage() {
  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        icon={ShieldIcon}
        title="Безопасность"
        description="Пароль, вход по коду и где вы сейчас вошли. Действия с сессиями и устройствами применяются сразу."
      />
      <PasswordCard />
      <TotpCard />
      <RecoveryCard />
      <SessionsCard />
      <DevicesCard />
      <PolicyCard />
    </div>
  );
}

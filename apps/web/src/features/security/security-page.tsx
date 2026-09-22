import { PasswordCard } from './password-card';
import { PolicyCard } from './policy-card';
import { DevicesCard, SessionsCard } from './sessions-card';
import { TotpCard } from './totp-card';

/**
 * Настройки → Безопасность (требование 23.8): две колонки.
 * Слева — то, что меняет способ входа (пароль и 2FA с кодами восстановления внутри — это одно целое);
 * справа — где вошли и политика.
 * Блокировка экрана и выход живут в меню аватара — здесь не дублируем.
 */
export function SecurityPage() {
  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <PasswordCard />
          <TotpCard />
        </div>
        <div className="flex flex-col gap-4">
          <SessionsCard />
          <DevicesCard />
          <PolicyCard />
        </div>
      </div>
    </>
  );
}

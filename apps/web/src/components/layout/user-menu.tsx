import { useNavigate } from '@tanstack/react-router';
import { LockIcon, LogOutIcon, MonitorSmartphoneIcon, ShieldIcon } from 'lucide-react';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LogoutDialog } from '@/features/auth/components/logout-dialog';
import { useLockScreen } from '@/features/auth/queries';
import { initialsOf, useAuthStore } from '@/features/auth/store';
import { useSecurityOverview, useSessions } from '@/features/security/security-api';
import { formatIn, loginMethod } from '@/features/security/security-format';
import { isSectionOpen, LOCKED_HINT } from '@/lib/stages';
import { cn } from '@/lib/utils';

export function Avatar({ login, className }: { login: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-9 flex-none place-items-center rounded-[10px] bg-[linear-gradient(150deg,var(--ns-accent),var(--ns-teal))] font-heading text-[13px] font-bold text-(--ns-on-accent)',
        className,
      )}
    >
      {initialsOf(login)}
    </span>
  );
}

const ITEM =
  'gap-2.5 rounded-[9px] px-2.5 py-[9px] text-[13px] text-text-2 focus:bg-surface-2 focus:text-foreground [&_svg]:size-4';
const GROUP = 'px-2.5 pt-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.1em] text-text-3 uppercase';

/**
 * Меню аватара: кто вошёл и как, когда истечёт сессия и сколько устройств запомнено,
 * затем действия по группам «Аккаунт» и «Сессия». Закрытые разделы показаны с замком.
 */
export function UserMenu() {
  const me = useAuthStore((s) => s.me);
  const navigate = useNavigate();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const security = useSecurityOverview();
  const sessions = useSessions();
  const current = sessions.data?.items.find((s) => s.current);
  const settingsOpen = isSectionOpen('/settings');

  const lockScreen = useLockScreen();
  const doLock = () => {
    void lockScreen();
    void navigate({ to: '/lock' });
  };

  const lockedItem = (label: string, Icon: typeof ShieldIcon) => (
    <DropdownMenuItem disabled title={LOCKED_HINT} className={cn(ITEM, 'text-text-3')}>
      <Icon aria-hidden="true" />
      <span className="flex-1">{label}</span>
      <LockIcon className="size-[13px]! opacity-70" aria-hidden="true" />
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title="Учётная запись"
          aria-label="Учётная запись"
          className="flex size-9 flex-none cursor-pointer items-center justify-center rounded-[10px] transition-[filter,transform] hover:brightness-[1.08] focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2"
        >
          <Avatar login={me?.login} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-[300px] rounded-[14px] border border-border-2 p-1.5 shadow-float"
        >
          <div className="flex items-center gap-[11px] px-2.5 pt-2 pb-2.5">
            <Avatar login={me?.login} />
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold">{me?.login ?? '—'}</div>
              <div className="truncate text-[11px] text-text-3">Администратор · {loginMethod(me?.amr)}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-1 pb-1.5">
            <div className="rounded-[9px] bg-surface-2 px-2.5 py-2">
              <div className="text-[10.5px] text-text-3">Сессия истечёт</div>
              <div className="mt-px text-[12.5px] font-semibold tabular-nums">
                {current ? formatIn(current.expiresAt) : '—'}
              </div>
            </div>
            <div className="rounded-[9px] bg-surface-2 px-2.5 py-2">
              <div className="text-[10.5px] text-text-3">Устройств запомнено</div>
              <div className="mt-px text-[12.5px] font-semibold tabular-nums">
                {security.data?.trustedDevicesCount ?? '—'}
              </div>
            </div>
          </div>
          <DropdownMenuSeparator className="my-1" />
          <DropdownMenuLabel className={GROUP}>Аккаунт</DropdownMenuLabel>
          {settingsOpen ? (
            <>
              <DropdownMenuItem onSelect={() => void navigate({ to: '/settings/security' })} className={ITEM}>
                <ShieldIcon aria-hidden="true" />
                Безопасность и сессии
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void navigate({ to: '/settings/security' })} className={ITEM}>
                <MonitorSmartphoneIcon aria-hidden="true" />
                Запомненные устройства
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {lockedItem('Безопасность и сессии', ShieldIcon)}
              {lockedItem('Запомненные устройства', MonitorSmartphoneIcon)}
            </>
          )}
          <DropdownMenuLabel className={GROUP}>Сессия</DropdownMenuLabel>
          <DropdownMenuItem onSelect={doLock} className={ITEM}>
            <LockIcon aria-hidden="true" />
            Заблокировать экран
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setLogoutOpen(true)}
            className={cn(ITEM, 'text-crit focus:bg-crit-soft focus:text-crit dark:focus:bg-crit-soft')}
          >
            <LogOutIcon aria-hidden="true" />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  );
}

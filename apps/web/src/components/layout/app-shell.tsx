import { Link, useNavigate } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  BookOpenIcon,
  ChevronLeftIcon,
  LayoutGridIcon,
  ListIcon,
  LockIcon,
  LogOutIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { BrandLogo, BrandName } from '@/components/brand-logo';
import { ThemeMenu } from '@/components/theme-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LogoutDialog } from '@/features/auth/components/logout-dialog';
import { useLockScreen } from '@/features/auth/queries';
import { initialsOf, useAuthStore } from '@/features/auth/store';
import { useOpenIncidentsCount } from '@/features/incidents/incidents-api';
import { useSecurityOverview } from '@/features/security/security-api';
import { StepUpHost } from '@/features/security/step-up-host';
import { useIdleLock } from '@/features/security/use-idle-lock';
import { TerminalHost } from '@/features/terminal/terminal-host';
import { isSectionOpen, LOCKED_HINT } from '@/lib/stages';
import { cn } from '@/lib/utils';

const RAIL_KEY = 'ns-rail';

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

/* ---------- навигация ---------- */
const NAV = [
  { to: '/', label: 'Обзор', icon: LayoutGridIcon },
  { to: '/servers', label: 'Серверы', icon: ServerIcon },
  { to: '/incidents', label: 'Инциденты', icon: AlertTriangleIcon },
  { to: '/settings', label: 'Настройки', icon: SettingsIcon },
] as const;
/** Раздел «Автоматизация» — AI-ассистент и база знаний. */
const NAV_AUTOMATION = [
  { to: '/assistant', label: 'Ассистент', icon: SparklesIcon },
  { to: '/knowledge', label: 'База знаний', icon: BookOpenIcon },
] as const;
/** Нижняя группа меню — служебное: Журнал внизу, рядом с «Свернуть меню». */
const NAV_BOTTOM = [{ to: '/audit', label: 'Журнал', icon: ListIcon }] as const;

type NavEntry = (typeof NAV)[number] | (typeof NAV_AUTOMATION)[number] | (typeof NAV_BOTTOM)[number];

function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  badge,
}: NavEntry & { collapsed: boolean; badge?: number }) {
  // Раздел ещё не открыт на своём этапе: в меню остаётся, но с замком и без перехода.
  if (!isSectionOpen(to)) {
    return (
      <button
        type="button"
        disabled
        title={collapsed ? `${label} — ${LOCKED_HINT}` : LOCKED_HINT}
        className={cn(
          'relative flex w-full cursor-not-allowed items-center gap-[11px] rounded-[10px] px-3 py-[9px] text-left text-[13.5px] font-medium text-text-3 select-none max-md:justify-center max-md:px-0',
          collapsed && 'justify-center px-0',
        )}
      >
        <Icon className="size-[17px] flex-none opacity-55" aria-hidden="true" />
        <span className={cn('flex-1 opacity-55 max-md:sr-only', collapsed && 'sr-only')}>{label}</span>
        <LockIcon
          className={cn(
            'size-[13px] flex-none opacity-70 max-md:absolute max-md:top-1 max-md:right-1.5 max-md:size-[11px]',
            collapsed && 'absolute top-1 right-1.5 size-[11px]',
          )}
          aria-hidden="true"
        />
      </button>
    );
  }
  return (
    <Link
      to={to}
      title={collapsed ? label : undefined}
      className={cn(
        'relative flex items-center gap-[11px] rounded-[10px] px-3 py-[9px] text-[13.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground',
        'data-[status=active]:bg-brand-soft data-[status=active]:text-brand',
        'data-[status=active]:before:absolute data-[status=active]:before:top-[9px] data-[status=active]:before:bottom-[9px] data-[status=active]:before:-left-3 data-[status=active]:before:w-[3px] data-[status=active]:before:rounded-r-[3px] data-[status=active]:before:bg-brand data-[status=active]:before:content-[""]',
        'max-md:justify-center max-md:px-0 max-md:data-[status=active]:before:-left-2.5',
        collapsed && 'justify-center px-0 data-[status=active]:before:-left-2.5',
      )}
      activeOptions={{ exact: to === '/' }}
    >
      <Icon className="size-[17px] flex-none" aria-hidden="true" />
      <span className={cn('flex-1 max-md:sr-only', collapsed && 'sr-only')}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'inline-flex min-w-[18px] justify-center rounded-full bg-crit px-1.5 py-[1px] text-[10.5px] font-bold text-white tabular-nums',
            'max-md:absolute max-md:top-1 max-md:right-1 max-md:min-w-[15px] max-md:px-1 max-md:leading-[15px] max-md:shadow-[0_0_0_2px_var(--ns-surface)]',
            collapsed &&
              'absolute top-1 right-1 min-w-[15px] px-1 leading-[15px] shadow-[0_0_0_2px_var(--ns-surface)]',
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

/* ---------- меню пользователя ---------- */
function Avatar({ login, className }: { login: string | undefined; className?: string }) {
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

function UserMenu() {
  const me = useAuthStore((s) => s.me);
  const navigate = useNavigate();
  const [logoutOpen, setLogoutOpen] = useState(false);

  const lockScreen = useLockScreen();
  const doLock = () => {
    void lockScreen();
    void navigate({ to: '/lock' });
  };

  const itemClass =
    'gap-2.5 rounded-none px-3.5 py-2.5 text-[13px] text-text-2 focus:bg-surface-2 focus:text-foreground [&_svg]:size-4';

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
          className="w-[290px] rounded-[14px] border border-border-2 p-0 shadow-float"
        >
          <div className="flex items-center gap-[11px] border-b border-border px-3.5 py-[13px]">
            <Avatar login={me?.login} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold">{me?.login ?? '—'}</div>
              <div className="truncate text-[11px] text-text-3">
                администратор ·{' '}
                {me?.amr.includes('totp') || me?.amr.includes('recovery') ? 'вход с 2FA' : 'вход по паролю'}
              </div>
            </div>
          </div>
          {isSectionOpen('/settings') ? (
            <DropdownMenuItem
              onSelect={() => void navigate({ to: '/settings/security' })}
              className={itemClass}
            >
              <ShieldIcon aria-hidden="true" />
              Безопасность и сессии
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled title={LOCKED_HINT} className={cn(itemClass, 'text-text-3')}>
              <ShieldIcon aria-hidden="true" />
              <span className="flex-1">Безопасность и сессии</span>
              <LockIcon className="size-[13px]! opacity-70" aria-hidden="true" />
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="my-0" />
          <DropdownMenuItem onSelect={doLock} className={itemClass}>
            <LockIcon aria-hidden="true" />
            Заблокировать экран
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-0" />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setLogoutOpen(true)}
            className={cn(itemClass, 'text-crit focus:bg-crit-soft focus:text-crit dark:focus:bg-crit-soft')}
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

/* ---------- каркас ---------- */
interface AppShellProps {
  /** Заголовок раздела; если не задан — шапка не рисуется (напр. чат ассистента на весь экран). */
  title?: string;
  subtitle?: string;
  /** Маленькие сервисные кнопки справа от заголовка (например, ссылки на документацию API). */
  actions?: ReactNode;
  children: ReactNode;
}

export function AppShell({ title, subtitle, actions, children }: AppShellProps) {
  // Автоблокировка экрана при бездействии — по политике безопасности.
  const security = useSecurityOverview();
  useIdleLock(security.data?.policy.lockAfterMinutes ?? 0);
  const openIncidents = useOpenIncidentsCount();
  const [collapsed, setCollapsed] = useState(readRail);
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  return (
    <div className="flex h-dvh gap-2 bg-canvas p-2 max-md:gap-1.5 max-md:p-1.5">
      {/* Левая колонка лежит прямо на холсте — без рамок и подложки */}
      <aside
        className={cn(
          'flex w-[248px] min-w-0 flex-none flex-col px-2 pt-1 pb-1 transition-[width] duration-200 max-md:w-16',
          collapsed && 'w-16',
        )}
      >
        <div
          className={cn(
            'flex h-[52px] min-w-0 items-center gap-[11px] px-3 max-md:justify-center max-md:px-0',
            collapsed && 'justify-center px-0',
          )}
        >
          <BrandLogo />
          <BrandName className={cn('truncate text-[15.5px] max-md:hidden', collapsed && 'hidden')} />
        </div>

        <nav
          aria-label="Разделы"
          className={cn(
            'mt-2 flex min-h-0 flex-1 flex-col gap-[3px] overflow-x-hidden overflow-y-auto px-1 max-md:px-0',
            collapsed && 'px-0',
          )}
        >
          <div
            className={cn(
              'px-3 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[0.13em] text-text-3 uppercase max-md:sr-only',
              collapsed && 'sr-only',
            )}
          >
            Управление
          </div>
          {NAV.map((n) => (
            <NavItem
              key={n.to}
              {...n}
              collapsed={collapsed}
              badge={n.to === '/incidents' ? openIncidents : undefined}
            />
          ))}
          <div
            className={cn(
              'px-3 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.13em] text-text-3 uppercase max-md:sr-only',
              collapsed && 'sr-only',
            )}
          >
            Автоматизация
          </div>
          {NAV_AUTOMATION.map((n) => (
            <NavItem key={n.to} {...n} collapsed={collapsed} />
          ))}
          <div className="flex-1" />
          {NAV_BOTTOM.map((n) => (
            <NavItem key={n.to} {...n} collapsed={collapsed} />
          ))}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            aria-expanded={!collapsed}
            className={cn(
              'mt-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-[12.5px] text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-md:hidden',
              collapsed && 'justify-center px-0',
            )}
          >
            <ChevronLeftIcon
              className={cn('size-4 flex-none transition-transform', collapsed && 'rotate-180')}
              aria-hidden="true"
            />
            <span className={cn(collapsed && 'hidden')}>Свернуть меню</span>
          </button>
        </nav>
      </aside>

      {/* Правая часть — одно скруглённое «окно» поверх холста, со своей шапкой */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[inset_0_1px_0_var(--ns-inset-hi),0_0_0_1px_var(--ns-hairline)]">
        <header className="flex h-[58px] min-w-0 flex-none items-center gap-3 border-b border-border px-5 max-md:px-3">
          <button
            type="button"
            disabled
            title="Команды и поиск — этап 6"
            className="flex h-9 w-full max-w-[260px] items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-[13px] text-text-3 disabled:cursor-default max-md:w-9 max-md:justify-center max-md:px-0"
          >
            <SearchIcon className="size-[15px] flex-none" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left max-md:sr-only">Поиск и команды</span>
            <kbd className="rounded-[5px] border border-border bg-surface-2 px-1.5 font-mono text-[10.5px] leading-[1.5] text-text-3 max-md:hidden">
              ⌘K
            </kbd>
          </button>
          <div className="flex-1" />
          <ThemeMenu />
          <UserMenu />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[26px] pt-6 pb-[60px] max-md:px-4">
          {title && (
            <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h1 className="text-[23px]">{title}</h1>
                  {actions && <div className="flex flex-none items-center gap-1.5 pt-1">{actions}</div>}
                </div>
                {subtitle && <p className="mt-[5px] text-[13.5px] text-text-2">{subtitle}</p>}
              </div>
            </div>
          )}
          <div className="animate-fade">{children}</div>
        </main>
        {/* step-up нужен любому разделу (удаление сервера, токены) — один на всё приложение */}
        <StepUpHost />
        {/* веб-терминал — одно плавающее окно на всё приложение */}
        <TerminalHost />
      </div>
    </div>
  );
}

/** Заглушка раздела, который появится на следующих этапах. */
export function StagePlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[280px] place-items-center rounded-[10px] border border-dashed border-border-2 bg-surface p-8 text-center text-[13.5px] text-text-3">
      {children}
    </div>
  );
}

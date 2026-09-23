import { Link, useRouterState } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  LayoutGridIcon,
  ListIcon,
  LockIcon,
  MenuIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type ReactNode, useEffect, useState } from 'react';

import { BrandLogo, BrandName } from '@/components/brand-logo';
import { ThemeMenu } from '@/components/theme-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useOpenIncidentsCount } from '@/features/incidents/incidents-api';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { useSecurityOverview } from '@/features/security/security-api';
import { StepUpHost } from '@/features/security/step-up-host';
import { useIdleLock } from '@/features/security/use-idle-lock';
import { TerminalHost } from '@/features/terminal/terminal-host';
import { isSectionOpen, LOCKED_HINT } from '@/lib/stages';
import { cn } from '@/lib/utils';
import { UserMenu } from './user-menu';

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
/** «Серверы» раскрываются в подпункты: список серверов и справочник провайдеров. */
const SERVERS_GROUP = {
  to: '/servers',
  label: 'Серверы',
  icon: ServerIcon,
  items: [
    { to: '/servers', label: 'Все серверы' },
    { to: '/servers/providers', label: 'Провайдеры' },
  ],
} as const;
/** Раздел «Автоматизация» — AI-ассистент и база знаний. */
const NAV_AUTOMATION = [
  { to: '/assistant', label: 'Ассистент', icon: SparklesIcon },
  { to: '/knowledge', label: 'База знаний', icon: BookOpenIcon },
] as const;
/** Нижняя группа меню — служебное: Журнал внизу, рядом с «Свернуть меню». */
const NAV_BOTTOM = [{ to: '/audit', label: 'Журнал', icon: ListIcon }] as const;

type NavEntry = (typeof NAV)[number] | (typeof NAV_AUTOMATION)[number] | (typeof NAV_BOTTOM)[number];

interface NavItemProps {
  collapsed: boolean;
  badge?: number;
  /** drawer — выезжающее меню на телефоне: всегда с подписями. rail — боковая колонка. */
  mode?: 'rail' | 'drawer';
  onNavigate?: () => void;
}

function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  badge,
  mode = 'rail',
  onNavigate,
}: NavEntry & NavItemProps) {
  const iconOnly = mode === 'rail' && collapsed;
  const railOnPhone = mode === 'rail';
  // Раздел ещё не открыт на своём этапе: в меню остаётся, но с замком и без перехода.
  if (!isSectionOpen(to)) {
    return (
      <button
        type="button"
        disabled
        title={iconOnly ? `${label} — ${LOCKED_HINT}` : LOCKED_HINT}
        className={cn(
          'relative flex w-full cursor-not-allowed items-center gap-[11px] rounded-[10px] px-3 py-[9px] text-left text-[13.5px] font-medium text-text-3 select-none',
          railOnPhone && 'max-md:justify-center max-md:px-0',
          iconOnly && 'justify-center px-0',
        )}
      >
        <Icon className="size-[17px] flex-none opacity-55" aria-hidden="true" />
        <span className={cn('flex-1 opacity-55', railOnPhone && 'max-md:sr-only', iconOnly && 'sr-only')}>
          {label}
        </span>
        <LockIcon
          className={cn(
            'size-[13px] flex-none opacity-70',
            railOnPhone && 'max-md:absolute max-md:top-1 max-md:right-1.5 max-md:size-[11px]',
            iconOnly && 'absolute top-1 right-1.5 size-[11px]',
          )}
          aria-hidden="true"
        />
      </button>
    );
  }
  return (
    <Link
      to={to}
      title={iconOnly ? label : undefined}
      onClick={onNavigate}
      className={cn(
        'relative flex items-center gap-[11px] rounded-[10px] px-3 py-[9px] text-[13.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground',
        'data-[status=active]:bg-brand-soft data-[status=active]:text-brand',
        'data-[status=active]:before:absolute data-[status=active]:before:top-[9px] data-[status=active]:before:bottom-[9px] data-[status=active]:before:-left-3 data-[status=active]:before:w-[3px] data-[status=active]:before:rounded-r-[3px] data-[status=active]:before:bg-brand data-[status=active]:before:content-[""]',
        railOnPhone && 'max-md:justify-center max-md:px-0 max-md:data-[status=active]:before:-left-2.5',
        iconOnly && 'justify-center px-0 data-[status=active]:before:-left-2.5',
        mode === 'drawer' && 'before:hidden',
      )}
      activeOptions={{ exact: to === '/' }}
    >
      <Icon className="size-[17px] flex-none" aria-hidden="true" />
      <span className={cn('flex-1', railOnPhone && 'max-md:sr-only', iconOnly && 'sr-only')}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'inline-flex min-w-[18px] justify-center rounded-full bg-crit px-1.5 py-[1px] text-[10.5px] font-bold text-white tabular-nums',
            railOnPhone &&
              'max-md:absolute max-md:top-1 max-md:right-1 max-md:min-w-[15px] max-md:px-1 max-md:leading-[15px] max-md:shadow-[0_0_0_2px_var(--ns-surface)]',
            iconOnly &&
              'absolute top-1 right-1 min-w-[15px] px-1 leading-[15px] shadow-[0_0_0_2px_var(--ns-surface)]',
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

function GroupLabel({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <div
      className={cn(
        'px-3 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.13em] text-text-3 uppercase first:pt-1',
        hidden && 'sr-only',
      )}
    >
      {children}
    </div>
  );
}

/**
 * Группа «Серверы» с подпунктами. Подпункты раскрываются плавно (grid-rows 0fr→1fr + прозрачность),
 * без прыжков высоты; при `prefers-reduced-motion` — мгновенно. В свёрнутом рейле группа
 * становится всплывающим меню справа от иконки.
 */
function NavGroup({
  collapsed,
  mode = 'rail',
  onNavigate,
}: {
  collapsed: boolean;
  mode?: 'rail' | 'drawer';
  onNavigate?: () => void;
}) {
  const { to, label, icon: Icon, items } = SERVERS_GROUP;
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const inSection = pathname === to || pathname.startsWith(`${to}/`);
  const [open, setOpen] = useState(inSection);
  // Пришли в раздел (по ссылке или из меню) — подпункты показываем сразу.
  useEffect(() => {
    if (inSection) setOpen(true);
  }, [inSection]);
  const iconOnly = mode === 'rail' && collapsed;
  const isItemActive = (item: (typeof items)[number]) =>
    item.to === to ? pathname === to : pathname === item.to || pathname.startsWith(`${item.to}/`);

  if (iconOnly) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          title={label}
          aria-label={label}
          className={cn(
            'relative flex w-full cursor-pointer items-center justify-center rounded-[10px] px-0 py-[9px] text-text-2 transition-colors outline-none hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand data-open:bg-surface-2 data-open:text-foreground',
            inSection &&
              'bg-brand-soft text-brand before:absolute before:top-[9px] before:bottom-[9px] before:-left-2.5 before:w-[3px] before:rounded-r-[3px] before:bg-brand before:content-[""]',
          )}
        >
          <Icon className="size-[17px] flex-none" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={10} className="w-auto min-w-[176px]">
          <DropdownMenuLabel className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
            {label}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {items.map((item) => (
            <DropdownMenuItem key={item.to} asChild>
              <Link
                to={item.to}
                onClick={onNavigate}
                className={cn('cursor-pointer text-[13px]', isItemActive(item) && 'font-semibold text-brand')}
              >
                {item.label}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const railOnPhone = mode === 'rail';
  // Когда подпункты раскрыты, подсветка живёт на подпункте, а не на родителе.
  const parentActive = inSection && !open;
  return (
    <div className="flex flex-col">
      <div
        className={cn(
          'relative flex items-center rounded-[10px] text-[13.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground',
          inSection && 'text-foreground',
          parentActive && 'bg-brand-soft text-brand',
          parentActive &&
            mode !== 'drawer' &&
            'before:absolute before:top-[9px] before:bottom-[9px] before:-left-3 before:w-[3px] before:rounded-r-[3px] before:bg-brand before:content-[""]',
          railOnPhone && 'max-md:justify-center',
        )}
      >
        <Link
          to={to}
          onClick={() => {
            setOpen(true);
            onNavigate?.();
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-[11px] rounded-[10px] px-3 py-[9px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
            railOnPhone && 'max-md:flex-none max-md:justify-center max-md:px-0',
          )}
        >
          <Icon className="size-[17px] flex-none" aria-hidden="true" />
          <span className={cn('flex-1 truncate', railOnPhone && 'max-md:sr-only')}>{label}</span>
        </Link>
        <button
          type="button"
          aria-label={open ? 'Скрыть подпункты «Серверы»' : 'Показать подпункты «Серверы»'}
          aria-expanded={open}
          aria-controls="nav-servers-items"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'mr-1 grid size-7 flex-none cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors outline-none hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
            railOnPhone && 'max-md:hidden',
          )}
        >
          <ChevronDownIcon
            className={cn(
              'size-4 transition-transform duration-200 ease-out motion-reduce:transition-none',
              !open && '-rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <div
        id="nav-servers-items"
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          railOnPhone && 'max-md:hidden',
        )}
      >
        <ul className="flex min-h-0 flex-col gap-[2px] overflow-hidden" inert={!open}>
          {items.map((item) => {
            const active = isItemActive(item);
            return (
              <li
                key={item.to}
                className="relative ml-[21px] border-l border-border pl-[9px] first:mt-[3px] last:mb-[2px]"
              >
                <Link
                  to={item.to}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center rounded-[8px] px-2.5 py-[7px] text-[13px] font-medium text-text-2 transition-colors outline-none hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
                    active && 'bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Список разделов — один и тот же в боковой колонке и в выезжающем меню на телефоне. */
function NavList({
  collapsed,
  mode,
  openIncidents,
  onNavigate,
}: {
  collapsed: boolean;
  mode: 'rail' | 'drawer';
  openIncidents: number | undefined;
  onNavigate?: () => void;
}) {
  const hideLabels = mode === 'rail' && collapsed;
  const labelClass = mode === 'rail' ? 'max-md:sr-only' : undefined;
  return (
    <>
      <GroupLabel hidden={hideLabels}>
        <span className={labelClass}>Управление</span>
      </GroupLabel>
      {NAV.map((n) =>
        n.to === SERVERS_GROUP.to ? (
          <NavGroup key={n.to} collapsed={collapsed} mode={mode} onNavigate={onNavigate} />
        ) : (
          <NavItem
            key={n.to}
            {...n}
            collapsed={collapsed}
            mode={mode}
            onNavigate={onNavigate}
            badge={n.to === '/incidents' ? openIncidents : undefined}
          />
        ),
      )}
      <GroupLabel hidden={hideLabels}>
        <span className={labelClass}>Автоматизация</span>
      </GroupLabel>
      {NAV_AUTOMATION.map((n) => (
        <NavItem key={n.to} {...n} collapsed={collapsed} mode={mode} onNavigate={onNavigate} />
      ))}
      <div className="flex-1" />
      {NAV_BOTTOM.map((n) => (
        <NavItem key={n.to} {...n} collapsed={collapsed} mode={mode} onNavigate={onNavigate} />
      ))}
    </>
  );
}

/** Телефон: гамбургер в шапке открывает выезжающее слева меню — полную копию боковой колонки. */
function MobileNav({ openIncidents }: { openIncidents: number | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        aria-label="Открыть меню"
        className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 md:hidden [&_svg]:size-[17px]"
      >
        <MenuIcon aria-hidden="true" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-100 bg-black/45 backdrop-blur-[2px] duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-100 flex w-[272px] max-w-[85vw] flex-col border-r border-border-2 bg-surface px-3 pt-2 pb-3 shadow-float outline-none duration-200 data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
        >
          <DialogPrimitive.Title className="sr-only">Разделы панели</DialogPrimitive.Title>
          <div className="flex h-[52px] items-center gap-[11px] px-2">
            <BrandLogo />
            <BrandName className="truncate text-[15.5px]" />
            <DialogPrimitive.Close
              aria-label="Закрыть меню"
              className="ml-auto grid size-8 cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground [&_svg]:size-4"
            >
              <XIcon aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <nav aria-label="Разделы" className="mt-1 flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto">
            <NavList
              collapsed={false}
              mode="drawer"
              openIncidents={openIncidents}
              onNavigate={() => setOpen(false)}
            />
          </nav>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
    <div className="flex h-dvh gap-2 bg-canvas p-2 max-md:gap-0 max-md:p-0">
      {/* Левая колонка лежит прямо на холсте — без рамок и подложки. На телефоне её заменяет выезжающее меню. */}
      <aside
        className={cn(
          'flex w-[248px] min-w-0 flex-none flex-col px-2 pt-1 pb-1 transition-[width] duration-200 max-md:hidden',
          collapsed && 'w-16',
        )}
      >
        <div
          className={cn(
            'flex h-[52px] min-w-0 items-center gap-[11px] px-3',
            collapsed && 'justify-center px-0',
          )}
        >
          <BrandLogo />
          <BrandName className={cn('truncate text-[15.5px]', collapsed && 'hidden')} />
        </div>

        <nav
          aria-label="Разделы"
          className={cn(
            'mt-2 flex min-h-0 flex-1 flex-col gap-[3px] overflow-x-hidden overflow-y-auto px-1',
            collapsed && 'px-0',
          )}
        >
          <NavList collapsed={collapsed} mode="rail" openIncidents={openIncidents} />
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            aria-expanded={!collapsed}
            className={cn(
              'mt-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-[12.5px] text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
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

      {/* Правая часть — одно скруглённое «окно» поверх холста, со своей шапкой. На телефоне — во весь экран. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[inset_0_1px_0_var(--ns-inset-hi),0_0_0_1px_var(--ns-hairline)] max-md:rounded-none max-md:border-0 max-md:shadow-none">
        <header className="flex h-[58px] min-w-0 flex-none items-center gap-3 border-b border-border px-5 max-md:gap-2 max-md:px-3">
          <MobileNav openIncidents={openIncidents} />
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
          <NotificationBell />
          <ThemeMenu />
          <UserMenu />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[26px] pt-6 pb-[60px] max-md:px-4 max-md:pt-4">
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

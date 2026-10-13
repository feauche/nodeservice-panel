import { SECURITY_POLICY_DEFAULTS } from '@nodeservice/shared';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  ActivityIcon,
  AlertTriangleIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  GitBranchIcon,
  LayoutGridIcon,
  LockIcon,
  MenuIcon,
  PlugIcon,
  SearchIcon,
  WalletIcon,
  XIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type ComponentType, createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrandLogo, BrandName } from '@/components/brand-logo';
import { JarvisIcon } from '@/components/jarvis-icon';
import {
  DnsIntegrationsIcon,
  DpiCheckerIcon,
  ReferenceJournalIcon,
  ReferenceNodesIcon,
  ReferenceSettingsIcon,
} from '@/components/reference-icons';
import { ThemeMenu } from '@/components/theme-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NavGroupLabel as GroupLabel } from '@/components/ui/nav-group-label';
import { useEventsStream } from '@/features/events/use-events-stream';
import { useOpenIncidentsCount } from '@/features/incidents/incidents-api';
import { useSecurityOverview } from '@/features/security/security-api';
import { useIdleLock } from '@/features/security/use-idle-lock';
import { CustomSitesNav, CustomSitesTopMenu } from '@/features/settings/custom-sites-nav';
import { useNavigationLayout } from '@/features/settings/navigation-layout';
import { PanelVersion } from '@/features/system/panel-version';
import { isSectionOpen, LOCKED_HINT } from '@/lib/stages';
import { useMediaQuery } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { type NavGroupId, toggleNavGroup, useClosedNavGroups } from './nav-groups';
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
  { to: '/nodes', label: 'Ноды', icon: ReferenceNodesIcon },
  { to: '/billing', label: 'Биллинг', icon: WalletIcon },
  { to: '/metrics', label: 'Метрики', icon: ActivityIcon },
  { to: '/incidents', label: 'События', icon: AlertTriangleIcon },
  { to: '/scenarios', label: 'Сценарии', icon: GitBranchIcon },
  { to: '/settings', label: 'Настройки', icon: ReferenceSettingsIcon },
] as const;
/** Раздел «Помощь» — Ассистент и база знаний. */
const NAV_HELP = [
  { to: '/assistant', label: 'Ассистент', icon: JarvisIcon },
  { to: '/knowledge', label: 'База знаний', icon: BookOpenIcon },
] as const;
function BsCheckerIcon({ className }: { className?: string }) {
  return <img src="/integration-icons/bschecker.svg" alt="" className={className} />;
}
const NAV_INTEGRATIONS = [
  { to: '/integrations/dpi', label: 'DPI Checker', icon: DpiCheckerIcon },
  { to: '/integrations/dns', label: 'DNS интеграции', icon: DnsIntegrationsIcon },
  { to: '/integrations/bschecker', label: 'BS Checker', icon: BsCheckerIcon },
] as const;
/** Версия панели из сборки; в тестах без Vite — «dev». */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
const APP_COMMIT = import.meta.env.VITE_APP_COMMIT;
const APP_BUILT_AT = import.meta.env.VITE_APP_BUILT_AT;

/** Нижняя группа меню — служебное: Журнал внизу, рядом с «Свернуть меню». */
const NAV_BOTTOM = [{ to: '/audit', label: 'Журнал', icon: ReferenceJournalIcon }] as const;

type NavEntry =
  | (typeof NAV)[number]
  | (typeof NAV_HELP)[number]
  | (typeof NAV_BOTTOM)[number]
  | (typeof NAV_INTEGRATIONS)[number];

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
        <span className="grid size-6 flex-none place-items-center">
          <Icon className="size-[17px] opacity-55" aria-hidden="true" />
        </span>
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
      <span className="grid size-6 flex-none place-items-center">
        <Icon className="size-[17px]" aria-hidden="true" />
      </span>
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

/** Пункт меню открыт: «Обзор» — только корень, остальные — и вложенные адреса. */
const isActive = (to: string, pathname: string) =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);

/**
 * Группа меню (витрина menu-groups-2026-10, вариант A): заголовок сворачивает её, положение помнит браузер.
 * Свёрнутая группа — одна строка «УПРАВЛЕНИЕ · 7»; открытый раздел остаётся на виду, счётчики скрытых пунктов
 * (открытые события) — на заголовке. Меню значками групп не сворачивает: заголовков там нет.
 */
function NavSection({
  id,
  title,
  items,
  badges,
  collapsed,
  mode,
  canCollapse,
  pathname,
  onNavigate,
}: {
  id: NavGroupId;
  title: string;
  items: ReadonlyArray<NavEntry>;
  badges?: Partial<Record<string, number | undefined>>;
  collapsed: boolean;
  mode: 'rail' | 'drawer';
  canCollapse: boolean;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const closed = useClosedNavGroups();
  const open = !canCollapse || !closed.has(id);
  const active = open ? undefined : items.find((n) => isActive(n.to, pathname));
  const hiddenBadge = items.filter((n) => n !== active).reduce((sum, n) => sum + (badges?.[n.to] ?? 0), 0);
  const controls = `nav-group-${id}-${mode}`;
  const item = (n: NavEntry) => (
    <NavItem
      key={n.to}
      {...n}
      collapsed={collapsed}
      mode={mode}
      onNavigate={onNavigate}
      badge={badges?.[n.to]}
    />
  );
  return (
    <>
      <GroupLabel
        hidden={mode === 'rail' && collapsed}
        toggle={
          canCollapse
            ? {
                open,
                onToggle: () => toggleNavGroup(id),
                count: items.length,
                badge: open ? 0 : hiddenBadge,
                controls,
              }
            : undefined
        }
      >
        <span className={mode === 'rail' ? 'max-md:sr-only' : undefined}>{title}</span>
      </GroupLabel>
      {active && item(active)}
      {/* Пункты сворачиваются по высоте за 0,2 с; свёрнутые недоступны с клавиатуры (inert). */}
      <div
        id={controls}
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows] duration-200',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="flex min-h-0 flex-col gap-[3px] overflow-hidden">
          {items.filter((n) => n !== active).map(item)}
        </div>
      </div>
    </>
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
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  // На узком экране боковая колонка — значками: групп с заголовками там нет, сворачивать нечего.
  const narrow = useMediaQuery('(max-width: 767px)', false);
  const canCollapse = mode === 'drawer' || (!collapsed && !narrow);
  const common = { collapsed, mode, canCollapse, pathname, onNavigate };
  return (
    <>
      <NavSection
        id="manage"
        title="Управление"
        items={NAV}
        badges={{ '/incidents': openIncidents }}
        {...common}
      />
      <NavSection id="help" title="Помощь" items={NAV_HELP} {...common} />
      <NavSection id="integrations" title="Интеграции" items={NAV_INTEGRATIONS} {...common} />
      <CustomSitesNav collapsed={collapsed} mode={mode} canCollapse={canCollapse} onNavigate={onNavigate} />
      <div className="flex-1" />
      {NAV_BOTTOM.map((n) => (
        <NavItem key={n.to} {...n} collapsed={collapsed} mode={mode} onNavigate={onNavigate} />
      ))}
    </>
  );
}

function TopBadge({ value }: { value: number | undefined }) {
  if (!value) return null;
  return (
    <span className="inline-flex min-w-[17px] justify-center rounded-full bg-crit px-1 text-[10px] font-bold leading-[17px] text-white tabular-nums">
      {value}
    </span>
  );
}

function TopNavLink({ to, label, icon: Icon, badge }: NavEntry & { badge?: number | undefined }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/' }}
      className="inline-flex h-9 items-center gap-1.5 rounded-[9px] px-2.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground data-[status=active]:bg-brand-soft data-[status=active]:text-brand focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
    >
      <Icon className="size-4 flex-none" aria-hidden="true" />
      <span>{label}</span>
      <TopBadge value={badge} />
    </Link>
  );
}

function TopNavGroup({
  label,
  icon: Icon,
  active,
  children,
}: {
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[9px] px-2.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand data-open:bg-surface-2 data-open:text-foreground',
          active && 'bg-brand-soft text-brand',
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
        <span>{label}</span>
        <ChevronDownIcon className="size-3.5 text-text-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[190px]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Полная настольная навигация выбранного варианта B. */
function TopNavigation({ openIncidents }: { openIncidents: number | undefined }) {
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const inAutomation = pathname === '/assistant' || pathname === '/knowledge';

  return (
    <nav data-testid="top-navigation" aria-label="Верхнее меню" className="flex min-w-0 items-center gap-0.5">
      {NAV.filter((item) => item.to !== '/settings').map((item) => (
        <TopNavLink key={item.to} {...item} badge={item.to === '/incidents' ? openIncidents : undefined} />
      ))}
      <TopNavGroup label="Помощь" icon={JarvisIcon} active={inAutomation}>
        {NAV_HELP.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.to} asChild>
              <Link
                to={item.to}
                className={cn(
                  'cursor-pointer text-[13px]',
                  pathname === item.to && 'font-semibold text-brand',
                )}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </TopNavGroup>
      <TopNavGroup label="Интеграции" icon={PlugIcon} active={pathname.startsWith('/integrations/')}>
        {NAV_INTEGRATIONS.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.to} asChild>
              <Link to={item.to}>
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </TopNavGroup>
      <CustomSitesTopMenu />
      {NAV.filter((item) => item.to === '/settings').map((item) => (
        <TopNavLink key={item.to} {...item} />
      ))}
      <TopNavLink {...NAV_BOTTOM[0]} />
    </nav>
  );
}

/** Телефон: гамбургер в шапке открывает выезжающее слева меню — полную копию боковой колонки. */
function MobileNav({
  openIncidents,
  hideAt = 'md',
}: {
  openIncidents: number | undefined;
  hideAt?: 'md' | 'xl';
}) {
  const [open, setOpen] = useState(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        aria-label="Открыть меню"
        className={cn(
          'grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 [&_svg]:size-[17px]',
          hideAt === 'xl' ? 'xl:hidden' : 'md:hidden',
        )}
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
  /** Заголовок раздела; если не задан — шапка не рисуется (напр. чат Ассистента на весь экран). */
  title?: string;
  subtitle?: string;
  /** Маленькие сервисные кнопки справа от заголовка (например, ссылки на документацию API). */
  actions?: ReactNode;
  /** Переключатель всей страницы справа от заголовка (например, «Сейчас / Статистика» в «Обзоре»). */
  aside?: ReactNode;
  children: ReactNode;
}

/** Место для кнопок раздела в шапке страницы справа: раздел кладёт их туда сам через PageActions. */
const PageActionsSlot = createContext<HTMLElement | null>(null);
/**
 * Кнопки раздела в шапке страницы справа, рядом с заголовком («Подключения», «История замен»), когда их
 * состояние живёт в самом разделе, а не в маршруте.
 */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

export function AppShell({ title, subtitle, actions, aside, children }: AppShellProps) {
  // Живой поток: серверы, события и уведомления обновляются в момент изменения, без опроса.
  useEventsStream();
  // Автоблокировка экрана при бездействии — по политике безопасности.
  const security = useSecurityOverview();
  // Политика не загрузилась — блокируем по умолчанию (30 минут), а не выключаем автоблокировку молча.
  useIdleLock(security.data?.policy.lockAfterMinutes ?? SECURITY_POLICY_DEFAULTS.lockAfterMinutes);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const openIncidents = useOpenIncidentsCount();
  const navigationLayout = useNavigationLayout();
  const topLayout = navigationLayout === 'top';
  const [collapsed, setCollapsed] = useState(readRail);
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  return (
    <div
      data-navigation-layout={navigationLayout}
      className="flex h-dvh gap-2 bg-canvas p-2 max-md:gap-0 max-md:p-0"
    >
      {/* Левая колонка лежит прямо на холсте — без рамок и подложки. На телефоне её заменяет выезжающее меню. */}
      {!topLayout && (
        <aside
          data-testid="app-shell-sidebar"
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
              <span className={cn('whitespace-nowrap', collapsed && 'hidden')}>Свернуть меню</span>
              <span className="flex-1" />
            </button>
          </nav>
        </aside>
      )}

      {/* Правая часть — одно скруглённое «окно» поверх холста, со своей шапкой. На телефоне — во весь экран. */}
      <div
        data-testid="app-shell-panel"
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[inset_0_1px_0_var(--ns-inset-hi),0_0_0_1px_var(--ns-hairline)] max-md:rounded-none max-md:border-0 max-md:shadow-none"
      >
        <header
          className={cn(
            'relative z-10 flex h-[58px] min-w-0 flex-none items-center gap-3 border-b border-border bg-background px-5 max-md:gap-2 max-md:px-3',
            topLayout && 'xl:px-4',
          )}
        >
          {topLayout ? (
            <>
              <div className="hidden min-w-0 items-center xl:flex">
                <Link
                  to="/"
                  aria-label="NodeService — на обзор"
                  className="mr-1 flex flex-none items-center gap-2.5 rounded-[9px] pr-1 outline-none focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <BrandLogo />
                  <BrandName className="text-[14.5px]" />
                </Link>
              </div>
              <div className="absolute left-1/2 hidden -translate-x-1/2 xl:block">
                <TopNavigation openIncidents={openIncidents} />
              </div>
              <div className="flex min-w-0 items-center gap-2 xl:hidden">
                <MobileNav hideAt="xl" openIncidents={openIncidents} />
                <BrandLogo />
                <BrandName className="truncate text-[14.5px] max-sm:hidden" />
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
          <div className="flex-1" />
          <PanelVersion version={APP_VERSION} commit={APP_COMMIT} builtAt={APP_BUILT_AT} />
          <a
            href="https://github.com/feauche/nodeservice-panel"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="NodeService на GitHub"
            title="NodeService на GitHub"
            className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-border bg-surface text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden="true">
              <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1 .1.01 2.22 3.28 1.59.1-.73.4-1.23.71-1.51-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.09-1.16 3.09-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.64 5.27-5.15 5.55.41.35.77 1.04.77 2.1v3.03c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" />
            </svg>
            <span className="sr-only">Репозиторий NodeService</span>
          </a>
          <ThemeMenu />
          <UserMenu />
        </header>

        {/* Общая сетка (витрина redesign-2026-10, вариант B): поля 22 по бокам, 20 сверху; между блоками 12. */}
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[22px] pt-5 pb-[60px] max-md:px-4 max-md:pt-4">
          {title && (
            <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h1 className="text-[23px]">{title}</h1>
                  {actions && <div className="flex flex-none items-center gap-1.5 pt-1">{actions}</div>}
                </div>
                {subtitle && <p className="mt-[5px] text-[13.5px] text-text-2">{subtitle}</p>}
              </div>
              {aside && <div className="flex-none self-start pt-1 max-sm:w-full">{aside}</div>}
              <div
                ref={setActionsSlot}
                className="flex flex-none flex-wrap items-center gap-2 self-start pt-1 empty:hidden max-sm:w-full"
              />
            </div>
          )}
          <PageActionsSlot.Provider value={actionsSlot}>
            <div className="animate-fade">{children}</div>
          </PageActionsSlot.Provider>
        </main>
        {/* Запрос пароля — не здесь, а в корневом маршруте (SessionHosts): этот каркас каждый раздел
            рисует заново, и переход по меню пересоздавал бы окно. */}
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

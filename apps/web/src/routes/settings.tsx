import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  ActivityIcon,
  BellIcon,
  BookOpenTextIcon,
  BracesIcon,
  DatabaseBackupIcon,
  ShieldIcon,
  SunIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { JarvisIcon } from '@/components/jarvis-icon';
import { AppShell } from '@/components/layout/app-shell';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ASSISTANT_SECTIONS, assistantSectionOf } from '@/features/assistant/assistant-sections';
import { requireAuth } from '@/features/auth/guards';
import { isSectionOpen, requireSectionOpen } from '@/lib/stages';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings');
  },
  component: SettingsLayout,
});

/** Разделы настроек рейкой слева (витрина `telegram-settings-variants.html`, вариант L2), по группам. */
const GROUPS = [
  {
    title: 'Панель',
    items: [
      { to: '/settings/appearance', label: 'Внешний вид', icon: SunIcon },
      { to: '/settings/security', label: 'Безопасность', icon: ShieldIcon },
      { to: '/settings/notifications', label: 'Уведомления', icon: BellIcon },
      { to: '/settings/backups', label: 'Резервные копии', icon: DatabaseBackupIcon },
    ],
  },
  {
    title: 'Слежение',
    items: [
      { to: '/settings/autochecks', label: 'Автопроверки', icon: ActivityIcon },
      { to: '/settings/incidents', label: 'Инциденты', icon: TriangleAlertIcon },
    ],
  },
  { title: 'Помощник', items: [{ to: '/settings/assistant', label: 'Джарвис', icon: JarvisIcon }] },
] as const;

/** Сервисные страницы вне панели — маленькими кнопками у заголовка, с подсказкой куда ведут. */
const SERVICE_LINKS = [
  { href: '/api/backend-tools/docs', label: 'Документация API', icon: BookOpenTextIcon },
  { href: '/api/backend-tools/swagger', label: 'OpenAPI-схема (swagger)', icon: BracesIcon },
] as const;

function ServiceLinks() {
  return (
    <>
      {SERVICE_LINKS.map((l) => (
        <Tooltip key={l.href}>
          <TooltipTrigger asChild>
            <a
              href={l.href}
              target="_blank"
              rel="noreferrer"
              aria-label={l.label}
              className="grid size-8 place-items-center rounded-[9px] border border-border bg-surface text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
            >
              <l.icon className="size-4" aria-hidden="true" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {l.label} <span className="ml-1 font-mono text-[10.5px] opacity-70">{l.href}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}

function SettingsLayout() {
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const search = useRouterState({ select: (st) => st.location.search }) as { s?: unknown };
  const onAssistant = pathname === '/settings/assistant';
  const assistantSection = assistantSectionOf(search.s);
  return (
    <AppShell
      title="Настройки"
      subtitle="Всё, что можно настроить, — в одном месте"
      actions={<ServiceLinks />}
    >
      <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav
          aria-label="Разделы настроек"
          className="flex gap-0.5 max-lg:overflow-x-auto max-lg:rounded-[11px] max-lg:border max-lg:border-border max-lg:bg-surface max-lg:p-[3px] lg:sticky lg:top-3 lg:flex-col lg:self-start"
        >
          {GROUPS.map((g) => {
            const items = g.items.filter((t) => isSectionOpen(t.to));
            if (items.length === 0) return null;
            return (
              <div key={g.title} className="flex gap-0.5 lg:flex-col">
                <div className="px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase max-lg:hidden">
                  {g.title}
                </div>
                {items.map((t) => (
                  <div key={t.to} className="flex gap-0.5 lg:flex-col">
                    <Link
                      to={t.to}
                      activeOptions={{ includeSearch: false }}
                      className="group flex items-center gap-2.5 rounded-[9px] px-3 py-2 text-[13px] font-medium whitespace-nowrap text-text-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-lg:py-1.5 max-lg:text-[12.5px]"
                      activeProps={{ className: 'bg-surface-3 text-foreground', 'aria-current': 'page' }}
                    >
                      <t.icon
                        className="size-[15px] text-text-3 group-aria-[current=page]:text-brand max-lg:hidden"
                        aria-hidden="true"
                      />
                      {t.label}
                    </Link>
                    {/* Подразделы Джарвиса — прямо в рейке под ним (вариант A), только когда он открыт. */}
                    {t.to === '/settings/assistant' &&
                      onAssistant &&
                      ASSISTANT_SECTIONS.map((sec) => (
                        <Link
                          key={sec.key}
                          to="/settings/assistant"
                          search={{ s: sec.key }}
                          aria-current={assistantSection === sec.key ? 'page' : undefined}
                          className={cn(
                            'rounded-[9px] py-1.5 pr-3 pl-9 text-[12.5px] whitespace-nowrap transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-lg:pl-3',
                            assistantSection === sec.key ? 'font-medium text-brand' : 'text-text-3',
                          )}
                        >
                          {sec.label}
                        </Link>
                      ))}
                  </div>
                ))}
              </div>
            );
          })}
        </nav>
        {/* Одна ширина содержимого у всех разделов. */}
        <div className="min-w-0 max-w-[860px]">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}

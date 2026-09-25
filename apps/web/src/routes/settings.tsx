import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { BookOpenTextIcon, BracesIcon } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { requireAuth } from '@/features/auth/guards';
import { isSectionOpen, requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/settings');
  },
  component: SettingsLayout,
});

const TABS = [
  { to: '/settings/appearance', label: 'Внешний вид' },
  { to: '/settings/security', label: 'Безопасность' },
  { to: '/settings/autochecks', label: 'Автопроверки' },
  { to: '/settings/incidents', label: 'Инциденты' },
  { to: '/settings/assistant', label: 'Джарвис' },
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
  return (
    <AppShell
      title="Настройки"
      subtitle="Всё, что можно настроить, — в одном месте"
      actions={<ServiceLinks />}
    >
      <nav
        aria-label="Разделы настроек"
        className="mb-5 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[11px] border border-border bg-surface p-[3px]"
      >
        {TABS.filter((t) => isSectionOpen(t.to)).map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="rounded-lg px-[13px] py-1.5 text-[12.5px] font-medium whitespace-nowrap text-text-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
            activeProps={{ className: 'bg-surface-3 text-foreground', 'aria-current': 'page' }}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </AppShell>
  );
}

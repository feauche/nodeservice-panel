import {
  SERVER_IMPORTANCE_LABELS,
  SERVER_ROLE_SHORT,
  type Server,
  type ServerRole,
} from '@nodeservice/shared';
import {
  ArrowRightLeftIcon,
  CircleHelpIcon,
  GlobeIcon,
  LayersIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  LogInIcon,
  type LucideIcon,
  ServerIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import { useState } from 'react';
import { CountryFlag } from '@/components/country-flag';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { countryTip, countryView } from './country-text';

const ROLE_ICONS: Record<ServerRole, LucideIcon> = {
  entry: LogInIcon,
  exit: GlobeIcon,
  bridge: ArrowRightLeftIcon,
  panel: LayoutDashboardIcon,
  other: ServerIcon,
};

/** Подпись значка функций: «Вход, Выход. Критичный»; без функций — «Важность: Критичный». */
export function roleMarkLabel(profile: Server['profile']): string | null {
  const importance = SERVER_IMPORTANCE_LABELS[profile.importance];
  if (profile.roles.length > 0)
    return `${profile.roles.map((r) => SERVER_ROLE_SHORT[r]).join(', ')}. ${importance}`;
  return profile.importance === 'critical' ? `Важность: ${importance}` : null;
}

/**
 * Значок функций рядом с названием сервера: маленькая плитка с подсказкой. Одна функция — её значок, несколько —
 * общий; нет функций и нет критичности — ничего.
 */
export function RoleMark({ server }: { server: Server }) {
  const label = roleMarkLabel(server.profile);
  if (!label) return null;
  const [only, ...more] = server.profile.roles;
  const Icon = only ? (more.length === 0 ? ROLE_ICONS[only] : LayersIcon) : ShieldAlertIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-testid="role-mark"
          className="-mt-[1.5px] grid size-[22px] flex-none place-items-center rounded-[7px] bg-surface-3 text-text-2"
        >
          <Icon className="size-[13px]" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Тёплая точка, когда состояние сервера не совпадает с ожидаемым по профилю. */
export function DriftDot({ server }: { server: Server }) {
  const n = server.drift.length;
  if (n === 0) return null;
  const label = `Не совпадает с ожидаемым: ${n}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-testid="drift-dot"
          className="size-2 flex-none rounded-full bg-warn"
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Плитка страны рядом со значком функций (C3, подсказка D1): только флаг, всё остальное — в подсказке. На телефоне
 * наведения нет, поэтому подсказка открывается и нажатием. Страны нет и определение не идёт — плитки нет.
 */
export function CountryMark({ server }: { server: Server }) {
  const [open, setOpen] = useState(false);
  const c = server.country;
  const view = countryView(c);
  if (view === 'unset') return null;
  const tip = countryTip(c);
  const label = [tip.name, tip.text].filter(Boolean).join('. ').replace(/\.\./g, '.');
  const inner = c.code ? (
    <CountryFlag code={c.code} decorative />
  ) : view === 'detecting' ? (
    <Loader2Icon className="size-3.5 animate-spin text-text-3" aria-hidden="true" />
  ) : (
    <CircleHelpIcon className="size-3.5 text-warn" aria-hidden="true" />
  );
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid="country-mark"
          data-view={view}
          onClick={(e) => {
            // Клик по плитке не открывает карточку сервера, а показывает подсказку: на телефоне нет наведения.
            // preventDefault: иначе Radix закрыл бы подсказку тем же кликом.
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
          className="-mt-[1.5px] grid h-[22px] w-[26px] flex-none cursor-default place-items-center rounded-[7px] bg-surface-3 focus-visible:outline-2 focus-visible:outline-brand"
        >
          {inner}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="max-w-[280px] flex-col items-start gap-0.5 text-left leading-snug"
      >
        {tip.name && <b className="font-semibold">{tip.name}</b>}
        <span>{tip.text}</span>
      </TooltipContent>
    </Tooltip>
  );
}

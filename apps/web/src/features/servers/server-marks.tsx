import {
  SERVER_IMPORTANCE_LABELS,
  SERVER_ROLE_SHORT,
  type Server,
  type ServerRole,
} from '@nodeservice/shared';
import {
  ArrowRightLeftIcon,
  GlobeIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LogInIcon,
  type LucideIcon,
  ServerIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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

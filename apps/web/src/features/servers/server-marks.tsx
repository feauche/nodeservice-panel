import {
  SERVER_IMPORTANCE_LABELS,
  SERVER_ROLE_LABELS,
  type Server,
  type ServerRole,
} from '@nodeservice/shared';
import {
  ArrowRightLeftIcon,
  GlobeIcon,
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
  relay: ArrowRightLeftIcon,
  panel: LayoutDashboardIcon,
  other: ServerIcon,
};

/** Подпись значка роли: «Входной. Критичный»; без роли — «Важность: Критичный». */
export function roleMarkLabel(profile: Server['profile']): string | null {
  const importance = SERVER_IMPORTANCE_LABELS[profile.importance];
  if (profile.role) return `${SERVER_ROLE_LABELS[profile.role]}. ${importance}`;
  return profile.importance === 'critical' ? `Важность: ${importance}` : null;
}

/** Значок роли рядом с названием сервера: маленькая плитка с подсказкой. Нет роли и нет критичности — ничего. */
export function RoleMark({ server }: { server: Server }) {
  const label = roleMarkLabel(server.profile);
  if (!label) return null;
  const Icon = server.profile.role ? ROLE_ICONS[server.profile.role] : ShieldAlertIcon;
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

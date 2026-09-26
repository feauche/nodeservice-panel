import { z } from 'zod';

/**
 * Профиль сервера в парке (J3): зачем он нужен и что на нём должно работать. Это знание владельца, панель его
 * не угадывает. Фактическое состояние (что реально запущено и слушает порты) панель собирает по SSH раз в
 * сутки и сравнивает с ожидаемым: расхождение показывается предупреждением и доступно Джарвису.
 */

export const SERVER_ROLES = ['entry', 'exit', 'relay', 'panel', 'other'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];
export const SERVER_ROLE_LABELS: Record<ServerRole, string> = {
  entry: 'Входной',
  exit: 'Выходной',
  relay: 'Реле',
  panel: 'Панель',
  other: 'Другое',
};

export const SERVER_IMPORTANCE = ['critical', 'normal', 'low'] as const;
export type ServerImportance = (typeof SERVER_IMPORTANCE)[number];
export const SERVER_IMPORTANCE_LABELS: Record<ServerImportance, string> = {
  critical: 'Критичный',
  normal: 'Обычный',
  low: 'Второстепенный',
};

export const EXPECTED_CONTAINERS_MAX = 20;
export const EXPECTED_PORTS_MAX = 30;
export const MAINTENANCE_WINDOW_MAX = 120;

export const containerNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/, 'Имя контейнера: буквы, цифры, точка, дефис, подчёркивание');
export const portNumberSchema = z.coerce.number().int().min(1).max(65_535);

export const serverProfileSchema = z.object({
  /** Роль в схеме парка; null — не указана. */
  role: z.enum(SERVER_ROLES).nullable(),
  /** Насколько важен сервер: критичному Джарвис ничего рискованного не предлагает без предупреждения. */
  importance: z.enum(SERVER_IMPORTANCE),
  /** Когда можно ставить обновления и перезагружать, свободным текстом; null — не указано. */
  maintenanceWindow: z.string().nullable(),
  /** Контейнеры, которые должны быть запущены (имена в Docker). */
  expectedContainers: z.array(z.string()),
  /** Порты, которые должны слушаться на сервере. */
  expectedPorts: z.array(z.number().int()),
});
export type ServerProfile = z.infer<typeof serverProfileSchema>;

export const DEFAULT_SERVER_PROFILE: ServerProfile = {
  role: null,
  importance: 'normal',
  maintenanceWindow: null,
  expectedContainers: [],
  expectedPorts: [],
};

/** Что можно менять в профиле: каждое поле отдельно; списки заменяются целиком. */
export const serverProfilePatchSchema = z.object({
  role: z.enum(SERVER_ROLES).nullable().optional(),
  importance: z.enum(SERVER_IMPORTANCE).optional(),
  maintenanceWindow: z.string().trim().max(MAINTENANCE_WINDOW_MAX).nullable().optional(),
  expectedContainers: z
    .array(containerNameSchema)
    .max(EXPECTED_CONTAINERS_MAX, `До ${EXPECTED_CONTAINERS_MAX} контейнеров`)
    .optional(),
  expectedPorts: z
    .array(portNumberSchema)
    .max(EXPECTED_PORTS_MAX, `До ${EXPECTED_PORTS_MAX} портов`)
    .optional(),
});
export type ServerProfilePatch = z.infer<typeof serverProfilePatchSchema>;

/** Снимок фактического состояния сервера по SSH (раз в сутки и по кнопке). */
export const serverInventorySchema = z.object({
  at: z.iso.datetime({ offset: true }),
  /** Docker найден на сервере. */
  docker: z.boolean(),
  containers: z.array(z.object({ name: z.string(), state: z.string(), restarts: z.number().int().min(0) })),
  ports: z.array(
    z.object({
      proto: z.enum(['tcp', 'udp']),
      port: z.number().int(),
      process: z.string().nullable(),
      /** Слушает на всех адресах, а не только на localhost. */
      exposed: z.boolean(),
    }),
  ),
});
export type ServerInventory = z.infer<typeof serverInventorySchema>;

export const DRIFT_KINDS = ['container_missing', 'container_not_running', 'port_not_listening'] as const;
export type DriftKind = (typeof DRIFT_KINDS)[number];
export const serverDriftItemSchema = z.object({
  kind: z.enum(DRIFT_KINDS),
  /** Имя контейнера или номер порта. */
  subject: z.string(),
  /** Готовая фраза для человека. */
  detail: z.string(),
});
export type ServerDriftItem = z.infer<typeof serverDriftItemSchema>;

/** Расхождения ожидаемого и фактического; без снимка сравнивать не с чем, список пуст. */
export function computeDrift(
  profile: Pick<ServerProfile, 'expectedContainers' | 'expectedPorts'>,
  inventory: Pick<ServerInventory, 'docker' | 'containers' | 'ports'> | null,
): ServerDriftItem[] {
  if (!inventory) return [];
  const out: ServerDriftItem[] = [];
  for (const name of profile.expectedContainers) {
    const found = inventory.containers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!found)
      out.push({
        kind: 'container_missing',
        subject: name,
        detail: inventory.docker
          ? `Контейнера «${name}» нет на сервере.`
          : `Контейнера «${name}» нет: на сервере не найден Docker.`,
      });
    else if (found.state !== 'running')
      out.push({
        kind: 'container_not_running',
        subject: name,
        detail: `Контейнер «${name}» не работает (состояние: ${found.state}).`,
      });
  }
  for (const port of profile.expectedPorts)
    if (!inventory.ports.some((p) => p.port === port))
      out.push({
        kind: 'port_not_listening',
        subject: String(port),
        detail: `Порт ${port} никто не слушает.`,
      });
  return out;
}

/** Приводим списки профиля к порядку: без повторов, порты по возрастанию, имена по алфавиту. */
export function normalizeProfilePatch(patch: ServerProfilePatch): ServerProfilePatch {
  return {
    ...patch,
    ...(patch.expectedContainers
      ? { expectedContainers: [...new Set(patch.expectedContainers.map((c) => c.trim()))].sort() }
      : {}),
    ...(patch.expectedPorts
      ? { expectedPorts: [...new Set(patch.expectedPorts)].sort((a, b) => a - b) }
      : {}),
    ...(patch.maintenanceWindow !== undefined
      ? { maintenanceWindow: patch.maintenanceWindow?.trim() ? patch.maintenanceWindow.trim() : null }
      : {}),
  };
}

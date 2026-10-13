import { z } from 'zod';
export const bsRentalTargetSchema = z.object({
  host: z.string().trim().min(3).max(253),
  port: z.number().int().min(1).max(65535),
  weight: z.number().int().min(1).max(256).default(1),
  backup: z.boolean().default(false),
});
export const bsRentalTargetsInputSchema = z
  .object({ targets: z.array(bsRentalTargetSchema).min(1).max(5) })
  .strict();
export const bsRentalSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  endpoint: z.string(),
  proto: z.enum(['tcp', 'udp']),
  status: z.string(),
  label: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  expires_at: z.string().nullable(),
  tier: z.object({ code: z.string(), label: z.string() }),
  targets: z.array(bsRentalTargetSchema),
  traffic: z.object({
    unlimited: z.boolean(),
    quota_gb: z.number().nullable(),
    used_gb: z.number(),
    left_gb: z.number().nullable(),
    used_pct: z.number().nullable(),
  }),
  config: z.object({
    desired_version: z.number(),
    applied_version: z.number(),
    in_sync: z.boolean(),
    node_online: z.boolean(),
  }),
  health: z.object({
    up: z.boolean().nullable(),
    active: z.string().nullable(),
    checked_at: z.string().nullable(),
    primary_rtt_ms: z.number().nullable().optional(),
    backup_rtt_ms: z.number().nullable().optional(),
  }),
  can_check: z.boolean(),
});
export type BsRental = z.infer<typeof bsRentalSchema>;
export type BsRentalTarget = z.infer<typeof bsRentalTargetSchema>;
/** unreadable — сколько точек сервис прислал в непонятном виде: остальные всё равно показываются. */
export const bsRentalsSchema = z.object({
  rentals: z.array(bsRentalSchema),
  unreadable: z.number().int().min(0).default(0),
});
export const bsRentalChangePreviewSchema = z.object({
  id: z.uuid(),
  rentalId: z.string(),
  before: z.array(bsRentalTargetSchema),
  after: z.array(bsRentalTargetSchema),
  expiresAt: z.string(),
});
export const bsRentalChangeResultSchema = z.object({
  status: z.enum(['submitted', 'uncertain']),
  changed: z.boolean().nullable(),
  version: z.number().nullable(),
  warnings: z.array(z.string()),
});
export const bsRentalCheckSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  results: z.array(
    z.object({
      role: z.string(),
      ip: z.string(),
      port: z.number(),
      backup: z.boolean(),
      ok: z.boolean().nullable(),
      rtt_ms: z.number().nullable().optional(),
      err: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
    }),
  ),
});

/** Сервер (выход) точки WebSocket: адрес, вес, лимит подключений, запасной ли, включён ли и как он сейчас. */
export const bsWsExitSchema = z.object({
  host: z.string(),
  ip: z.string().nullable().optional(),
  port: z.number(),
  weight: z.number().nullable().optional(),
  max_connections: z.number().nullable().optional(),
  backup: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** up | degraded | down | disabled | unknown */
  state: z.string().nullable().optional(),
  since: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
});
/** Точка входа WebSocket (/v1/ws, «WS-41»): у неё свои серверы, адреса моста и сертификат. */
export const bsWsSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  label: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  /** pending | waiting | active | expired | admin | maintenance | gone | released */
  state: z.string(),
  tier: z.object({ code: z.string(), label: z.string() }).nullable().optional(),
  mbit: z.number().nullable().optional(),
  traffic: z.object({ used_gb: z.number().nullable().optional() }).nullable().optional(),
  starts_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  delete_at: z.string().nullable().optional(),
  autorenew: z.object({ enabled: z.boolean(), days: z.number().nullable().optional() }).nullable().optional(),
  applied: z.boolean().nullable().optional(),
  ready: z.boolean().nullable().optional(),
  issue: z.string().nullable().optional(),
  balancing: z.string().nullable().optional(),
  health_check: z.string().nullable().optional(),
  exits: z.array(bsWsExitSchema).default([]),
  /** Адреса моста BS Checker: порт сервера открывать только им. */
  bridges: z.array(z.string()).default([]),
  bridges_changed_at: z.string().nullable().optional(),
  cert: z
    .object({
      issued: z.union([z.string(), z.boolean()]).nullable().optional(),
      expires_at: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type BsWs = z.infer<typeof bsWsSchema>;
export type BsWsExit = z.infer<typeof bsWsExitSchema>;
export const bsWsListSchema = z.object({
  ws: z.array(bsWsSchema),
  unreadable: z.number().int().min(0).default(0),
});
export const bsWsExitInputSchema = z.object({
  host: z.string().trim().min(3).max(253),
  port: z.number().int().min(1).max(65535),
  weight: z.number().int().min(1).max(100).default(1),
  max_connections: z.number().int().min(1).max(100000).nullable().default(null),
  backup: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type BsWsExitInput = z.infer<typeof bsWsExitInputSchema>;
export const bsWsExitsInputSchema = z
  .object({
    exits: z.array(bsWsExitInputSchema).min(1).max(16),
    balancing: z.enum(['weighted', 'sticky']).optional(),
    health_check: z.enum(['fast', 'standard', 'tolerant']).optional(),
  })
  .strict();
export const bsWsChangePreviewSchema = z.object({
  id: z.uuid(),
  wsId: z.string(),
  before: z.array(bsWsExitInputSchema),
  after: z.array(bsWsExitInputSchema),
  expiresAt: z.string(),
});
export const bsWsChangeResultSchema = z.object({
  status: z.enum(['submitted', 'uncertain']),
  applied: z.boolean().nullable(),
  warnings: z.array(z.string()),
});
/**
 * Настройки подключения точки WebSocket — секреты (путь точки работает как пароль, в inbound — ключ сертификата).
 * Нужно право ключа «Может менять адреса точек аренды».
 */
export const bsWsConnectSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  address: z.string().nullable().optional(),
  host: z
    .object({
      address: z.string().nullable().optional(),
      port: z.number().nullable().optional(),
      security: z.string().nullable().optional(),
      network: z.string().nullable().optional(),
      sni: z.string().nullable().optional(),
      host: z.string().nullable().optional(),
      path: z.string().nullable().optional(),
      alpn: z
        .union([z.string(), z.array(z.string())])
        .nullable()
        .optional(),
      fingerprint: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  inbound_ready: z.boolean().nullable().optional(),
  inbound_wait: z.string().nullable().optional(),
  inbound_port: z.number().nullable().optional(),
  inbound: z.unknown().optional(),
  bridges: z.array(z.string()).default([]),
  firewall: z
    .object({
      ips: z.array(z.string()).default([]),
      by_port: z
        .array(
          z.object({
            port: z.number(),
            ufw: z.string().nullable().optional(),
            nftables: z.string().nullable().optional(),
            check: z.string().nullable().optional(),
            rollback: z.string().nullable().optional(),
          }),
        )
        .default([]),
    })
    .nullable()
    .optional(),
  cert: z
    .object({
      issued: z.union([z.string(), z.boolean()]).nullable().optional(),
      expires_at: z.string().nullable().optional(),
      names: z.array(z.string()).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type BsWsConnect = z.infer<typeof bsWsConnectSchema>;

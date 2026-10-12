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
export const bsRentalsSchema = z.object({ rentals: z.array(bsRentalSchema) });
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

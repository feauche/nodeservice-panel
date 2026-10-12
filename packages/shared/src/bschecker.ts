import { z } from 'zod';
export const bsProbeInputSchema = z
  .object({
    ip: z.string().trim().min(3).max(253),
    port: z.number().int().min(1).max(65535),
    operators: z.array(z.string().min(1).max(160)).min(1, 'Выберите хотя бы одну единицу проверки').max(100),
    icmp: z.boolean(),
    tcp: z.boolean(),
  })
  .strict()
  .refine((v) => v.icmp || v.tcp, 'Выберите TCP или ICMP');
export type BsProbeInput = z.infer<typeof bsProbeInputSchema>;
export const bsAccountSchema = z.object({
  balanceCredits: z.number(),
  bonusCredits: z.number(),
  totalCredits: z.number(),
  tier: z.string(),
  tierExpiresAt: z.string().nullable(),
});
export const bsUnitSchema = z.object({
  op_key: z.string(),
  operator: z.string(),
  name: z.string(),
  region: z.string(),
  dpi: z.string().transform((v) => (v === 'on' || v === 'off' ? v : 'unknown')),
  channel_state: z.string(),
  probeable: z.boolean(),
});
export const bsWorkspaceSchema = z.object({
  account: bsAccountSchema,
  units: z.array(bsUnitSchema),
  unitsError: z.string().nullable().optional(),
});
export const bsPreviewSchema = z.object({
  id: z.uuid(),
  costCredits: z.number().int().min(0),
  units: z.array(z.string()),
  expiresAt: z.string(),
});
export const bsRunSchema = z.object({
  id: z.uuid(),
  status: z.enum(['ready', 'running', 'done', 'uncertain', 'failed']),
  costCredits: z.number().nullable(),
  refundedCredits: z.number().nullable(),
  error: z.string().nullable(),
  skippedCount: z.number().int().min(0).optional(),
  rows: z.array(
    z.object({
      unit: z.string(),
      operator: z.string(),
      region: z.string(),
      dpi: z.string(),
      tcp: z.boolean().nullable(),
      icmp: z.boolean().nullable(),
      tcpIsTls: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});
export type BsRun = z.infer<typeof bsRunSchema>;

export const bsHistorySchema = z.object({
  runs: z.array(
    z.object({
      run: bsRunSchema,
      target: z.string(),
      createdAt: z.string(),
      units: z.number().int().min(0),
      estimatedCredits: z.number(),
    }),
  ),
});
export type BsHistoryEntry = z.infer<typeof bsHistorySchema>['runs'][number];

import { z } from 'zod';
export const bsProbeInputSchema = z
  .object({
    nodeUuid: z.uuid().optional(),
    ip: z.string().trim().min(3).max(253),
    port: z.number().int().min(1).max(65535),
    operators: z.array(z.string().min(1).max(160)).min(1, 'Выберите хотя бы одну единицу проверки').max(100),
    icmp: z.boolean(),
    tcp: z.boolean(),
    /** Имя для проверки TLS-SNI: проверка SNI идёт только с ним. */
    sniHost: z.string().trim().min(3).max(253).optional(),
  })
  .strict()
  .refine((v) => v.icmp || v.tcp || Boolean(v.sniHost), 'Выберите TCP, ICMP или SNI');
export type BsProbeInput = z.infer<typeof bsProbeInputSchema>;
export const bsAccountSchema = z.object({
  balanceCredits: z.number(),
  bonusCredits: z.number(),
  totalCredits: z.number(),
  tier: z.string(),
  tierExpiresAt: z.string().nullable(),
});
/** Единица проверки = оператор × федеральный округ × белый список; op_key «mts|цфо|off» (API 1.1). */
export const bsUnitSchema = z.object({
  op_key: z.string(),
  operator: z.string(),
  name: z.string(),
  region: z.string(),
  /** Латинский код округа: cfo, szfo, yufo, skfo, pfo, urfo, sfo, dfo, krym, kgd. */
  region_code: z.string().default(''),
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
  /** Цена без скидки уровня и сама скидка: «Platinum, −15 %»; null — сервис не прислал. */
  fullCredits: z.number().nullable().default(null),
  discountPct: z.number().nullable().default(null),
  levelName: z.string().nullable().default(null),
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
      /** Проверка SNI точкой: true — прошла по всем именам, false — не прошла, null — не заказывали или нет данных. */
      sni: z.boolean().nullable().default(null),
      /** Задержка TCP или ICMP в миллисекундах; null — сервис не прислал. */
      latency: z.number().nullable().default(null),
      /** Точка не смогла разрешить домен цели — замеров нет. */
      dnsFail: z.boolean().default(false),
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
      /** Нода, если проверяли её адрес; точки (op_key) — чтобы «Проверить снова» с тем же набором. */
      nodeName: z.string().nullable().default(null),
      /** Имя, с которым заказывали проверку SNI; null — SNI не заказывали. */
      sniHost: z.string().nullable().default(null),
      operators: z.array(z.string()).default([]),
    }),
  ),
});
export type BsHistoryEntry = z.infer<typeof bsHistorySchema>['runs'][number];

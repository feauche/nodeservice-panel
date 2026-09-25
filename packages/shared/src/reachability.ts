import { z } from 'zod';

/** Проверка доступности адреса снаружи: с чего проверяли и что увидели (R4.4). */
export const REACH_VERDICTS = ['reachable', 'closed_everywhere', 'partial', 'unknown'] as const;
export const reachabilityResultSchema = z.object({
  target: z.object({ name: z.string(), address: z.string() }),
  probes: z.array(
    z.object({
      from: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
      ports: z.array(z.object({ port: z.number().int(), open: z.boolean(), ms: z.number().nullable() })),
      dns: z.string().nullable(),
    }),
  ),
  ports: z.array(
    z.object({
      port: z.number().int(),
      open: z.number().int(),
      closed: z.number().int(),
      verdict: z.enum(REACH_VERDICTS),
      text: z.string(),
    }),
  ),
  dns: z.object({ answers: z.array(z.string()), consistent: z.boolean() }),
  notes: z.array(z.string()),
});
export type ReachabilityResult = z.infer<typeof reachabilityResultSchema>;

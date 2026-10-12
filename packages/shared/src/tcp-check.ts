import { z } from 'zod';
export const tcpVerdictSchema = z.enum(['reachable', 'russia_unreachable', 'port_unreachable', 'unknown']);
const tcpObservationSchema = z.object({
  node: z.string(),
  country: z.string(),
  city: z.string(),
  state: z.enum(['ok', 'failed', 'pending']),
  error: z.string().nullable(),
});
const base = z.object({
  verdict: tcpVerdictSchema,
  checkedAt: z.string(),
  target: z.string(),
  link: z.string().nullable(),
  observations: z.array(tcpObservationSchema),
  error: z.string().nullable(),
});
export const tcpCheckReportSchema = base.extend({ ports: z.array(base).optional() });
export type TcpCheckReport = z.infer<typeof tcpCheckReportSchema>;
export const nodeTcpDiagnosticsSchema = z.object({
  source: z.literal('checkhost'),
  report: tcpCheckReportSchema,
  online: z.object({ before: z.number(), after: z.number() }).optional(),
});
export type NodeTcpDiagnostics = z.infer<typeof nodeTcpDiagnosticsSchema>;

export const nodeTcpHistorySchema = z.object({
  checks: z.array(z.object({ id: z.uuid(), report: tcpCheckReportSchema })),
});

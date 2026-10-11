import { z } from 'zod';
export const dpiCheckSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
  cost: z.number().nullable(),
  total: z.number(),
  success: z.number().nullable(),
  results: z.array(
    z.object({ location: z.string(), accessible: z.boolean().nullable(), latency: z.number().nullable() }),
  ),
  node: z.object({ uuid: z.string(), name: z.string(), panel: z.string() }).nullable().optional(),
});
export const dpiScheduleSchema = z.object({
  enabled: z.boolean(),
  minutes: z.number(),
  nodes: z.array(z.string()),
  pops: z.array(z.number()),
  nextAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export const dpiWorkspaceSchema = z.object({
  checks: z.array(dpiCheckSchema),
  pops: z.array(z.object({ id: z.number(), name: z.string(), provider: z.string() })),
  schedule: dpiScheduleSchema,
});
export const dnsRecordSchema = z.object({
  id: z.string(),
  provider: z.enum(['cloudflare', 'regru']),
  zone: z.string(),
  zoneId: z.string(),
  recordId: z.string(),
  name: z.string(),
  subname: z.string(),
  type: z.string(),
  content: z.string(),
  ttl: z.number(),
  nodes: z.array(z.object({ uuid: z.string(), name: z.string(), address: z.string() })),
});
export const dnsWorkspaceSchema = z.object({
  domains: z.array(z.object({ name: z.string(), provider: z.string(), hosts: z.array(z.string()) })),
  records: z.array(dnsRecordSchema),
  unmanaged: z.array(z.string()),
  errors: z.array(z.string()),
  checkedAt: z.string(),
  settings: z.object({
    automaticNodes: z.array(z.string()),
    automaticRecords: z.array(z.string()).default([]),
  }),
});
export const dnsHistorySchema = z.object({
  items: z.array(
    z.object({
      at: z.string(),
      domain: z.string(),
      provider: z.string(),
      old: z.string(),
      next: z.string(),
      status: z.string(),
      automatic: z.boolean(),
    }),
  ),
});
export type DpiCheck = z.infer<typeof dpiCheckSchema>;
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

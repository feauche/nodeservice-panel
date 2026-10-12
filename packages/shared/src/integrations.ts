import { z } from 'zod';
export const integrationProviderSchema = z.enum(['dpi', 'regru', 'cloudflare', 'bschecker']);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
export const integrationConnectionSchema = z.object({
  apiKey: z.string().trim().min(8).max(4096).optional(),
  username: z.string().trim().min(1).max(256).optional(),
  password: z.string().min(1).max(4096).optional(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;
export const integrationStatusSchema = z.object({
  provider: integrationProviderSchema,
  connected: z.boolean(),
  checkedAt: z.string().nullable(),
  domains: z.array(z.string()),
  balance: z.string().nullable(),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
export const integrationsStatusSchema = z.object({ items: z.array(integrationStatusSchema) });

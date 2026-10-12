import { z } from 'zod';
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
export const monitoringSettingsSchema = z.object({
  enabled: z.boolean(),
  pollSeconds: integer(30, 900),
  apiTimeoutSeconds: integer(5, 60),
  staleAfterMinutes: integer(2, 60),
  dropPercent: integer(30, 100),
  minOnline: integer(5, 10000),
  dropWindowMinutes: integer(5, 240),
  confirmSamples: integer(2, 10),
  recoverySamples: integer(2, 10),
  recoveryPercent: integer(30, 100),
  cpuEnabled: z.boolean(),
  cpuPercent: integer(50, 100),
  memoryEnabled: z.boolean(),
  memoryPercent: integer(50, 100),
  resourceDurationMinutes: integer(1, 60),
  checkHostEnabled: z.boolean(),
  checkHostHours: integer(1, 168),
  checkHostPort: integer(1, 65535),
  checkHostOnDrop: z.boolean(),
  checkHostCooldownMinutes: integer(5, 1440),
});
export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;
export const MONITORING_DEFAULTS: MonitoringSettings = {
  enabled: true, pollSeconds: 60, apiTimeoutSeconds: 15, staleAfterMinutes: 5,
  dropPercent: 80, minOnline: 30, dropWindowMinutes: 60, confirmSamples: 3,
  recoverySamples: 3, recoveryPercent: 70,
  cpuEnabled: true, cpuPercent: 90, memoryEnabled: true, memoryPercent: 90,
  resourceDurationMinutes: 5,
  checkHostEnabled: true, checkHostHours: 24, checkHostPort: 5492,
  checkHostOnDrop: true, checkHostCooldownMinutes: 15,
};
export const monitoringSettingsUpdateSchema = monitoringSettingsSchema.partial().strict();

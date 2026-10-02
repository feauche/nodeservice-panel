import { z } from 'zod';

const version = z.string().regex(/^\d+\.\d+\.\d+$/, 'ожидается версия x.y.z');

export const panelReleaseSchema = z.object({
  currentVersion: version,
  latestVersion: version.nullable(),
  status: z.enum(['current', 'available', 'unavailable']),
  checkedAt: z.iso.datetime(),
  release: z
    .object({
      name: z.string().max(200),
      url: z.url(),
      publishedAt: z.iso.datetime().nullable(),
      notes: z.string().max(12_000).nullable(),
    })
    .nullable(),
});

export type PanelRelease = z.infer<typeof panelReleaseSchema>;

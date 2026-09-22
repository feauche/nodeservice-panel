import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { AuditPage } from '@/features/audit/audit-page';
import { type AuditSearch, auditSearchSchema } from '@/features/audit/audit-search';
import { requireAuth } from '@/features/auth/guards';
import { requireSectionOpen } from '@/lib/stages';

export const Route = createFileRoute('/audit')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/audit');
  },
  validateSearch: (raw: Record<string, unknown>): AuditSearch => auditSearchSchema.parse(raw),
  component: AuditRoute,
});

function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback(
    (patch: Partial<AuditSearch>) =>
      void navigate({
        search: (prev) => {
          const next: Record<string, unknown> = { ...prev, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next as AuditSearch;
        },
        replace: true,
      }),
    [navigate],
  );
  return (
    <AppShell title="Журнал" subtitle="Кто, что и когда сделал в панели — новые записи сверху">
      <AuditPage search={search} onSearch={onSearch} />
    </AppShell>
  );
}

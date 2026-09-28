import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { BillingPage, type BillingView } from '@/features/billing/billing-page';
import { requireSectionOpen } from '@/lib/stages';

interface BillingSearch {
  view?: Exclude<BillingView, 'items'>;
  /** Из уведомления: открыть «Продлить» у этой оплаты. */
  item?: string;
}

/** /servers/billing — оплаты серверов, аренды, доменов и сертификатов (подпункт «Серверы» → «Биллинг»). */
export const Route = createFileRoute('/servers_/billing')({
  validateSearch: (raw: Record<string, unknown>): BillingSearch => ({
    ...(raw.view === 'stats' || raw.view === 'archive' ? { view: raw.view } : {}),
    ...(typeof raw.item === 'string' && /^[0-9a-f-]{36}$/i.test(raw.item) ? { item: raw.item } : {}),
  }),
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
    requireSectionOpen('/servers/billing');
  },
  component: BillingRoute,
});

function BillingRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/servers/billing' });
  const onFocusDone = useCallback(
    () => void navigate({ search: (s) => ({ ...s, item: undefined }), replace: true }),
    [navigate],
  );
  return (
    <AppShell title="Биллинг" subtitle="Что и когда оплачивать: серверы, аренда, домены и сертификаты">
      <BillingPage
        view={search.view ?? 'items'}
        onView={(v) => void navigate({ search: v === 'items' ? {} : { view: v } })}
        focusItem={search.item}
        onFocusDone={onFocusDone}
      />
    </AppShell>
  );
}

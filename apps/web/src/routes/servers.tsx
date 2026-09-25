import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';

import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { openServer } from '@/features/servers/server-modal-store';
import { ServersPage } from '@/features/servers/servers-page';

const serversSearchSchema = z.object({
  /** Открытая модалка сервера (?open=<id>) — ссылку можно переслать. */
  open: z.uuid().optional().catch(undefined),
  tag: z.string().trim().min(1).max(24).optional().catch(undefined),
});

export const Route = createFileRoute('/servers')({
  beforeLoad: ({ context }) => requireAuth(context),
  validateSearch: (raw: Record<string, unknown>) => serversSearchSchema.parse(raw),
  component: ServersRoute,
});

function ServersRoute() {
  const { tag, open } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Ссылка ?open=<id> (закладка, старое уведомление): открываем карточку поверх и убираем параметр.
  // biome-ignore lint/correctness/useExhaustiveDependencies: только при появлении параметра
  useEffect(() => {
    if (!open) return;
    openServer(open);
    void navigate({ search: (prev) => ({ ...prev, open: undefined }), replace: true });
  }, [open]);
  return (
    <AppShell title="Серверы" subtitle="Ноды под управлением панели: доступ по SSH, дальше — агент">
      <ServersPage
        tag={tag}
        onTag={(next) => void navigate({ search: next ? { tag: next } : {}, replace: true })}
      />
    </AppShell>
  );
}

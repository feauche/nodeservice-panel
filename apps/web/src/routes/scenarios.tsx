import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import {
  CreateScenarioButton,
  ScenariosPage,
  type ScenariosSearch,
} from '@/features/scenarios/scenarios-page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ScenariosRoute() {
  // Нажатие «Создать сценарий» в шапке открывает окно нового сценария на странице.
  const [create, setCreate] = useState(0);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppShell
      title="Сценарии"
      subtitle="Сами выполняют шаги, когда с нодой что-то случилось. Проверки бесплатные."
      // Справа в шапке, как в витрине (вариант C); «actions» прижал бы кнопку к заголовку.
      aside={<CreateScenarioButton onClick={() => setCreate((n) => n + 1)} />}
    >
      <ScenariosPage
        createSignal={create}
        search={search}
        // Окно открыто по ссылке (из окна ноды) — адрес очищается, чтобы обновление страницы не открыло его снова.
        clearSearch={() => void navigate({ search: {}, replace: true })}
      />
    </AppShell>
  );
}

export const Route = createFileRoute('/scenarios')({
  // Из окна ноды: ?open=<сценарий>&tab=runs&node=<нода> — окно сценария на срабатываниях этой ноды;
  // ?create=1&node=<нода> — новый сценарий для этой ноды.
  validateSearch: (s: Record<string, unknown>): ScenariosSearch => ({
    ...(typeof s.open === 'string' && UUID.test(s.open) ? { open: s.open } : {}),
    ...(s.tab === 'rule' || s.tab === 'runs' || s.tab === 'message' ? { tab: s.tab } : {}),
    ...(typeof s.node === 'string' && UUID.test(s.node) ? { node: s.node } : {}),
    ...(s.create === 1 || s.create === '1' ? { create: 1 as const } : {}),
  }),
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
  },
  component: ScenariosRoute,
});

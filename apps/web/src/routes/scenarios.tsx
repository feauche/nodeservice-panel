import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { CreateScenarioButton, ScenariosPage } from '@/features/scenarios/scenarios-page';

function ScenariosRoute() {
  // Нажатие «Создать сценарий» в шапке открывает окно нового сценария на странице.
  const [create, setCreate] = useState(0);
  return (
    <AppShell
      title="Сценарии"
      subtitle="Сами выполняют шаги, когда с нодой что-то случилось. Проверки бесплатные."
      // Справа в шапке, как в витрине (вариант C); «actions» прижал бы кнопку к заголовку.
      aside={<CreateScenarioButton onClick={() => setCreate((n) => n + 1)} />}
    >
      <ScenariosPage createSignal={create} />
    </AppShell>
  );
}

export const Route = createFileRoute('/scenarios')({
  beforeLoad: async ({ context }) => {
    await requireAuth(context);
  },
  component: ScenariosRoute,
});

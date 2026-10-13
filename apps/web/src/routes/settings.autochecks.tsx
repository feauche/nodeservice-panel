import { createFileRoute, redirect } from '@tanstack/react-router';

/** Старый адрес раздела «Автопроверки нод» (до 0.93.0): сохранённые ссылки ведут в «Мониторинг нод». */
export const Route = createFileRoute('/settings/autochecks')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/monitoring', replace: true });
  },
});

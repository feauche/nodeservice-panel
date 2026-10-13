import { MonitoringPage } from './monitoring-page';

/** «Настройки → Мониторинг нод» (до 0.93.0 — «Автопроверки нод»): опрос Remnawave и проверки портов. */
export function NodeMonitoringPage() {
  return <MonitoringPage section="checks" />;
}

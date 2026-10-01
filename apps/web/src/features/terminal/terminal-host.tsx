import { createPortal } from 'react-dom';

import { useTerminalStore } from './terminal-store';
import { TerminalWindow } from './terminal-window';

/**
 * Точка монтирования веб-терминала: одно окно на всё приложение.
 * Портал в body — окно живёт в координатах вьюпорта (не в сдвинутом сайдбаром контенте)
 * и по слою оказывается над модалкой сервера. key по серверу пересоздаёт окно.
 * `hidden` — экран заблокирован: окно прячется и недоступно для фокуса, но не размонтируется —
 * сокет и SSH-сессия продолжают работать, после разблокировки окно на прежнем месте. Ввод до
 * разблокировки сервер всё равно не примет: атрибуты в браузере снимаются из инструментов разработчика.
 */
export function TerminalHost({ hidden = false }: { hidden?: boolean }) {
  const server = useTerminalStore((s) => s.server);
  const close = useTerminalStore((s) => s.close);
  if (server === null || typeof document === 'undefined') return null;
  return createPortal(
    // Обёртка в левом верхнем углу, как сам body: react-rnd отсчитывает положение окна от родителя,
    // и обёртка в потоке страницы (под всем приложением) унесла бы окно за нижний край экрана.
    <div hidden={hidden} inert={hidden} className="absolute top-0 left-0">
      <TerminalWindow key={server.id} server={server} onClose={close} hidden={hidden} />
    </div>,
    document.body,
  );
}

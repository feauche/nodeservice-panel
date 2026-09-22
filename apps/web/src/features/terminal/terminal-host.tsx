import { createPortal } from 'react-dom';

import { useTerminalStore } from './terminal-store';
import { TerminalWindow } from './terminal-window';

/**
 * Точка монтирования веб-терминала: одно окно на всё приложение.
 * Портал в body — окно живёт в координатах вьюпорта (не в сдвинутом сайдбаром контенте)
 * и по слою оказывается над модалкой сервера. key по серверу пересоздаёт окно.
 */
export function TerminalHost() {
  const server = useTerminalStore((s) => s.server);
  const close = useTerminalStore((s) => s.close);
  if (server === null || typeof document === 'undefined') return null;
  return createPortal(<TerminalWindow key={server.id} server={server} onClose={close} />, document.body);
}

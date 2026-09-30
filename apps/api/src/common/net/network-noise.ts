/** Коды ошибок сети и оборванных потоков: соединение пропало, состояние панели не повреждено. */
const CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Обрыв сети, долетевший событием 'error' без слушателя (ssh2, WebSocket, сокеты): после него панель может
 * работать дальше. Всё остальное — настоящая ошибка программы, после неё процесс должен перезапуститься.
 */
export function isNetworkNoise(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; level?: unknown };
  // ssh2 помечает ошибки соединения полем level: client-socket, client-timeout, protocol.
  if (typeof e.level === 'string' && /^(client-(socket|timeout)|protocol)$/.test(e.level)) return true;
  return typeof e.code === 'string' && (CODES.has(e.code) || e.code.startsWith('WS_ERR_'));
}

import type { Request } from 'express';

import type { SessionRecord } from './session.store.js';

/** Что известно о запросе для аудита и привязки сессии. */
export interface RequestContext {
  ip: string;
  ua: string;
  requestId: string;
}

export function requestContext(req: Request): RequestContext {
  const ua = req.headers['user-agent'];
  const id = (req as { id?: unknown }).id;
  return {
    ip: req.ip ?? req.socket.remoteAddress ?? '',
    ua: typeof ua === 'string' ? ua : '',
    requestId: typeof id === 'string' ? id : '',
  };
}

/** Префикс IP для записи доверенного устройства: /24 для IPv4, /64 для IPv6. */
export function ipPrefix(ip: string): string {
  const v4 = ip.match(/^(?:::ffff:)?(\d+\.\d+\.\d+)\.\d+$/);
  if (v4?.[1]) return `${v4[1]}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
  return ip;
}

/** Поля, которые SessionGuard кладёт в запрос. */
export interface AuthenticatedRequest extends Request {
  session?: SessionRecord;
  user?: { id: string; login: string; createdAt: Date };
}

import { type PeerCertificate, connect as tlsConnect } from 'node:tls';
import { Injectable, Logger } from '@nestjs/common';
import {
  REMNAWAVE_CERT_WARN_DAYS,
  type RemnawaveCert,
  type RemnawaveNode,
  type RemnawaveStats,
} from '@nodeservice/shared';

const FETCH_TIMEOUT_MS = 8_000;
const TLS_TIMEOUT_MS = 8_000;

export class RemnawaveApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unauthorized' | 'unreachable',
  ) {
    super(message);
  }
}

export interface RemnawaveFetched {
  stats: RemnawaveStats;
  nodes: RemnawaveNode[];
}

/** Обёртка над публичным API Remnawave. В тестах подменяется. */
export interface RemnawaveClient {
  fetch(domain: string, apiKey: string): Promise<RemnawaveFetched>;
  /** Срок TLS-сертификата самого домена панели Remnawave — своя проверка, не через API Remnawave. */
  checkCertificate(domain: string): Promise<RemnawaveCert>;
}
export const REMNAWAVE_CLIENT = Symbol('REMNAWAVE_CLIENT');

async function getJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RemnawaveApiError(`Remnawave (${url}) не отвечает: ${(err as Error).message}`, 'unreachable');
  }
  if (res.status === 401 || res.status === 403)
    throw new RemnawaveApiError(
      'Remnawave ответила «доступ запрещён»: токен неверный, отозван или просрочен.',
      'unauthorized',
    );
  if (!res.ok)
    throw new RemnawaveApiError(`Remnawave (${url}) ответила ошибкой: HTTP ${res.status}.`, 'unreachable');
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new RemnawaveApiError(`Remnawave (${url}) ответила не тем, что мы ждали (не JSON).`, 'unreachable');
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

@Injectable()
export class HttpRemnawaveClient implements RemnawaveClient {
  private readonly log = new Logger(HttpRemnawaveClient.name);

  async fetch(domain: string, apiKey: string): Promise<RemnawaveFetched> {
    const base = `https://${domain}`;
    const [statsBody, nodesBody, metricsBody, metaBody] = await Promise.all([
      getJson(`${base}/api/system/stats`, apiKey),
      getJson(`${base}/api/nodes`, apiKey),
      getJson(`${base}/api/system/nodes/metrics`, apiKey),
      getJson(`${base}/api/system/metadata`, apiKey),
    ]);
    const s = (statsBody.response ?? {}) as Record<string, unknown>;
    const users = (s.users ?? {}) as Record<string, unknown>;
    const counts = (users.statusCounts ?? {}) as Record<string, unknown>;
    const online = (s.onlineStats ?? {}) as Record<string, unknown>;
    const nodesStat = (s.nodes ?? {}) as Record<string, unknown>;
    const nodesRaw = (nodesBody.response as unknown[] | undefined) ?? [];
    // «nodes.totalOnline» в /system/stats на деле не число нод на связи (это число сессий/подключений;
    // проверено на боевой панели: там было в сотни раз больше, чем реальных нод) — считаем сами по списку нод.
    const nodesOnline = nodesRaw.filter((raw) => {
      const n = raw as Record<string, unknown>;
      return Boolean(n.isConnected) && !n.isDisabled;
    }).length;
    const stats: RemnawaveStats = {
      users: {
        total: num(users.totalUsers),
        active: num(counts.ACTIVE),
        disabled: num(counts.DISABLED),
        limited: num(counts.LIMITED),
        expired: num(counts.EXPIRED),
      },
      online: {
        now: num(online.onlineNow),
        lastDay: num(online.lastDay),
        lastWeek: num(online.lastWeek),
        never: num(online.neverOnline),
      },
      nodesOnline,
      nodesTotal: nodesRaw.length,
      trafficBytesLifetime: str(nodesStat.totalBytesLifetime) || '0',
      panelVersion: str((metaBody.response as Record<string, unknown> | undefined)?.version) || '—',
      panelUptimeSec: num(s.uptime),
    };
    const metricsByUuid = new Map<string, number>();
    for (const m of (metricsBody.response as { nodes?: unknown[] } | undefined)?.nodes ?? []) {
      const row = m as Record<string, unknown>;
      metricsByUuid.set(str(row.nodeUuid), num(row.usersOnline));
    }
    const nodes: RemnawaveNode[] = nodesRaw.map((raw) => {
      const n = raw as Record<string, unknown>;
      const uuid = str(n.uuid);
      return {
        uuid,
        name: str(n.name),
        address: str(n.address),
        countryCode: typeof n.countryCode === 'string' && n.countryCode ? n.countryCode : null,
        isConnected: Boolean(n.isConnected),
        isDisabled: Boolean(n.isDisabled),
        isConnecting: Boolean(n.isConnecting),
        lastStatusMessage: typeof n.lastStatusMessage === 'string' ? n.lastStatusMessage : null,
        // Нет строки метрик у отключённой ноды — это «неприменимо» (null); у включённой это просто
        // «сейчас никто не подключён» (0), а не «нет данных» — иначе панель у активной ноды вообще
        // ничего не показывала бы вместо честного нуля.
        usersOnline: metricsByUuid.has(uuid) ? (metricsByUuid.get(uuid) ?? 0) : n.isDisabled ? null : 0,
        trafficUsedBytes: typeof n.trafficUsedBytes === 'number' ? n.trafficUsedBytes : null,
        trafficLimitBytes: typeof n.trafficLimitBytes === 'number' ? n.trafficLimitBytes : null,
      };
    });
    return { stats, nodes };
  }

  async checkCertificate(domain: string): Promise<RemnawaveCert> {
    if (process.env.NODE_ENV === 'test')
      return {
        status: 'unknown',
        expiresAt: null,
        daysLeft: null,
        note: 'В тестовом окружении не проверяется.',
      };
    const host = domain.split(':')[0] ?? domain;
    const port = Number(domain.split(':')[1] ?? 443);
    try {
      const cert = await new Promise<PeerCertificate>((resolve, reject) => {
        const socket = tlsConnect({ host, port, servername: host, timeout: TLS_TIMEOUT_MS }, () => {
          const c = socket.getPeerCertificate();
          socket.end();
          if (!c || Object.keys(c).length === 0) reject(new Error('сертификат не отдан'));
          else resolve(c);
        });
        socket.on('error', reject);
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('таймаут подключения'));
        });
      });
      const expiresAt = new Date(cert.valid_to);
      const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
      return {
        status: daysLeft < 0 ? 'expired' : daysLeft <= REMNAWAVE_CERT_WARN_DAYS ? 'warn' : 'ok',
        expiresAt: expiresAt.toISOString(),
        daysLeft,
        note: null,
      };
    } catch (err) {
      this.log.debug(`Сертификат ${host}:${port}: ${(err as Error).message}`);
      return {
        status: 'unknown',
        expiresAt: null,
        daysLeft: null,
        note: 'Не удалось проверить сертификат панели по HTTPS.',
      };
    }
  }
}

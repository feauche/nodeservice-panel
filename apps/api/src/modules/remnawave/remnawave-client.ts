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

export type RemnawaveProfileKind = 'node' | 'xray_json';

export interface RemnawaveProfileCatalog {
  node: Record<string, unknown>[];
  xrayJson: Record<string, unknown>[];
}

/**
 * SNI (маскировка) и порт активного инбаунда Reality у ноды — не часть публичного статуса
 * (фронтенду не нужно), нужно только для проверки блокировок (J10): без него панель не знает,
 * с каким именем сайта прикидывается нода снаружи, и не сможет повторить настоящее TLS-подключение.
 * null — нет активного инбаунда Reality (например, только Shadowsocks) или его не удалось разобрать.
 */
export interface RemnawaveNodeInbound {
  sni: string | null;
  port: number | null;
  /** Нужны, чтобы UDP-инбаунд Hysteria2 не проверялся как обычный TCP-порт. */
  protocol: string | null;
  network: string | null;
  /** Remnawave не ответила на запрос: порт неизвестен, но это не значит, что его у ноды нет. */
  failed?: boolean;
}

/** Обёртка над публичным API Remnawave. В тестах подменяется. */
export interface RemnawaveClient {
  fetch(domain: string, apiKey: string): Promise<RemnawaveFetched>;
  /** Срок TLS-сертификата самого домена панели Remnawave — своя проверка, не через API Remnawave. */
  checkCertificate(domain: string): Promise<RemnawaveCert>;
  /** SNI и порт для проверки блокировки этой ноды; вызывается только когда проверка реально нужна. */
  findNodeInbound(domain: string, apiKey: string, nodeUuid: string): Promise<RemnawaveNodeInbound | null>;
  /** Профили конфигурации нод и клиентские Xray JSON-шаблоны. Только чтение. */
  listProfiles(domain: string, apiKey: string): Promise<RemnawaveProfileCatalog>;
  /** Полное содержимое одного профиля; сервис обязан скрыть секреты до передачи Джарвису. */
  getProfile(
    domain: string,
    apiKey: string,
    kind: RemnawaveProfileKind,
    uuid: string,
  ): Promise<Record<string, unknown>>;
}
export const REMNAWAVE_CLIENT = Symbol('REMNAWAVE_CLIENT');

/**
 * Имя сайта-маскировки из сырого инбаунда Xray Reality — форма ровно как в его собственном конфиге
 * (`streamSettings.realitySettings.serverNames` или `dest`, вида "example.com:443"). Панель не хранит
 * и не собирает такой конфиг сама, только читает то, что уже настроено в Remnawave.
 */
function realitySni(rawInbound: unknown): string | null {
  if (!rawInbound || typeof rawInbound !== 'object') return null;
  const stream = (rawInbound as Record<string, unknown>).streamSettings;
  if (!stream || typeof stream !== 'object') return null;
  const reality = (stream as Record<string, unknown>).realitySettings;
  if (!reality || typeof reality !== 'object') return null;
  const r = reality as Record<string, unknown>;
  const names = r.serverNames;
  if (Array.isArray(names) && typeof names[0] === 'string' && names[0]) return names[0].split(':')[0] ?? null;
  if (typeof r.dest === 'string' && r.dest) return r.dest.split(':')[0] ?? null;
  return null;
}

async function getJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RemnawaveApiError(`Remnawave не отвечает: ${connectionErrorText(err)}`, 'unreachable');
  }
  if (res.status === 401 || res.status === 403)
    throw new RemnawaveApiError(
      'Remnawave ответила «доступ запрещён»: токен неверный, отозван или просрочен.',
      'unauthorized',
    );
  if (!res.ok) throw new RemnawaveApiError(`Remnawave ответила ошибкой HTTP ${res.status}.`, 'unreachable');
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new RemnawaveApiError('Remnawave вернула повреждённый ответ вместо данных.', 'unreachable');
  }
}

function errorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    current = record.cause;
  }
  return null;
}

/** Точная русская причина без URL, внутренних имён undici и английского системного текста. */
export function connectionErrorText(err: unknown): string {
  const code = errorCode(err);
  const name = err instanceof Error ? err.name : '';
  if (code === 'CERT_HAS_EXPIRED') return 'TLS-сертификат панели истёк';
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN')
    return 'TLS-сертификат панели самоподписанный и не считается доверенным';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'TLS-сертификат выпущен для другого домена';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'домен не разрешается через DNS';
  if (code === 'ECONNREFUSED') return 'HTTPS-порт панели отклоняет соединение';
  if (code === 'ETIMEDOUT' || name === 'TimeoutError' || name === 'AbortError')
    return `панель не ответила за ${FETCH_TIMEOUT_MS / 1_000} секунд`;
  if (code === 'ECONNRESET') return 'панель оборвала HTTPS-соединение';
  return 'не удалось установить защищённое HTTPS-соединение';
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

  async findNodeInbound(
    domain: string,
    apiKey: string,
    nodeUuid: string,
  ): Promise<RemnawaveNodeInbound | null> {
    const nodesBody = await getJson(`https://${domain}/api/nodes`, apiKey);
    const nodesRaw = (nodesBody.response as unknown[] | undefined) ?? [];
    const raw = nodesRaw.find((r) => str((r as Record<string, unknown>).uuid) === nodeUuid) as
      | Record<string, unknown>
      | undefined;
    if (!raw) return null;
    const configProfile = raw.configProfile as Record<string, unknown> | undefined;
    const inbounds = (configProfile?.activeInbounds as unknown[] | undefined) ?? [];
    const realityInbound = inbounds.find((i) => (i as Record<string, unknown>).security === 'reality') as
      | Record<string, unknown>
      | undefined;
    // Нет Reality — имени маскировки нет, но порт любого активного инбаунда всё равно пригодится:
    // по нему встречная проверка хотя бы скажет, доступна ли нода вообще.
    const inbound = (realityInbound ??
      inbounds.find((i) => typeof (i as Record<string, unknown>).port === 'number')) as
      | Record<string, unknown>
      | undefined;
    if (!inbound) return null;
    let sni = realityInbound ? realitySni(realityInbound.rawInbound) : null;
    // Список нод может отдавать инбаунды без сырого конфига — тогда берём имя из самого профиля
    // конфигурации (тот же конфиг Xray, где у selfsteal прописан свой домен в serverNames).
    if (realityInbound && !sni) {
      const profileUuid =
        str(realityInbound.profileUuid) || str(configProfile?.activeConfigProfileUuid) || null;
      if (profileUuid) sni = await this.profileSni(domain, apiKey, profileUuid, str(realityInbound.tag));
    }
    const port = typeof inbound.port === 'number' ? inbound.port : num(raw.port) || null;
    return {
      sni,
      port,
      protocol: str(inbound.type) || null,
      network: str(inbound.network) || null,
    };
  }

  async listProfiles(domain: string, apiKey: string): Promise<RemnawaveProfileCatalog> {
    const base = `https://${domain}`;
    const [configBody, templateBody] = await Promise.all([
      getJson(`${base}/api/config-profiles`, apiKey),
      getJson(`${base}/api/subscription-templates`, apiKey),
    ]);
    const configResponse = (configBody.response ?? {}) as Record<string, unknown>;
    const templateResponse = (templateBody.response ?? {}) as Record<string, unknown>;
    const node = Array.isArray(configResponse.configProfiles)
      ? (configResponse.configProfiles as Record<string, unknown>[])
      : [];
    const templates = Array.isArray(templateResponse.templates)
      ? (templateResponse.templates as Record<string, unknown>[])
      : [];
    return {
      node,
      xrayJson: templates.filter((row) => str(row.templateType).toUpperCase() === 'XRAY_JSON'),
    };
  }

  async getProfile(
    domain: string,
    apiKey: string,
    kind: RemnawaveProfileKind,
    uuid: string,
  ): Promise<Record<string, unknown>> {
    const section = kind === 'node' ? 'config-profiles' : 'subscription-templates';
    const body = await getJson(`https://${domain}/api/${section}/${encodeURIComponent(uuid)}`, apiKey);
    return (body.response ?? {}) as Record<string, unknown>;
  }

  /** Имя маскировки из профиля конфигурации по тегу инбаунда; любой сбой — null (проверка деградирует до порта). */
  private async profileSni(
    domain: string,
    apiKey: string,
    profileUuid: string,
    tag: string,
  ): Promise<string | null> {
    try {
      const body = await getJson(
        `https://${domain}/api/config-profiles/${encodeURIComponent(profileUuid)}`,
        apiKey,
      );
      const profile = (body.response ?? {}) as Record<string, unknown>;
      const byTag = (list: unknown) =>
        (Array.isArray(list) ? list : []).find((i) => str((i as Record<string, unknown>).tag) === tag) as
          | Record<string, unknown>
          | undefined;
      const config = profile.config as Record<string, unknown> | undefined;
      const fromConfig = byTag(config?.inbounds);
      if (fromConfig) {
        const sni = realitySni(fromConfig);
        if (sni) return sni;
      }
      const fromList = byTag(profile.inbounds);
      return fromList ? realitySni(fromList.rawInbound) : null;
    } catch {
      return null;
    }
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
        const socket = tlsConnect(
          { host, port, servername: host, timeout: TLS_TIMEOUT_MS, rejectUnauthorized: false },
          () => {
            const c = socket.getPeerCertificate();
            socket.end();
            if (!c || Object.keys(c).length === 0) reject(new Error('сертификат не отдан'));
            else resolve(c);
          },
        );
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
      this.log.debug(`Сертификат ${host}:${port}: ${connectionErrorText(err)}`);
      return {
        status: 'unknown',
        expiresAt: null,
        daysLeft: null,
        note: `Не удалось проверить сертификат панели: ${connectionErrorText(err)}.`,
      };
    }
  }
}

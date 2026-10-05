import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REMNAWAVE_CERT_CHECK_INTERVAL_MIN,
  REMNAWAVE_PROBLEM,
  type RemnawaveConnectRequest,
  type RemnawaveStatus,
} from '@nodeservice/shared';

import { errorText, problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  REMNAWAVE_CLIENT,
  RemnawaveApiError,
  type RemnawaveClient,
  type RemnawaveNodeInbound,
  type RemnawaveProfileKind,
} from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { RemnawaveVpnProbeService } from './remnawave-vpn-probe.service.js';

const HIDDEN = '[скрыто]';
const SECRET_FIELDS = new Set([
  'accesskey',
  'apikey',
  'auth',
  'authorization',
  'certificate',
  'certificates',
  'email',
  'id',
  'key',
  'password',
  'passwd',
  'presharedkey',
  'privatekey',
  'publickey',
  'secret',
  'secretkey',
  'shortid',
  'shortids',
  'token',
  'uuid',
]);
const PRIVATE_LISTS = new Set(['clients', 'users']);

/** Конфиг Remnawave недоверенный и может содержать доступы: до LLM доходит только безопасная копия. */
export function sanitizeRemnawaveProfile(value: unknown, field = '', depth = 0): unknown {
  const key = field.toLowerCase().replace(/[_-]/g, '');
  if (PRIVATE_LISTS.has(key) && Array.isArray(value)) return { hidden: true, count: value.length };
  if (SECRET_FIELDS.has(key)) return value === null || value === undefined ? value : HIDDEN;
  if (depth >= 12) return '[слишком глубокая структура]';
  if (typeof value === 'string') {
    if (/^(?:vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(value)) return HIDDEN;
    const clean = value
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, HIDDEN)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, HIDDEN);
    return clean.length > 2_000 ? `${clean.slice(0, 2_000)}…` : clean;
  }
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeRemnawaveProfile(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([name, item]) => [name, sanitizeRemnawaveProfile(item, name, depth + 1)]),
  );
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];

function profileTags(row: Record<string, unknown>): string[] {
  return Array.isArray(row.tags)
    ? row.tags
        .map((tag) => (typeof tag === 'string' ? tag : text((tag as Record<string, unknown>)?.name)))
        .filter(Boolean)
        .slice(0, 20)
    : [];
}

function inboundBrief(row: Record<string, unknown>): Record<string, unknown> {
  const stream = (row.streamSettings ?? {}) as Record<string, unknown>;
  return {
    tag: text(row.tag) || null,
    protocol: text(row.protocol) || text(row.type) || null,
    port: typeof row.port === 'number' ? row.port : null,
    network: text(row.network) || text(stream.network) || null,
    security: text(row.security) || text(stream.security) || null,
  };
}

function nodeProfileBrief(row: Record<string, unknown>): Record<string, unknown> {
  const config = (row.config ?? {}) as Record<string, unknown>;
  const inbounds = records(config.inbounds).length ? records(config.inbounds) : records(row.inbounds);
  return {
    name: text(row.name) || 'Без имени',
    tags: profileTags(row),
    inbounds: inbounds.map(inboundBrief),
    nodes: records(row.nodes)
      .map((node) => text(node.name))
      .filter(Boolean),
    updatedAt: text(row.updatedAt) || null,
  };
}

function templateBrief(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: text(row.name) || 'Без имени',
    tags: profileTags(row),
    type: text(row.templateType) || 'XRAY_JSON',
    updatedAt: text(row.updatedAt) || null,
  };
}

@Injectable()
export class RemnawaveService {
  private readonly log = new Logger(RemnawaveService.name);
  /** Когда последний раз проверяли сертификат панели (0 — ещё не проверяли после запуска). */
  private certCheckedAt = 0;

  constructor(
    private readonly store: RemnawaveSettingsStore,
    @Inject(REMNAWAVE_CLIENT) private readonly client: RemnawaveClient,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
    private readonly vpnProbe: RemnawaveVpnProbeService,
  ) {}

  /**
   * Онлайн каждой ноды — в VictoriaMetrics (раз в минуту, при каждом чтении Remnawave): из этого строится
   * «Онлайн на нодах» в статистике парка. Недоступная VM ничего не ломает.
   */
  private async recordOnline(
    nodes: Array<{ uuid: string; name: string; usersOnline: number | null }>,
  ): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const clean = (v: string) => v.replace(/["\\\n]/g, '');
    const lines = nodes
      .filter((n) => n.usersOnline !== null)
      .map(
        (n) =>
          `nodeservice_node_online{node_uuid="${clean(n.uuid)}",node_name="${clean(n.name)}"} ${n.usersOnline}`,
      );
    if (lines.length === 0) return;
    try {
      await fetch(`${this.config.get('VM_URL')}/api/v1/import/prometheus`, {
        method: 'POST',
        body: `${lines.join('\n')}\n`,
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // Метрики — не главное: следующая минута запишет снова.
    }
  }

  /** J10: SNI и порт ноды для проверки блокировки — только когда проверка реально запускается. */
  async nodeInbound(nodeUuid: string): Promise<RemnawaveNodeInbound | null> {
    const creds = await this.store.credentials();
    if (!creds) return null;
    try {
      return await this.client.findNodeInbound(creds.domain, creds.apiKey, nodeUuid);
    } catch (err) {
      this.log.warn(`Инбаунд ноды ${nodeUuid}: ${err instanceof Error ? err.message : err}`);
      // Запрос не прошёл — порт неизвестен. Причина «в Remnawave не нашёлся порт» здесь была бы неправдой.
      return { sni: null, port: null, protocol: null, network: null, failed: true };
    }
  }

  /** Каталог или безопасное содержимое профиля для Джарвиса. Никаких изменений в Remnawave. */
  async profilesForAssistant(input: { kind?: unknown; profile?: unknown }): Promise<Record<string, unknown>> {
    const creds = await this.store.credentials();
    if (!creds)
      return {
        connected: false,
        error: 'Remnawave не подключена. Подключить можно в «Серверы → Remnawave».',
      };

    try {
      const catalog = await this.client.listProfiles(creds.domain, creds.apiKey);
      const requestedKind: RemnawaveProfileKind | null =
        input.kind === 'node' || input.kind === 'xray_json' ? input.kind : null;
      const selector = typeof input.profile === 'string' ? input.profile.trim() : '';
      if (!selector)
        return {
          connected: true,
          nodeProfiles: catalog.node.map(nodeProfileBrief),
          xrayJsonProfiles: catalog.xrayJson.map(templateBrief),
          note: 'Это каталог без секретов. Для чтения одной конфигурации вызовите инструмент снова с kind и profile. node — конфигурация Xray на нодах; xray_json — клиентский JSON-шаблон подписки.',
        };

      const choices = [
        ...(requestedKind && requestedKind !== 'node'
          ? []
          : catalog.node.map((row) => ({ kind: 'node' as const, row }))),
        ...(requestedKind && requestedKind !== 'xray_json'
          ? []
          : catalog.xrayJson.map((row) => ({ kind: 'xray_json' as const, row }))),
      ];
      const query = selector.toLowerCase();
      const exact = choices.filter(
        ({ row }) => text(row.uuid).toLowerCase() === query || text(row.name).toLowerCase() === query,
      );
      const matches = exact.length
        ? exact
        : choices.filter(({ row }) => text(row.name).toLowerCase().includes(query));
      if (matches.length !== 1)
        return {
          connected: true,
          error:
            matches.length === 0
              ? `Профиль «${selector}» не найден.`
              : `Название «${selector}» неоднозначно. Уточните полное имя и вид профиля.`,
          available: choices.map(({ kind, row }) => ({ kind, name: text(row.name) || 'Без имени' })),
        };

      const selected = matches[0] as { kind: RemnawaveProfileKind; row: Record<string, unknown> };
      const uuid = text(selected.row.uuid);
      if (!uuid)
        return {
          connected: true,
          error: 'Remnawave вернула профиль без идентификатора; прочитать его нельзя.',
        };
      const full = await this.client.getProfile(creds.domain, creds.apiKey, selected.kind, uuid);
      let content: unknown;
      if (selected.kind === 'node') {
        content = sanitizeRemnawaveProfile(full.config ?? full);
      } else if (typeof full.templateJson === 'string') {
        try {
          content = sanitizeRemnawaveProfile(JSON.parse(full.templateJson));
        } catch {
          content = '[Remnawave вернула Xray JSON не в формате JSON; содержимое скрыто]';
        }
      } else {
        content = sanitizeRemnawaveProfile(full.templateJson ?? full);
      }
      return {
        connected: true,
        kind: selected.kind,
        name: text(full.name) || text(selected.row.name) || 'Без имени',
        tags: profileTags(full),
        config: content,
        safety:
          'Только чтение. UUID пользователей, email, ключи, пароли, токены, сертификаты и списки клиентов скрыты до передачи Джарвису.',
      };
    } catch (err) {
      if (err instanceof RemnawaveApiError && err.kind === 'unauthorized')
        return {
          connected: true,
          error:
            'Remnawave запретила чтение профилей. Токен мог быть отозван либо ему не хватает прав чтения list/get для config-profiles и subscription-template.',
        };
      return {
        connected: true,
        error: err instanceof Error ? err.message : 'Не удалось прочитать профили Remnawave.',
      };
    }
  }

  async status(): Promise<RemnawaveStatus> {
    const domain = await this.store.domain();
    if (!domain)
      return {
        connected: false,
        domain: null,
        checkedAt: null,
        lastAttemptAt: null,
        error: null,
        stats: null,
        nodes: [],
        cert: null,
        vpnProbeConfigured: false,
        vpnProbeRoutes: null,
        vpnProbeRouteDetails: [],
      };
    const snap = await this.store.snapshot();
    const vpnProbe = await this.vpnProbe.status();
    return {
      connected: true,
      domain,
      checkedAt: snap?.checkedAt ?? null,
      lastAttemptAt: snap?.lastAttemptAt ?? snap?.checkedAt ?? null,
      error: snap?.error ?? null,
      stats: snap?.stats ?? null,
      nodes: snap?.nodes ?? [],
      cert: snap?.cert ?? null,
      vpnProbeConfigured: vpnProbe.configured,
      vpnProbeRoutes: vpnProbe.routes,
      vpnProbeRouteDetails: vpnProbe.routeDetails,
    };
  }

  /** Первое подключение: проверяем домен и токен по-настоящему, сохраняем только при успехе. */
  async connect(req: RemnawaveConnectRequest): Promise<RemnawaveStatus> {
    const { domain, apiKey } = req;
    const { stats, nodes } = await this.fetchOrThrow(domain, apiKey);
    const cert = await this.client.checkCertificate(domain);
    const checkedAt = new Date().toISOString();
    await this.store.connect(domain, apiKey, {
      checkedAt,
      lastAttemptAt: checkedAt,
      failureSince: null,
      outageNotified: false,
      error: null,
      stats,
      nodes,
      cert,
    });
    await this.audit.record({
      action: 'remnawave.connected',
      target: { type: 'settings', id: 'remnawave', display: domain },
      metadata: { domain, nodes: nodes.length, users: stats.users.total },
    });
    return this.status();
  }

  /** Кнопка «Обновить»: свежие данные по уже сохранённому домену и токену. */
  async refresh(): Promise<RemnawaveStatus> {
    const creds = await this.store.credentials();
    if (!creds)
      throw problem(HttpStatus.CONFLICT, {
        type: REMNAWAVE_PROBLEM.notConnected,
        detail: 'Remnawave не подключена.',
      });
    await this.sync(creds.domain, creds.apiKey);
    return this.status();
  }

  async disconnect(): Promise<void> {
    const domain = await this.store.domain();
    await this.store.disconnect();
    if (domain)
      await this.audit.record({
        action: 'remnawave.disconnected',
        target: { type: 'settings', id: 'remnawave', display: domain },
      });
  }

  /** Плановая перепроверка (джоба): тихо пишет ошибку в снимок, не роняет и не шумит в Журнале на каждый тик. */
  async syncQuiet(): Promise<void> {
    const creds = await this.store.credentials();
    if (!creds) return;
    const before = await this.store.snapshot();
    const wasOk = before ? !before.error : true;
    try {
      await this.sync(creds.domain, creds.apiKey);
    } catch (err) {
      const message = errorText(err);
      const attemptedAt = new Date().toISOString();
      const failureSince = before?.failureSince ?? attemptedAt;
      const shouldNotify =
        !before?.outageNotified && Date.parse(attemptedAt) - Date.parse(failureSince) >= 5 * 60_000;
      await this.store.updateSnapshot({
        checkedAt: before?.checkedAt ?? attemptedAt,
        lastAttemptAt: attemptedAt,
        failureSince,
        outageNotified: before?.outageNotified || shouldNotify,
        error: message,
        stats: before?.stats ?? null,
        nodes: before?.nodes ?? [],
        cert: before?.cert ?? null,
      });
      if (wasOk)
        await this.audit.record({
          action: 'remnawave.unreachable',
          severity: 'warn',
          target: { type: 'settings', id: 'remnawave', display: creds.domain },
          metadata: { error: message },
        });
      if (shouldNotify)
        await this.notifications
          .push({
            severity: 'warn',
            title: 'Remnawave не отвечает',
            body: `Больше пяти минут панель не может прочитать ${creds.domain}. Онлайн нод и резкие падения сейчас не отслеживаются. Причина: ${message}`,
            center: true,
            link: { to: '/servers/remnawave', label: 'Открыть Remnawave' },
            telegram: { event: 'panel_health' },
          })
          .catch((notifyErr) =>
            this.log.warn(`Оповещение о Remnawave не отправлено: ${errorText(notifyErr)}`),
          );
      this.log.warn(`Remnawave (${creds.domain}) недоступна: ${message}`);
      return;
    }
    if (!wasOk) {
      await this.audit.record({
        action: 'remnawave.reconnected',
        target: { type: 'settings', id: 'remnawave', display: creds.domain },
      });
      if (before?.outageNotified)
        await this.notifications
          .push({
            severity: 'ok',
            title: 'Remnawave снова отвечает',
            body: `Связь с ${creds.domain} восстановлена. Онлайн нод и падения снова отслеживаются по свежим данным.`,
            center: true,
            link: { to: '/servers/remnawave', label: 'Открыть Remnawave' },
            telegram: { event: 'panel_health' },
          })
          .catch((notifyErr) =>
            this.log.warn(`Оповещение о восстановлении Remnawave не отправлено: ${errorText(notifyErr)}`),
          );
    }
  }

  private async sync(domain: string, apiKey: string): Promise<void> {
    const { stats, nodes } = await this.fetchOrThrow(domain, apiKey);
    // Онлайн нод читаем раз в минуту, а сертификат — раз в полчаса: он меняется раз в месяцы.
    const before = await this.store.snapshot();
    const fresh = Date.now() - this.certCheckedAt < REMNAWAVE_CERT_CHECK_INTERVAL_MIN * 60_000;
    const cert = fresh && before?.cert ? before.cert : await this.client.checkCertificate(domain);
    if (!fresh || !before?.cert) this.certCheckedAt = Date.now();
    const checkedAt = new Date().toISOString();
    await this.store.updateSnapshot({
      checkedAt,
      lastAttemptAt: checkedAt,
      failureSince: null,
      outageNotified: false,
      error: null,
      stats,
      nodes,
      cert,
    });
    void this.recordOnline(nodes);
  }

  private async fetchOrThrow(domain: string, apiKey: string) {
    try {
      return await this.client.fetch(domain, apiKey);
    } catch (err) {
      if (err instanceof RemnawaveApiError) {
        if (err.kind === 'unauthorized')
          throw problem(HttpStatus.BAD_REQUEST, {
            type: REMNAWAVE_PROBLEM.unauthorized,
            detail: err.message,
          });
        throw problem(HttpStatus.BAD_GATEWAY, {
          type: REMNAWAVE_PROBLEM.domainUnreachable,
          detail: err.message,
        });
      }
      throw err;
    }
  }
}
